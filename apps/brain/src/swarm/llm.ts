/**
 * Gemini access for the swarm agents. One client (v1beta: @google/genai 3.x defaults to v1, where
 * Live answers 404 and JSON schemas are limited). `llmJson` = one structured text call with a
 * timeout; every agent must have a non-LLM fallback for when it fails (no key, quota, timeout).
 */
import { GoogleGenAI } from "@google/genai";

export interface SwarmModels {
  /** null = no key (fake JJ): agents use their fallbacks. */
  apiKey: string | null;
  /** Fast structured calls (director decisions). */
  text: string;
  /** Longer writing (reporter). */
  report: string;
  /** Live audio listener (transcript + fillers through a tool call). */
  listener: string;
  /** Video understanding (body agent, after a run). */
  video: string;
}

let client: { key: string; ai: GoogleGenAI } | null = null;
export function gemini(key: string): GoogleGenAI {
  if (!client || client.key !== key) client = { key, ai: new GoogleGenAI({ apiKey: key, httpOptions: { apiVersion: "v1beta" } }) };
  return client.ai;
}

export class LlmError extends Error {}

/** One JSON answer from a text model. `schema` is a JSON Schema object. Rejects with LlmError. */
export async function llmJson<T>(o: {
  apiKey: string | null; model: string; system: string; prompt: string; schema: Record<string, unknown>;
  timeoutMs?: number; thinking?: boolean;
}): Promise<T> {
  if (!o.apiKey) throw new LlmError("no GEMINI_API_KEY");
  const call = gemini(o.apiKey).models.generateContent({
    model: o.model, contents: o.prompt,
    config: {
      systemInstruction: o.system, responseMimeType: "application/json", responseJsonSchema: o.schema,
      ...(o.thinking ? {} : { thinkingConfig: { thinkingBudget: 0 } }),
    },
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new LlmError(`timeout after ${o.timeoutMs ?? 8000} ms`)), o.timeoutMs ?? 8000); });
  try {
    const r = await Promise.race([call, timeout]);
    const text = r.text ?? "";
    try { return JSON.parse(text) as T; } catch { throw new LlmError(`not JSON: ${text.slice(0, 200)}`); }
  } catch (err) {
    throw err instanceof LlmError ? err : new LlmError(String(err));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
