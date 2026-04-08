// Gemini API caller with Google Search grounding (mirrors callAI in index.html)

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/';

const MODELS = [
  { m: 'gemini-2.5-flash',               v: 'v1beta', search: true  },
  { m: 'gemini-2.5-flash-preview-05-20', v: 'v1beta', search: true  },
  { m: 'gemini-2.0-flash',               v: 'v1beta', search: true  },
  { m: 'gemini-2.0-flash-lite',          v: 'v1beta', search: true  },
  { m: 'gemini-1.5-flash-latest',        v: 'v1beta', search: false },
];

/**
 * Call Gemini AI with Google Search grounding for live news.
 * @param {string} prompt
 * @returns {string} raw text response
 */
export async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY env var not set');

  let lastErr = null;

  for (const { m, v, search } of MODELS) {
    try {
      const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.6, maxOutputTokens: 4096 },
      };
      if (search) body.tools = [{ google_search: {} }];

      const res = await fetch(`${GEMINI_BASE}${v}/models/${m}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (data.error) {
        const msg = data.error.message || '';
        if (data.error.code === 429 || /quota|rate.?limit|not found|not support/i.test(msg)) {
          lastErr = new Error(msg);
          continue;
        }
        throw new Error(`Gemini error: ${msg}`);
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!text) { lastErr = new Error('Empty response'); continue; }
      return text;

    } catch (e) {
      lastErr = e;
      if (!/quota|rate.?limit|not found|not support|429/i.test(e.message)) throw e;
    }
  }

  throw lastErr || new Error('All Gemini models failed');
}

/**
 * Parse JSON from Gemini text response (handles markdown fences).
 * @param {string} text
 * @returns {object|null}
 */
export function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text.trim()); } catch (_) {}
  const stripped = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(stripped); } catch (_) {}
  // Extract first {...} block
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) {}
  }
  return null;
}
