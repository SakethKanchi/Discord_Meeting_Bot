// Composite summarizer: try the configured primary, and on failure fall through
// to a secondary provider. Exists because a single provider outage otherwise
// loses a whole meeting even though the transcript is intact — a 90-minute
// recording should not be forfeited to one provider's monthly spend cap, a
// gateway 500, or a region block.
//
// The fallback adapter is built lazily, inside the catch, so a fallback whose
// API key is missing can never break the primary path at construction time.
import { describeSummarizerError } from './errors.js';

export class FallbackSummarizer {
  constructor(primary, makeFallback, { label, fallbackLabel, log = console } = {}) {
    this.primary = primary;
    this.makeFallback = makeFallback;
    this.label = label;
    this.fallbackLabel = fallbackLabel;
    this.log = log;
    // "provider:model" that actually produced the last result, so callers record
    // the model that really ran rather than the one that was configured.
    this.lastUsed = label;
  }

  async #run(method, args) {
    try {
      const out = await this.primary[method](...args);
      this.lastUsed = this.label;
      return out;
    } catch (primaryErr) {
      let fallback;
      try {
        fallback = this.makeFallback();
      } catch (buildErr) {
        // Fallback is unusable (typically a missing key). The primary failure is
        // the actionable one, so surface that and say why recovery was impossible.
        primaryErr.userMessage = `${describeSummarizerError(primaryErr, this.label)} Fallback ${this.fallbackLabel} is unavailable: ${buildErr.message}`;
        throw primaryErr;
      }
      this.log.warn?.(`[summarizer] ${this.label} failed (${primaryErr.message}) — falling back to ${this.fallbackLabel}`);
      try {
        const out = await fallback[method](...args);
        this.lastUsed = this.fallbackLabel;
        return out;
      } catch (fallbackErr) {
        fallbackErr.primaryError = primaryErr;
        fallbackErr.userMessage = `Both summarizers failed. ${this.label} — ${describeSummarizerError(primaryErr, this.label)} Then ${this.fallbackLabel} — ${describeSummarizerError(fallbackErr, this.fallbackLabel)}`;
        throw fallbackErr;
      }
    }
  }

  summarize(transcript, meta) { return this.#run('summarize', [transcript, meta]); }
  ask(prompt) { return this.#run('ask', [prompt]); }
}
