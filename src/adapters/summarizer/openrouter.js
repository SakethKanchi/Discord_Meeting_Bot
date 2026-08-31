import { parseGeminiNotes } from './gemini.js';
import { SUMMARY_PROMPT } from './notes.js';
import { summaryLanguageInstruction } from './languages.js';
import { httpError, withRetry } from './errors.js';
import { config } from '../../config/env.js';

// OpenRouter is an OpenAI-compatible gateway to many vendors' models
// (https://openrouter.ai/api/v1 — /models, /chat/completions), authed with
// OPENROUTER_API_KEY. Model ids are vendor-namespaced (`vendor/model`, e.g.
// `openai/gpt-4o-mini`). Same chat/completions shape as OpenAISummarizer; kept
// a separate class so the missing-key message and retry/error labels name
// OpenRouter rather than OpenAI.
export class OpenRouterSummarizer {
  constructor(model, baseUrl = config.openrouter.baseUrl, apiKey = config.openrouter.apiKey, fetchImpl = fetch) {
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set in .env');
    this.model = model; this.baseUrl = baseUrl; this.apiKey = apiKey; this.fetchImpl = fetchImpl;
  }
  // Optional attribution headers — OpenRouter uses these for app rankings.
  headers() {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
      'HTTP-Referer': 'https://github.com/SakethKanchi/parley',
      'X-Title': 'Parley',
    };
  }
  async summarize(transcript, meta) {
    const prompt = `${SUMMARY_PROMPT}${summaryLanguageInstruction(meta.summaryLanguage)}\n\nAttendees: ${(meta.attendees || []).join(', ')}\n\nTranscript:\n${transcript}`;
    const body = await withRetry(async () => {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) throw httpError('OpenRouter', res.status, await res.text().catch(() => ''));
      return res.json();
    });
    return parseGeminiNotes(body.choices?.[0]?.message?.content ?? '');
  }
  async ask(prompt) {
    const body = await withRetry(async () => {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) throw httpError('OpenRouter', res.status, await res.text().catch(() => ''));
      return res.json();
    });
    return body.choices?.[0]?.message?.content ?? '';
  }
}
