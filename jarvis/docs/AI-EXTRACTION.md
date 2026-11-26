# AI-assisted extraction: plan for approval

Status: built and tested offline, **off until a provider key is set**. Nothing has called a real API. Limits and prices below come from the November 2026 research brief. Free-tier numbers are unofficial, so check them before relying on them.

## What it does and why only here

The deterministic parser (`core/matcher.mjs`, plus the source adapters) stays first. It is fast, free, explainable and correct on structured feeds such as ROOMMATCH, Kamernet JSON and agency `dt/dd` rows. It misses free text. Free text includes Facebook group posts, Kamernet descriptions and saved-search emails, where Dutch and English phrasing varies. On the 8 synthetic fixtures the parser alone scores **92% precision and 60% recall** across the 22 fields (`node scripts/ai-eval.mjs`). That is a synthetic set, so treat it as an illustration only. Most misses are property type, applicant groups, gender restrictions, postcodes and "gestoffeerd/kaal" wording.

The model only fills what is still unknown:

1. Discovery stores the listing as today. New or changed listings go on a queue (`collector.ai.pending`).
2. After discovery and travel, the collector takes queued listings that still have unknown key terms, within `HOUSEWATCH_AI_BUDGET` provider calls per run.
3. The ad text is **redacted** and sent with a strict JSON schema. Each field must come back as `{value, evidence}`.
4. The response is validated by hand: shape, types, ranges, date and postcode formats. A value survives only if its **evidence quote occurs in the redacted text**. The match ignores case and whitespace. Any number, year or postcode in the value must also appear in that quote. Values quoted from lines that try to instruct the model ("ignore previous instructions…") are dropped.
5. `mergeExtraction` fills only keys the listing leaves unknown. It records `source: "ai"`, the provider, the model and the quote per key. When the AI disagrees with a known value it creates a `ReviewFlag`-shaped conflict, and the known value stays. Owner-confirmed facts always win. Text the parser marked as `conflicting` stays conflicting, and the AI's reading becomes a suggestion.
6. The result is written to `listing.ai` (`state: "complete"`). The existing `applyEvidenceBackedFacts` applies it at read time, and only while the listing's fingerprint is unchanged. The stored source facts never change. For Supabase, `publicListingData` applies the same facts when writing `public_data` and adds `ai_facts` with provenance and conflicts.

Example from the fixtures: an agency ad says "niet geschikt voor studenten", but the parser sets `student_allowed: true` because its positive regex matches inside the negation. The AI reading creates a conflict flag instead of silently trusting either side. This parser bug is real and worth a deterministic fix in `core/matcher.mjs`, which this change leaves alone.

## Providers

All four use one fetch-based client (`core/ai-extract.mjs`, with no SDKs). The first three use the OpenAI-compatible `chat/completions` endpoint with `response_format: {type: "json_schema", json_schema: {strict: true}}`. Anthropic uses `output_config.format` with thinking disabled. Temperature is 0 everywhere except GPT-5, which only accepts the default.

| Order | Provider / model | Cost | Free limits (research) | Our default caps | Data terms |
| --- | --- | --- | --- | --- | --- |
| 1 | Google Gemini `gemini-3.1-flash-lite` | Free | ≈15 RPM, ≈500 requests/day | 12 RPM, 400/day | In the EEA, paid-tier "no training" terms apply to free use (see GDPR) |
| 2 | Groq `openai/gpt-oss-120b` | Free | 30 RPM, ≈200K tokens/day per model | 25 RPM, 500/day, 180K tokens/day | Check Groq's current retention terms |
| 3 | Groq `qwen/qwen3.8-27b` | Free | same, separate quota | same | same |
| opt-in | OpenAI `gpt-5-nano` (`reasoning_effort: "minimal"`) | ≈$2–3/month at full volume | n/a | 30 RPM, 400/day | No training on API data by default |
| opt-in | Anthropic Claude Haiku 5.5 (`claude-haiku-5-5`, override with `HOUSEWATCH_AI_ANTHROPIC_MODELS`) | ≈$3–6/month at full volume | n/a | 30 RPM, 400/day | No training on API data by default |

