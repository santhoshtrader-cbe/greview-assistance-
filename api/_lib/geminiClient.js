import { COMPANY_KNOWLEDGE_BASE, COMPANY_NAME } from "../../server/companyKnowledgeBase.js";

const API_VERSIONS = ["v1", "v1beta"];
let resolvedModelId = null;
let resolvedApiVersion = null;

function normalizeGeminiErrorMessage(message) {
  return (message || "").toString().trim();
}

function isLeakedApiKeyError(message) {
  const haystack = normalizeGeminiErrorMessage(message).toLowerCase();
  return haystack.includes("reported as leaked");
}

function isApiNotEnabledError(message) {
  const haystack = normalizeGeminiErrorMessage(message).toLowerCase();
  return (
    haystack.includes("generative language api") &&
    (haystack.includes("not enabled") || haystack.includes("enable"))
  );
}

function isInvalidApiKeyError(message) {
  const haystack = normalizeGeminiErrorMessage(message).toLowerCase();
  return haystack.includes("api key not valid") || haystack.includes("invalid api key");
}

function decorateGeminiError(error) {
  const rawMessage = normalizeGeminiErrorMessage(error?.message || String(error));
  if (!rawMessage) {
    return error;
  }

  if (isLeakedApiKeyError(rawMessage)) {
    return new Error(
      "Gemini API key was disabled (reported as leaked). " +
        "Create a new key and set it only as GEMINI_API_KEY in your server/Vercel environment variables (do not put it in client code)."
    );
  }

  if (isApiNotEnabledError(rawMessage)) {
    return new Error(
      "Generative Language API is not enabled for this project/key. " +
        "Enable the API for your Google Cloud/AI Studio project, then try again."
    );
  }

  if (isInvalidApiKeyError(rawMessage)) {
    return new Error(
      "Gemini API key looks invalid or restricted. " +
        "Verify GEMINI_API_KEY and ensure it has access to the Generative Language API."
    );
  }

  return error;
}

const localeStyleGuide = `
You are writing for customers in Tamil Nadu who often deal with small and medium local businesses.
Use very simple Indian English.
Keep the tone natural, short, and everyday.
Sound like a real person with low English fluency wrote it.
Small grammar imperfections are okay, but it must stay easy to understand.
Do not use polished marketing language, exaggerated praise, corporate wording, or fancy vocabulary.
Do not use emojis, hashtags, repeated templates, or wording that sounds obviously AI-generated.
Make each response a little different in wording and sentence flow.
Keep it believable and personal.
`;

export function requireGeminiApiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("Gemini API key is missing. Set GEMINI_API_KEY in your deployment environment variables.");
  }
  return key;
}

function normalizeModelId(value) {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("models/") ? trimmed.slice("models/".length) : trimmed;
}

function isModelNotFoundError(message) {
  const haystack = (message || "").toLowerCase();
  return (
    haystack.includes("is not found for api version") ||
    haystack.includes("not supported for generatecontent") ||
    haystack.includes("model is not found")
  );
}

function normalizeBusinessName(name) {
  return (name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function shouldUseCompanyKb(businessName) {
  const normalized = normalizeBusinessName(businessName);
  const companyNormalized = normalizeBusinessName(COMPANY_NAME);
  return normalized === companyNormalized || normalized.includes(companyNormalized);
}

function pickCustomerPersona(rating) {
  const positive = [
    "I run a small warehouse in Coimbatore and we pack parcels daily.",
    "I manage packing in a small manufacturing unit near Coimbatore.",
    "I handle dispatch for a logistics/transport office and we need bulk packing items."
  ];

  const negative = [
    "I manage packing work in a small warehouse.",
    "I buy packaging material for a small manufacturing unit.",
    "I handle dispatch work for a transport office."
  ];

  const list = rating >= 4 ? positive : negative;
  const index = Math.abs(Number(rating || 0)) % list.length;
  return list[index];
}

export function buildCompanyGroundingPrompt({ businessName, rating }) {
  if (!shouldUseCompanyKb(businessName)) {
    return "";
  }

  const persona = pickCustomerPersona(rating);
  return `
Company knowledge base (facts you can use):\n${COMPANY_KNOWLEDGE_BASE}\n
Write as a real customer persona: ${persona}
Important rules:
- Use ONLY the facts from the knowledge base above.
- Do NOT include address, phone, email, GSTIN in the review.
- Do NOT mention AI, Gemini, prompts, or that you used a knowledge base.
- Mention at most 1-2 relevant products/services (example: PP strapping roll, edge protector, packing tape, stretch film). Do not force it.
- Keep it short and human. No quotes. No bullet points.
`;
}

async function generateContent({ apiVersion, modelId, apiKey, text }) {
  const apiUrl = `https://generativelanguage.googleapis.com/${apiVersion}/models/${modelId}:generateContent?key=${apiKey}`;
  const apiResponse = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text }]
        }
      ]
    })
  });

  const payload = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) {
    const upstream = payload.error?.message || "Gemini request failed.";
    throw decorateGeminiError(new Error(upstream));
  }

  const outputText = payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  if (!outputText) {
    throw new Error("Gemini returned an empty response.");
  }

  return outputText;
}

