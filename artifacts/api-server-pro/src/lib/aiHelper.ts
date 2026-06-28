import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

function cleanJson(text: string) {
  return text.replace(/```json/g, "").replace(/```/g, "").trim();
}

export async function getAiClipSuggestion(transcript: string) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
  You are an expert short-form video editor.
  Read this transcript and find the most viral, hook-worthy segment.
  Return ONLY a valid JSON object in this exact format, with no extra text or formatting:
  {
    "inTime": "00:00:00",
    "outTime": "00:00:15",
    "headline": "A catchy 4-word title"
  }

  Transcript:
  ${transcript}
  `;

  const result = await model.generateContent(prompt);
  return JSON.parse(cleanJson(result.response.text()));
}

export async function suggestTitleFromTranscript(transcript: string): Promise<{ headline: string }> {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `You are a viral short-form video editor. Based on this transcript from a video clip, suggest one punchy, attention-grabbing headline (4–7 words max) that captures the core moment and would stop someone mid-scroll.

Return ONLY a valid JSON object with no extra text:
{"headline": "Your catchy title here"}

Transcript:
${transcript}`;

  const result = await model.generateContent(prompt);
  const parsed = JSON.parse(cleanJson(result.response.text()));
  return { headline: String(parsed.headline ?? parsed.title ?? "") };
}