- **OpenRouter free models** (`OPENROUTER_API_KEY`) are the third free link: Nemotron 3.5 Super, Ling 3.2 Flash, ERNIE 5.5 Flash, all with strict JSON schema (`provider.require_parameters`). Account-wide 20 RPM and 50 requests/day, or 1,000/day after a one-time ≥$10 credit purchase (then set `HOUSEWATCH_AI_OPENROUTER_RPD=330`). Free endpoints may log prompts; redaction stays on unless `HOUSEWATCH_AI_REDACT=0`. The free model list changes; override with `HOUSEWATCH_AI_OPENROUTER_MODELS`.
- **Paid providers never run by accident.** They join the chain only when they are named in `HOUSEWATCH_AI_PROVIDERS` and their key is set.
- **Token size:** our prompt is about 1.65K input tokens. That covers the system rules plus two synthetic few-shot pairs. The ad adds 0.2–1.5K tokens, and the output is roughly 0.4–0.7K tokens because all 22 fields are present. That is about twice the brief's 1.5K/300 estimate. Paid costs above are scaled accordingly: 9K calls/month at gpt-5-nano's $0.05/M input and $0.40/M output is about $3. Only overflow beyond the free tiers would reach a paid model.
- **Schema portability:** the wire schema uses only types, enums, `required` and `additionalProperties: false`. Gemini ignores `minLength`/`maxLength` and some other constraints, so all ranges, patterns and lengths are enforced in `core/ai-schema.mjs`.

### Chain behaviour

- Cache first. The key is `sha256(normalised redacted text + schema/prompt version + model)`. The cache is checked for every model in the chain before any request, so an ad already extracted by any model is never paid for twice. A changed listing fingerprint with the same text is re-merged from the cache for free. Changing `AI_SCHEMA_VERSION` or `PROMPT_VERSION` invalidates the cache.
- Per target (provider + model), the collector persists request and token counts for the day (UTC) and spaces calls `60 s / RPM` apart. It also keeps a cooldown, stored under `ai.usage.<provider>:<model>` in settings. A global daily cap applies across all targets.
- **HTTP 429.** The collector retries after a jittered backoff that honours `retry-after`, and 30 s is the most it will wait inline. A second 429, or a `retry-after` over 30 s, cools the target down and moves to the next one. Repeated cooldowns escalate from 1 min to 2, 4 and so on, up to 6 h, which covers a spent daily quota. Groq's `x-ratelimit-remaining-*` headers trigger a cooldown before it returns 429.
- **5xx, timeouts and network errors** get up to 3 attempts with backoff, then the next target.
- **Invalid JSON or a schema mismatch** gets one retry, then the next target.
- **HTTP 401 or 403** skips that provider for the run and logs once. The log never contains the key or ad text.
- **Other 4xx responses** go straight to the next target.

## Budgets

| Limit | Default | Variable |
| --- | --- | --- |
| Provider calls per collector run | 20 | `HOUSEWATCH_AI_BUDGET` (0 = queue only) |
| Provider calls per day, all providers | 300 | `HOUSEWATCH_AI_DAILY_BUDGET` |
| Per-target RPM / requests per day / tokens per day | see table | `HOUSEWATCH_AI_<PROVIDER>_RPM`, `_RPD`, `_TPD` |
| Models per provider | see table | `HOUSEWATCH_AI_<PROVIDER>_MODELS` (comma-separated) |

At 96 runs a day, 20 calls a run is far above the 50–300 changed ads a day, so the daily cap is the binding limit. Gemini alone covers about 400 calls a day. Groq's two models add roughly 60–70 calls each per day under the token cap. A queue entry that keeps failing is dropped after 3 attempts. The queue holds at most 500 entries. When the budget is spent, work waits for the next run.

## Privacy and redaction

`core/ai-redact.mjs` runs before anything leaves the machine. The dry-run script prints exactly what would be sent.

