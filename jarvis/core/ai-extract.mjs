// Provider-agnostic AI extraction client. Plain fetch, no SDKs.
// Chain: HOUSEWATCH_AI_PROVIDERS (default "gemini,groq,openrouter"); paid providers are
// used only when listed explicitly. Every provider/model pair ("target") has a
// daily request cap, an optional daily token cap and RPM pacing, persisted in
// the store so they hold across collector runs.
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AI_SCHEMA, AI_SCHEMA_NAME, AI_SCHEMA_VERSION, enforceEvidence, validateExtraction } from './ai-schema.mjs';
import { PROMPT_VERSION, buildMessages } from './ai-prompt.mjs';
import { normalizeText, redactForModel } from './ai-redact.mjs';

export const SCHEMA_TAG = `schema${AI_SCHEMA_VERSION}.prompt${PROMPT_VERSION}`;
export const CACHE_PREFIX = 'ai.cache.';
export const USAGE_PREFIX = 'ai.usage.';
const MAX_BACKOFF_MS = 30_000;

/**
 * Free-tier limits are unofficial and change; the defaults sit below them.
 * rpd = requests per day, tpd = tokens per day (null = not tracked).
 */
export const PROVIDERS = Object.freeze({
  gemini: {
    api: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY',
    models: ['gemini-3.1-flash-lite'], rpm: 12, rpd: 400, tpd: null, paid: false, maxTokens: 2048, tokenParam: 'max_tokens',
  },
  groq: {
    api: 'openai', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY',
    models: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'], rpm: 25, rpd: 500, tpd: 180_000, paid: false,
    maxTokens: 4096, tokenParam: 'max_completion_tokens',
    modelOptions: { 'openai/gpt-oss-120b': { extraBody: { reasoning_effort: 'low' } } },
  },
  // OpenRouter free models (":free"). Account-wide limits: 20 RPM and 50 requests/day, or
  // 1,000/day after a one-time purchase of ≥$10 credits (raise HOUSEWATCH_AI_OPENROUTER_RPD).
  // Only models listing `structured_outputs` in /api/v1/models are used; `require_parameters`
  // makes OpenRouter route only to endpoints that honour the JSON schema. The free list churns:
  // override with HOUSEWATCH_AI_OPENROUTER_MODELS.
  openrouter: {
    api: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY',
    models: ['nvidia/nemotron-3.5-super-vl:free', 'inclusionai/ling-3.2-flash:free', 'baidu/ernie-5.5-flash-preview:free'],
    // Per model; three models × 15 stays under the shared 50/day free cap.
    rpm: 6, rpd: 15, tpd: null, paid: false, maxTokens: 2048, tokenParam: 'max_tokens',
    extraBody: { provider: { require_parameters: true } },
  },
  openai: {
    api: 'openai', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY',
    models: ['gpt-5-nano'], rpm: 30, rpd: 400, tpd: null, paid: true, maxTokens: 4096, tokenParam: 'max_completion_tokens',
    // GPT-5 models only accept the default temperature.
    temperature: false, extraBody: { reasoning_effort: 'minimal' },
  },
  anthropic: {
    api: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY',
    models: ['claude-haiku-5-5'], rpm: 30, rpd: 400, tpd: null, paid: true, maxTokens: 2048,
  },
});

