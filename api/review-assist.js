import { readJson, sendJson } from "./_lib/http.js";
import { buildCompanyGroundingPrompt, callGemini } from "./_lib/geminiClient.js";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  let body;
  try {
    body = await readJson(request);
  } catch {
    sendJson(response, 400, { error: "Invalid JSON body" });
    return;
  }

  const { businessName, rating, draft } = body ?? {};
  if (!businessName || typeof rating !== "number") {
    sendJson(response, 400, { error: "Business name and rating are required." });
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
No quotes. No bullet points.`
      : `${kbContext}
Write one short, natural ${rating}-star customer review for ${businessName}.
Keep it between 12 and 30 words.
Use plain, basic wording that feels like a normal customer wrote it.
No quotes. No bullet points. No marketing phrases.`;

    const text = await callGemini(prompt);
    sendJson(response, 200, { text });
  } catch (error) {
    sendJson(response, 500, { error: error?.message || "Server error" });
  }
}