- **Removed:** email addresses, URLs and social links (all of them), `@handles`, IBANs, and Dutch and international phone numbers, including landlines like `015-…`. Person names are removed where detectable: after "I'm / ik ben / mijn naam is / groetjes / bel / call / stuur een berichtje naar / Contact: Mr. …". Every other occurrence of a detected name is removed too. Callers can pass known names, such as a Facebook post's author, through `names`.
- **Kept:** street names, house numbers, postcodes, prices and dates. These are what we extract.
- Name detection is heuristic. A name with no cue word, such as "Anna will show you the room", is not caught. Facebook posts are the riskiest source. Passing the author's display name from the collector covers the common case.
- Input is capped at 8,000 characters.
- The cache table stores model output (values plus short quotes from the redacted text), never the ad text. It is private under RLS and pruned after 180 days.
- The prompt marks the ad as untrusted data. Values quoted from injection lines are dropped regardless.

## GDPR notes (not legal advice)

- Ads in housing groups contain personal data such as names, phone numbers and sometimes descriptions of housemates. Redaction is data minimisation. It doesn't make the processing anonymous, because the text can still identify someone.
- **Gemini:** for users in the EEA, Switzerland and the UK, Google's Gemini API terms apply the paid-service data terms to free use: no use for product improvement or human review. The catch is that the terms tie this to the user, or to an "API client made available to users in" those regions. The collector runs on GitHub's US runners, so the location test is less clear-cut than it sounds. If you want certainty, enable Cloud Billing on the Gemini project, which your research costs at roughly €8/month. That makes the paid terms apply unambiguously. Usage would still sit inside the free quota.
- **Groq, OpenAI and Anthropic:** their API terms say they don't train on API inputs by default. Abuse-monitoring retention may still apply (for OpenAI, typically 30 days). Groq should be checked before enabling.
- If this stays a personal housing search, the household exemption may apply. A public or commercial deployment would need a legal basis (legitimate interest), a privacy note and processor agreements with the providers.

## How it fails safe

- **No key, no AI.** The pass logs once ("AI extraction is off") and the collector behaves exactly as before.
- **Errors never fail a run.** A provider outage, an invalid response, a missing migration or a store error inside the AI pass is logged in one line. The collection that already ran is kept.
- **Precedence.** The AI never overrides a known source, parser or owner value. Disagreement becomes a review flag.
- **Evidence or nothing.** A value without an exact supporting quote is dropped, and so is a value whose number isn't in the quote. Out-of-range values are dropped too: rent under €50, a stay over 120 months, impossible dates.
- **Stale results are ignored.** An extraction counts only while the listing fingerprint matches. A changed description clears it, and it is queued again.
- **Shadow mode.** `HOUSEWATCH_AI_APPLY=0` records what the AI would fill (`ai.extraction.shadow`) without applying anything.

## Measuring accuracy before trusting it

1. **Build the labelled set.** Label about 50 real ads: about 20 Kamernet, 20 Facebook and 10 email or agency, mixing Dutch and English. Store them in `data/ai-eval/labels.json` in the same format as `tests/fixtures/ai/ads.json`. The `data/` directory is gitignored, and these are real ads with personal data, so they must not be committed. Label only what the ad states, and give each label an exact quote.
2. **Run the scorer.** Use `node scripts/ai-eval.mjs --set=data/ai-eval/labels.json --mode=live --verbose`. It prints per-field precision and recall for three configurations: the parser alone, the AI alone, and parser plus AI merged, which is what users see. Unknown is never counted as wrong. A wrong value costs precision and recall.
3. **Acceptance bar (proposed).** For every field the AI may fill, merged precision should be at least 95%. A wrong fact is worse than an unknown one. Overall recall should improve by 15 points or more over the parser alone. A field below the bar stays shadow-only. This needs a per-field allowlist, a small follow-up.
4. **Re-run after changes.** Run the scorer again after any prompt, schema or model change, and bump `PROMPT_VERSION` or `AI_SCHEMA_VERSION` so the cache refreshes.

## Setup