function positiveInt(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a nonnegative integer.`);
  return Number(value);
}

/** Resolve the provider chain from the environment. Targets without a key are skipped. */
export function aiTargets(env = process.env) {
  const ids = String(env.HOUSEWATCH_AI_PROVIDERS ?? 'gemini,groq,openrouter').split(',').map((id) => id.trim().toLowerCase()).filter(Boolean);
  const targets = [];
  for (const id of new Set(ids)) {
    const provider = PROVIDERS[id];
    if (!provider) throw new Error(`Unknown AI provider "${id}". Use ${Object.keys(PROVIDERS).join(', ')}.`);
    if (!env[provider.keyEnv]) continue;
    const upper = id.toUpperCase();
    const models = env[`HOUSEWATCH_AI_${upper}_MODELS`]?.split(',').map((m) => m.trim()).filter(Boolean) ?? provider.models;
    for (const model of models) {
      targets.push({
        ...provider, ...(provider.modelOptions?.[model] ?? {}), modelOptions: undefined, models: undefined,
        id: `${id}:${model}`, provider: id, model,
        rpm: positiveInt(env, `HOUSEWATCH_AI_${upper}_RPM`, provider.rpm),
        rpd: positiveInt(env, `HOUSEWATCH_AI_${upper}_RPD`, provider.rpd),
        tpd: provider.tpd === null ? null : positiveInt(env, `HOUSEWATCH_AI_${upper}_TPD`, provider.tpd),
      });
    }
  }
  return targets;
}

export function aiDailyBudget(env = process.env) {
  return positiveInt(env, 'HOUSEWATCH_AI_DAILY_BUDGET', 300);
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export function cacheKey(normalizedText, model) {
  return sha256(`${normalizedText}\n${SCHEMA_TAG}\n${model}`);
}

function retryAfterMs(headers, now) {
  const value = headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** Groq-style reset durations: "2m59.56s", "7.66s", "250ms". */
export function parseDuration(value) {
  if (!value) return null;
  let total = 0;
  let matched = false;
  for (const [, amount, unit] of String(value).matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    total += Number(amount) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
  }
  return matched ? total : null;
}

function requestBody(target, messages) {
  if (target.api === 'anthropic') {
    const [system, ...rest] = messages;
    return {
      model: target.model, max_tokens: target.maxTokens, temperature: 0, system: system.content, messages: rest,
      output_config: { format: { type: 'json_schema', schema: AI_SCHEMA } }, thinking: { type: 'disabled' },
    };
  }
  return {
    model: target.model, messages,
    response_format: { type: 'json_schema', json_schema: { name: AI_SCHEMA_NAME, strict: true, schema: AI_SCHEMA } },
    ...(target.temperature === false ? {} : { temperature: 0 }),
    [target.tokenParam ?? 'max_tokens']: target.maxTokens,
    ...(target.extraBody ?? {}),
  };
}

function requestInit(target, key, body) {
  const headers = { 'content-type': 'application/json' };
  if (target.api === 'anthropic') Object.assign(headers, { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
  else headers.authorization = `Bearer ${key}`;
  return { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(45_000) };
}

function readResponse(target, data) {
  if (target.api === 'anthropic') {
    const text = (data?.content ?? []).filter((part) => part?.type === 'text').map((part) => part.text).join('');
    const usage = (data?.usage?.input_tokens ?? 0) + (data?.usage?.output_tokens ?? 0);
    return { text, truncated: data?.stop_reason === 'max_tokens', refused: data?.stop_reason === 'refusal', tokens: usage };
  }
  const choice = data?.choices?.[0];
  return {
    text: choice?.message?.content ?? '', truncated: choice?.finish_reason === 'length',
    refused: !!choice?.message?.refusal, tokens: data?.usage?.total_tokens ?? 0,
  };
}

/**
 * Create an extractor bound to a store. Everything with side effects is
 * injectable so the tests run offline with a mocked fetch and a fake clock.
 */
export function createAiExtractor({
  store, env = process.env, fetcher = fetch, now = Date.now, sleep = (ms) => delay(ms),
  random = Math.random, log = (message) => console.warn(message), maxAttempts = 3,
} = {}) {
  const targets = aiTargets(env);
  const dailyBudget = aiDailyBudget(env);
  const disabled = new Set();
  const day = () => new Date(now()).toISOString().slice(0, 10);

  async function usage(id) {
    const state = await store.getConfig(USAGE_PREFIX + id, null);
    return state?.day === day() ? state : { day: day(), requests: 0, tokens: 0, cooldownUntil: state?.cooldownUntil ?? 0, lastCallAt: state?.lastCallAt ?? 0, strikes: 0 };
  }
  const save = (id, state) => store.setConfig(USAGE_PREFIX + id, state);

  function backoff(attempt, hint) {
    const jittered = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt) * (0.5 + random());
    return Math.min(MAX_BACKOFF_MS, Math.max(jittered, hint ?? 0));
  }

  async function call(target, messages) {
    const key = env[target.keyEnv];
    let response;
    try {
      response = await fetcher(`${target.baseUrl}/${target.api === 'anthropic' ? 'messages' : 'chat/completions'}`,
        requestInit(target, key, requestBody(target, messages)));
    } catch (error) {
      return { ok: false, kind: error?.name === 'TimeoutError' ? 'timeout' : 'network' };
    }
    const at = now();
    if (!response.ok) {
      await response.body?.cancel?.();
      const status = response.status;
      const kind = status === 429 ? 'rate' : status >= 500 ? 'server' : [401, 403].includes(status) ? 'auth' : 'client';
      return { ok: false, kind, status, retryAfter: retryAfterMs(response.headers, at) };
    }
    let data;
    try { data = await response.json(); } catch { return { ok: false, kind: 'schema', error: 'The provider response is not JSON.' }; }
    const read = readResponse(target, data);
    const header = (name) => response.headers?.get?.(name) ?? null;
    let cooldown = 0;
    // Groq reports what is left of the per-minute/day windows; stop before a 429.
    if (header('x-ratelimit-remaining-requests') === '0') cooldown = parseDuration(header('x-ratelimit-reset-requests')) ?? 60_000;
    if (header('x-ratelimit-remaining-tokens') !== null && Number(header('x-ratelimit-remaining-tokens')) < 3000) {
      cooldown = Math.max(cooldown, parseDuration(header('x-ratelimit-reset-tokens')) ?? 60_000);
    }
    if (read.refused || read.truncated) return { ok: false, kind: 'schema', tokens: read.tokens, cooldown, error: read.refused ? 'The model refused.' : 'The output was truncated.' };
    return { ok: true, text: read.text, tokens: read.tokens, cooldown };
  }

  /**
   * Extract terms from one ad. Returns
   * { status: 'ok', provider, model, cached, fields, dropped, redaction, textHash } or
   * { status: 'disabled' | 'empty' | 'budget' | 'failed', reason }.
   */
  async function extract(text, { names = [] } = {}) {
    if (!targets.length) return { status: 'disabled', reason: 'No AI provider key is configured.' };
    // Redaction also trims tokens; HOUSEWATCH_AI_REDACT=0 sends the ad as-is.
    const redacted = env.HOUSEWATCH_AI_REDACT === '0'
      ? { text: normalizeText(String(text ?? '')), counts: {}, truncated: false }
      : redactForModel(text, { names });
    const normalized = normalizeText(redacted.text);
    if (normalized.length < 20) return { status: 'empty', reason: 'The ad text is too short.' };
    const textHash = sha256(normalized);
    const redaction = { counts: redacted.counts, truncated: redacted.truncated };
    for (const target of targets) {
      const hit = await store.getConfig(CACHE_PREFIX + cacheKey(normalized, target.model), null);
      if (hit?.fields) {
        const checked = enforceEvidence(hit.fields, redacted.text);
        return { status: 'ok', provider: target.provider, model: target.model, cached: true, fields: checked.fields, dropped: [...(hit.dropped ?? []), ...checked.dropped], redaction, textHash };
      }
    }
    const total = await usage('total');
    if (total.requests >= dailyBudget) return { status: 'budget', reason: 'The daily AI budget is spent.' };

    const messages = buildMessages(redacted.text);
    let attempted = false;
    const failures = [];
    for (const target of targets) {
      if (disabled.has(target.id)) continue;
      const state = await usage(target.id);
      if (state.cooldownUntil > now() || state.requests >= target.rpd || (target.tpd !== null && state.tokens >= target.tpd)) continue;
      let rateHits = 0;
      let schemaFails = 0;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const totals = await usage('total');
        if (totals.requests >= dailyBudget || state.requests >= target.rpd || state.cooldownUntil > now()) break;
        const wait = state.lastCallAt + Math.ceil(60_000 / Math.max(1, target.rpm)) - now();
        if (wait > 0) await sleep(wait);
        attempted = true;
        state.requests++;
        state.lastCallAt = now();
        totals.requests++;
        await save(target.id, state);
        await save('total', totals);
        const result = await call(target, messages);
        if (result.tokens) { state.tokens += result.tokens; }
        if (result.cooldown) state.cooldownUntil = now() + result.cooldown;
        if (result.ok) {
          const valid = validateExtraction(result.text);
          if (valid.ok) {
            const checked = enforceEvidence(valid.fields, redacted.text);
            state.strikes = 0;
            await save(target.id, state);
            const record = { at: new Date(now()).toISOString(), provider: target.provider, model: target.model, schema: SCHEMA_TAG, fields: valid.fields, dropped: valid.dropped };
            await store.setConfig(CACHE_PREFIX + cacheKey(normalized, target.model), record);
            return { status: 'ok', provider: target.provider, model: target.model, cached: false, fields: checked.fields, dropped: [...valid.dropped, ...checked.dropped], redaction, textHash };
          }
          result.kind = 'schema';
          result.error = valid.error;
        }
        failures.push(`${target.id}: ${result.kind}${result.status ? ' ' + result.status : ''}`);
        if (result.kind === 'schema') {
          await save(target.id, state);
          if (++schemaFails >= 2) break;
          continue;
        }
        if (result.kind === 'auth') {
          disabled.add(target.id);
          log(`AI provider ${target.id} rejected the API key (HTTP ${result.status}); skipping it for this run.`);
          await save(target.id, state);
          break;
        }
        if (result.kind === 'client') { await save(target.id, state); break; }
        if (result.kind === 'rate') {
          rateHits++;
          if (rateHits >= 2 || (result.retryAfter ?? 0) > MAX_BACKOFF_MS) {
            // Repeated cooldowns usually mean a spent daily quota: back off 1 min, 2, 4 ... up to 6 h.
            state.strikes = (state.strikes ?? 0) + 1;
            const escalated = Math.min(6 * 3_600_000, 60_000 * 2 ** (state.strikes - 1));
            state.cooldownUntil = now() + Math.max(result.retryAfter ?? 0, escalated);
            await save(target.id, state);
            break;
          }
        }
        await save(target.id, state);
        if (attempt + 1 < maxAttempts) await sleep(backoff(attempt, result.retryAfter));
      }
    }
    return attempted
      ? { status: 'failed', reason: `Every AI provider failed (${failures.join('; ')}).` }
      : { status: 'budget', reason: 'Every AI provider is cooling down or out of daily budget.' };
  }

  return { enabled: targets.length > 0, targets: targets.map(({ id, provider, model, paid, rpm, rpd, tpd }) => ({ id, provider, model, paid, rpm, rpd, tpd })), extract };
}
