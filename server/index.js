import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { COMPANY_KNOWLEDGE_BASE, COMPANY_NAME } from "./companyKnowledgeBase.js";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "../.env");

dotenv.config({ path: envPath });

const port = process.env.PORT || 3001;
const distPath = path.resolve(__dirname, "../dist");

const API_VERSIONS = ["v1", "v1beta"];
let resolvedModelId = null;
let resolvedApiVersion = null;

app.use(cors());
app.use(express.json());

function requireApiKey(response) {
  if (process.env.GEMINI_API_KEY) {
    return false;
  }

  response.status(500).json({
    error: "Gemini API key is missing. Add GEMINI_API_KEY to your .env file."
  });
  return true;
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

function buildCompanyGroundingPrompt({ businessName, rating }) {
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

async function callGemini(prompt) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    throw new Error("Gemini API key is missing. Add GEMINI_API_KEY to your .env file.");
  }

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
      throw error;
    }
  }

  const discovered = await discoverSupportedModel(geminiApiKey);
  if (!discovered) {
    throw new Error(
      "No Gemini models supporting generateContent were found for this API key. " +
        "Try creating a new key or check that the Generative Language API is enabled."
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

function normalizeModelId(value) {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("models/")) {
    return trimmed.slice("models/".length);
  }

  return trimmed;
}

function isModelNotFoundError(message) {
  const haystack = (message || "").toLowerCase();
  return (
    haystack.includes("is not found for api version") ||
    haystack.includes("not supported for generatecontent") ||
    haystack.includes("model is not found")
  );
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
    throw new Error(payload.error?.message || "Gemini request failed.");
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

async function discoverSupportedModel(apiKey) {
  for (const apiVersion of API_VERSIONS) {
    const models = await listModels({ apiVersion, apiKey });
    if (!models.length) {
      continue;
    }

    const pick = pickBestModelId(models);
    if (pick) {
      return { apiVersion, modelId: pick };
    }
  }

  return null;
}

async function listModels({ apiVersion, apiKey }) {
  const url = `https://generativelanguage.googleapis.com/${apiVersion}/models?key=${apiKey}`;
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return [];
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

app.post("/api/review-assist", async (request, response) => {
  if (requireApiKey(response)) {
    return;
  }

  const { businessName, rating, draft } = request.body ?? {};
  if (!businessName || typeof rating !== "number") {
    response.status(400).json({ error: "Business name and rating are required." });
    return;
  }

  try {
      const kbContext = buildCompanyGroundingPrompt({ businessName, rating });
    const prompt = draft?.trim()
    ? `${kbContext}
  A customer already wrote this review for ${businessName}:
  ${draft}

  Rewrite it in simple, natural, everyday English.
  Keep the same meaning.
  Keep it short.
  Make it feel human and personal.
  If the business is ${COMPANY_NAME}, keep wording consistent with the knowledge base.
  No quotes. No bullet points.`
    : `${kbContext}
  Write one short, natural ${rating}-star customer review for ${businessName}.
  Keep it between 12 and 30 words.
  Use plain, basic wording that feels like a normal customer wrote it.
  No quotes. No bullet points. No marketing phrases.`;

    const text = await callGemini(prompt);
    response.json({ text });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/improve-feedback", async (request, response) => {
  if (requireApiKey(response)) {
    return;
  }

  const { feedback, businessName, rating } = request.body ?? {};
  if (!feedback || !feedback.trim()) {
    response.status(400).json({ error: "Feedback text is required." });
    return;
  }

  try {
    const kbContext = buildCompanyGroundingPrompt({ businessName, rating });
    const text = await callGemini(
      `${kbContext}
Rewrite this feedback in a polite, constructive way.
Keep the meaning same.
Use very simple English.
Keep it short and respectful.
Do not make it formal or corporate.
Original feedback: ${feedback}`
    );
    response.json({ text });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.use(express.static(distPath));

app.get("*", (request, response) => {
  response.sendFile(path.join(distPath, "index.html"));
});

app.listen(port, () => {
  console.log(`Review Assistant API listening on http://localhost:${port}`);
});