1. **Migration.** Apply `supabase/migrations/0003_ai_extraction.sql` in the Supabase SQL editor. It adds the private `ai_extraction_cache` table and `prune_ai_cache()`, which the daily prune job calls when the table exists. The repository has no `0002` file, so check that numbering matches your plan.
2. **GitHub Actions secrets.** Add `GEMINI_API_KEY` (from Google AI Studio), `GROQ_API_KEY` (from the Groq console) and `OPENROUTER_API_KEY` (from openrouter.ai). Add `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` only if you approve a paid backstop.
3. **Optional Actions variables.** `HOUSEWATCH_AI_PROVIDERS`, `HOUSEWATCH_AI_BUDGET`, `HOUSEWATCH_AI_DAILY_BUDGET`, `HOUSEWATCH_AI_APPLY`.
4. **Workflow.** The workflow file lives outside `jarvis/` and was not edited. Add this to the `npm run collect` step's `env:` in `.github/workflows/collect.yml`:

   ```yaml
   GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
   GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
   HOUSEWATCH_AI_PROVIDERS: ${{ vars.HOUSEWATCH_AI_PROVIDERS || 'gemini,groq' }}
   HOUSEWATCH_AI_BUDGET: ${{ vars.HOUSEWATCH_AI_BUDGET || '20' }}
   HOUSEWATCH_AI_DAILY_BUDGET: ${{ vars.HOUSEWATCH_AI_DAILY_BUDGET || '300' }}
   HOUSEWATCH_AI_APPLY: ${{ vars.HOUSEWATCH_AI_APPLY || '1' }}
   ```

5. **Local checks.** `node scripts/ai-extract-sample.mjs --fixture=<id> [--schema]` prints the redacted prompt and schema without calling anything. With a key set, add `--live` to extract that one fixture. `HOUSEWATCH_AI_BACKFILL=1 npm run collect` queues existing listings once.

Vercel needs no AI variables. The app only reads stored results.

## Files

| File | Role |
| --- | --- |
| `core/ai-schema.mjs` | Field list, strict JSON schema, validator, evidence check, injection guard |
| `core/ai-prompt.mjs` | System prompt and synthetic Dutch and English few-shot examples (`PROMPT_VERSION`) |
| `core/ai-redact.mjs` | Redaction and text normalisation |
| `core/ai-extract.mjs` | Provider chain, budgets, pacing, backoff, cache |
| `core/ai-merge.mjs` | `mergeExtraction`, `aiRecord`, `listingAsAiFields` |
| `core/ai-collect.mjs` | Collector pass: queue, per-run budget, fail-safe, shadow mode |
| `core/ai-eval.mjs`, `scripts/ai-eval.mjs` | Field-level precision and recall |
| `scripts/ai-extract-sample.mjs` | Dry run and single live extraction |
| `tests/ai-extract.test.mjs`, `tests/fixtures/ai/ads.json` | Mocked-provider tests and 8 synthetic ads |
| Hooks | `core/collector.mjs` (runs the pass), `core/discovery.mjs` (`aiIds`), `core/store-pg.mjs` (`ai.cache.*` → table, `pruneAiCache`), `core/public-data.mjs` (applies AI facts to `public_data`, adds `ai_facts`), `scripts/prune.mjs` |

## Open decisions

1. **Approve the free chain** of Gemini then Groq, and decide whether Gemini billing should be on for unambiguous EEA terms (about €8/month).
2. **Paid backstop:** none, gpt-5-nano, or Haiku 5.5.
3. **Rollout:** apply immediately, or run `HOUSEWATCH_AI_APPLY=0` in shadow mode until the 50-ad evaluation meets the bar.
4. **UI:** `ai_facts` (provenance) and `ai.extraction.conflicts` are stored but not yet shown. `lib/server/listings-data.ts` would need a few lines to append the conflicts to `flags` and to mark AI-filled facts, for the UI engineers.
5. **Parser fix:** "niet geschikt voor studenten" is parsed as students allowed. This is a deterministic fix in `core/matcher.mjs`.
6. **Cost lists:** monthly charges are one list, so the AI fills them only when the list is empty. Partial additions, such as a utilities estimate next to a parsed service charge, are kept as suggestions. Decide whether to allow per-item merging.