async function listModels({ apiVersion, apiKey }) {
  const url = `https://generativelanguage.googleapis.com/${apiVersion}/models?key=${apiKey}`;
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const upstream = payload.error?.message || `Gemini listModels failed (HTTP ${response.status}).`;
    throw decorateGeminiError(new Error(upstream));
  }

  return Array.isArray(payload.models) ? payload.models : [];
}

function pickBestModelId(models) {
  const supported = models
    .filter((model) => Array.isArray(model.supportedGenerationMethods))
    .filter((model) => model.supportedGenerationMethods.includes("generateContent"))
    .map((model) => normalizeModelId(model.name || ""))
    .filter(Boolean);

  if (!supported.length) {
    return "";
  }

  const preferences = [
    (name) => name.includes("gemini") && name.includes("flash"),
    (name) => name.includes("gemini") && name.includes("1.5"),
    (name) => name.includes("gemini"),
    () => true
  ];

  for (const matches of preferences) {
    const match = supported.find((name) => matches(name.toLowerCase()));
    if (match) {
      return match;
    }
  }

  return supported[0];
}

async function discoverSupportedModel(apiKey) {
  let lastError = null;
  for (const apiVersion of API_VERSIONS) {
    try {
      const models = await listModels({ apiVersion, apiKey });
      if (!models.length) {
        continue;
      }

      const pick = pickBestModelId(models);
      if (pick) {
        return { apiVersion, modelId: pick };
      }
    } catch (error) {
      lastError = error;
      continue;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return null;
}

export async function callGemini(prompt) {
  const geminiApiKey = requireGeminiApiKey();
  const desiredModel = normalizeModelId(process.env.GEMINI_MODEL || "");
  const requestText = `${localeStyleGuide}\n${prompt}`;

  const attempts = [];
  if (resolvedModelId && resolvedApiVersion) {
    attempts.push({ apiVersion: resolvedApiVersion, modelId: resolvedModelId });
  }
  if (desiredModel) {
    attempts.push(...API_VERSIONS.map((apiVersion) => ({ apiVersion, modelId: desiredModel })));
  }

  for (const attempt of attempts) {
    try {
      const text = await generateContent({
        apiVersion: attempt.apiVersion,
        modelId: attempt.modelId,
        apiKey: geminiApiKey,
        text: requestText
      });

      resolvedApiVersion = attempt.apiVersion;
      resolvedModelId = attempt.modelId;
      return text;
    } catch (error) {
      const message = error?.message || String(error);
      if (isModelNotFoundError(message)) {
        continue;
      }
      throw decorateGeminiError(error);
    }
  }

  let discovered;
  try {
    discovered = await discoverSupportedModel(geminiApiKey);
  } catch (error) {
    throw decorateGeminiError(error);
  }
  if (!discovered) {
    throw new Error(
      "No Gemini models supporting generateContent were found for this API key. " +
        "Check that the Generative Language API is enabled for this key/project."
    );
  }

  resolvedApiVersion = discovered.apiVersion;
  resolvedModelId = discovered.modelId;

  return generateContent({
    apiVersion: resolvedApiVersion,
    modelId: resolvedModelId,
    apiKey: geminiApiKey,
    text: requestText
  });
}
