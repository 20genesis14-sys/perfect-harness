// Provider/route → USD pricing. Pure lookup, no I/O: the substrate injects a
// price book, evidence computes costUsd from the REAL token split it observed.
//
// Units: USD per 1M tokens. Rates below were read from
// https://openrouter.ai/api/v1/models on 2025-10-23 — the live route's entry
// (deepseek/deepseek-v4.1-flash-1017) also carries time-windowed overrides
// (half price off-peak); this table holds the BASE rate only, so costUsd is
// an upper-bound estimate, never exact billing.

export const DEFAULT_PRICE_BOOK = {
  // '<provider>/<model>' — provider prefix avoids cross-provider collisions.
  'openrouter/deepseek/deepseek-v4.1-flash-1017': { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 },
  'openrouter/deepseek/deepseek-v4.1-flash': { input: 0.165, output: 0.66, cacheRead: 0.006, cacheWrite: 0.165 },
  'openrouter/deepseek/deepseek-v4-pro': { input: 0.95526, output: 1.91052, cacheRead: 0.079605, cacheWrite: 0.95526 },
}

const isObj = (v) => v !== null && typeof v === 'object'

/** Resolve {input,output,cacheRead,cacheWrite} USD-per-Mtok for a route.
 * Lookup order: `provider/model`, then bare `model` — a provider-qualified
 * key always wins. Returns null when unpriced (costUsd stays 0 = unknown,
 * never guessed). */
export function priceFor(book, provider, model) {
  if (!isObj(book) || !model) return null
  return book[`${provider}/${model}`] ?? book[model] ?? null
}

/** usage: {inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens} → USD. */
export function costOf(usage, price) {
  if (!isObj(usage) || !isObj(price)) return 0
  const per = (v, rate) => ((typeof v === 'number' && Number.isFinite(v) ? v : 0) / 1e6) * (typeof rate === 'number' ? rate : 0)
  return +(per(usage.inputTokens, price.input) +
    per(usage.outputTokens, price.output) +
    per(usage.cacheReadTokens, price.cacheRead) +
    per(usage.cacheWriteTokens, price.cacheWrite)).toFixed(8)
}
