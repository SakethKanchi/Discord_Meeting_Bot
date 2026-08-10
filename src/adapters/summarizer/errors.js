// Shared error handling for summarizer adapters: pull an HTTP status off
// whatever shape the provider SDK throws, decide if it's worth retrying, turn
// it into a sentence a Discord user can act on, and a small retry wrapper.

// Server-side transient failures worth retrying. 429 is deliberately excluded:
// it usually means quota/credits exhausted, and the user should hear that
// immediately rather than after several silent retries.
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

export function statusOf(err) {
  return err?.status ?? err?.statusCode ?? err?.response?.status ?? null;
}

export function isRetryable(err) {
  return RETRYABLE_STATUS.has(statusOf(err));
}

// Build an Error carrying the HTTP status so describeSummarizerError can
// classify it, optionally with a snippet of the response body for context.
export function httpError(provider, status, bodyText = '') {
  const snippet = bodyText ? `: ${String(bodyText).slice(0, 200)}` : '';
  const err = new Error(`${provider} HTTP ${status}${snippet}`);
  err.status = status;
  return err;
}

// Map an error to a clear, user-facing reason. provider is the label shown to
// users (e.g. 'gemini').
export function describeSummarizerError(err, provider = 'the model') {
  const status = statusOf(err);
  const raw = (err?.message || String(err)).trim();
  switch (status) {
    case 401:
    case 403:
      return `Authentication failed (${status}). The ${provider} API key is invalid or lacks access — check the key in .env.${raw ? ` Provider said: ${raw}` : ''}`;
    case 429:
      return `Quota or rate limit hit (429) on ${provider}. You may be out of API credits, or requests are going too fast — check your provider's billing/quota.`;
    case 500:
    case 502:
    case 503:
    case 504:
      return `${provider} is temporarily overloaded (${status}). This is usually short-lived; it was retried but still failed — try again later.`;
    case 400:
      return `${provider} rejected the request (400)${raw ? `: ${raw}` : ''}.`;
    default:
      return raw || `Unknown error from ${provider}.`;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry fn on transient (5xx) failures with exponential backoff. Non-retryable
// errors (auth, quota, bad request) throw immediately so users hear the real
// reason fast. sleep is injectable for tests.
export async function withRetry(fn, { tries = 4, baseMs = 800, sleep = defaultSleep } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === tries || !isRetryable(err)) throw err;
      await sleep(baseMs * 2 ** (attempt - 1));
    }
  }
  throw lastErr;
}
