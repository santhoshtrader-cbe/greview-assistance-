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

  const { feedback, businessName, rating } = body ?? {};
  if (!feedback || !feedback.trim()) {
    sendJson(response, 400, { error: "Feedback text is required." });
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

    sendJson(response, 200, { text });
  } catch (error) {
    sendJson(response, 500, { error: error?.message || "Server error" });
  }
}
