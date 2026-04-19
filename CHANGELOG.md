# Changelog

All notable changes to this project are documented in this file. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.6] — 2026-04-19

### Fixed
- **Footer was repeated on every outbound chunk when a single LLM reply
  was split into multiple messages** (observed as the same footer line
  appearing 5-6 times in a row on long `Now let me…` tool-calling
  replies). `message_sending` APPEND path ran independently per chunk,
  and since each chunk started without the footer, every one of them
  received a fresh one.
- Added a **consume-once** flag on each `StashEntry`: the first
  non-footer-bearing outbound chunk gets the footer and flips the
  flag; subsequent chunks from the same LLM turn see the flag and
  skip. Chunks whose content already contains the footer (most
  commonly the `assistantTexts[last]` chunk mutated by `llm_output`)
  still SKIP without consuming, so a non-mutated chunk can still
  legitimately receive the footer once. Net: each LLM turn produces
  **at most one APPEND + one mutated chunk** with the footer (usually
  just one).

### Smoke tests
- Added a 2nd-chunk assertion that would have failed on 1.0.5 and
  passes on 1.0.6. 69/69 pass.

## [1.0.5] — 2026-04-19

### Changed
- **`used`/`pct` now mirror OpenClaw `/status`.** The persisted session
  `contextTokens` value OpenClaw keeps (and `/status` displays) tracks
  the **cacheRead portion** only, not the full prompt. 1.0.4 showed the
  full prompt size (input + cacheRead + cacheWrite), which made the
  footer read 58% while `/status` read 37% for the same turn. They now
  match: `{usedK}/{maxK} ({pct}%)` resolves to
  `cacheRead / contextWindow` (with a fresh-session fallback to `input`
  when no cache has built up yet). Footer format and placeholders are
  unchanged.
- `{inK}` now reports the raw per-turn `input` (= `/status` "Nk in"),
  not an alias of `used`.
- `cachePct` still uses the provider-aware denominator so the hit-rate
  matches `/status` "N% hit".

### Smoke tests
- Live gpt-5.4 case now resolves to `usedK=74, pct=37, inK=42,
  cachePct=64` — identical to the `/status` block. Added fresh-session
  fallback coverage and updated the Anthropic/Qwen/heuristic cases for
  the new `used` definition. 68/68 pass.

## [1.0.4] — 2026-04-19

### Fixed
- **`cache` percent could blow past 100% (observed 816% / 924%) on
  `openai-codex/gpt-5.4`.** Root cause: despite the name,
  `openai-codex` returns usage in the **Anthropic convention**
  (`input_tokens` excludes cache; `cache_read_input_tokens` is
  *additional*). 1.0.2 had classified it as OpenAI-style from the
  provider name and therefore computed `cachePct = cacheRead / input`,
  which can legitimately exceed 1.0 when cacheRead > input.
- New detection path `isAnthropicStyleUsage(provider, usage)` uses a
  **numeric heuristic first**: if `cacheRead > input`, the payload
  must be Anthropic-style because an OpenAI-style cached subset can
  never exceed its parent. This means future providers that ship the
  Anthropic shape with a name we did not anticipate are handled
  correctly without a code change. The provider-name allowlist is
  only consulted when the numeric check is inconclusive
  (`cacheRead ≤ input`), and it now includes `openai-codex`, `kimi`,
  and `minimax-portal` (all three use the anthropic-messages API
  shape in this OpenClaw install).

### Smoke tests
- 3 new `buildVars` cases: (a) real openai-completions provider with
  `cacheRead ≤ input` stays OpenAI-style, (b) `openai-codex` with
  `cacheRead=74k > input=42k` now resolves to `usedK=116, cachePct=64`
  matching the live `/status`, (c) an unknown-provider + cacheRead >
  input case confirms the heuristic overrides the allowlist. 63/63
  pass on 1.0.4.

## [1.0.3] — 2026-04-19

### Fixed
- **Context window now sourced from the OpenClaw host config, not a
  hardcoded table.** The previous behavior — a curated
  `DEFAULT_MODEL_CONTEXT_WINDOWS` plus an optional `modelContextWindows`
  override — silently went stale whenever users ran newer/larger models.
  Example that triggered this release: `qwen3.6-plus` on the user's
  account is a 1 M-token window; the plugin was printing `/131k` because
  the hardcoded entry was the public-docs number.
- New `extractHostContextWindows(config)` helper parses
  `config.models.providers.*.models[]` and builds a `{modelId,
  providerId/modelId}` map of real `contextWindow` values — the same
  source OpenClaw core uses for `/status`, compaction, and budgeting. So
  the footer can never disagree with `/status` again.
- Resolution priority (first match wins): plugin-config override → host
  config → hardcoded defaults → `defaultContextWindow`. Each tier
  supports exact match, then longest-prefix fallback.

### Smoke tests
- Added 2 tier-priority tests and 6 `extractHostContextWindows`
  assertions covering bare-id / provider-qualified indexing, multiple
  models per provider, malformed entries, and null-safe input. 57/57
  pass on 1.0.3.

## [1.0.2] — 2026-04-19

### Fixed
- **Double-count bug on OpenAI/Codex/Qwen/other non-Anthropic providers.**
  Previously `used = input + cacheRead + cacheWrite` for every provider.
  That is the Anthropic convention (`input_tokens` excludes cache;
  `cache_read_input_tokens` and `cache_creation_input_tokens` are
  additional). OpenAI/Codex/Qwen/GLM/Kimi/DeepSeek/MiniMax all use the
  opposite convention: `prompt_tokens` / `input_tokens` is the full prompt
  size with `cache_read_input_tokens` being a subset already contained in
  it. Adding them together inflated the numbers by the cached portion and
  could push pct over 100% on sessions with heavy cache hits.
  `buildVars` now branches on `entry.provider`: Anthropic-style providers
  sum the three components; everything else uses `input` directly.
  `cachePct` now divides by the correct denominator for each convention
  as well.
- **gpt-5.4 / gpt-5.4-mini context window** corrected from 400k to 200k
  (the real Codex model window; verified against OpenClaw `/status`).
- `{inK}` placeholder now reflects the true prompt side (alias of `used`)
  so it no longer double-counts cache on OpenAI-style providers either.

### Smoke tests
- Added OpenAI-style test case (gpt-5.4) that would have failed on 1.0.1
  and passes on 1.0.2: 53k prompt + 40k cache hits → usedK=53 (not 93).
- Added Qwen test case (default OpenAI-style path).

## [1.0.1] — 2026-04-19

### Added
- **Primary injection path via `llm_output`**: the hook now also mutates
  `event.assistantTexts[last]` and `event.lastAssistant.text` in place.
  `llm_output` runs handlers synchronously inside `hooks.map(async …)`, so
  the mutation lands before the core resumes — the footer propagates
  through every downstream outbound adapter, including channels that
  skip the `message_sending` hook.
- Anti-duplicate guard: `message_sending` now SKIPs when the outbound
  content already contains the footer's first line. Short follow-up
  chunks that miss `llm_output` mutation still get the footer via the
  `message_sending` fallback.
- `debug` plugin config flag. When true, emits `llm_output FIRE/STASH/
  MUTATE` and `message_sending FIRE/APPEND/SKIP/MISS` traces to the
  gateway log for diagnosing where injection drops off.

### Fixed
- Footer now reliably appears on Discord outbound, which did not invoke
  `message_sending` in every code path. Verified against live traffic
  (main agent, qwen3.6-plus model).

## [1.0.0] — 2026-04-19

### Added
- Initial release. Two hooks, one purpose:
  - `llm_output` stashes the `usage` object + model + provider, indexed by
    `sessionKey`, `runId`, `agentId`, and `channelId`.
  - `message_sending` looks the stash up by `channelId` (LRU with TTL) and
    returns `{ content: original + footer }`.
- Language-aware built-in footer templates (`en` / `zh-TW`).
- Configurable placeholders: `{model}`, `{used}`, `{usedK}`, `{max}`,
  `{maxK}`, `{pct}`, `{in}`, `{inK}`, `{out}`, `{outK}`, `{total}`,
  `{totalK}`, `{cacheRead}`, `{cacheReadK}`, `{cacheWrite}`, `{cacheWriteK}`,
  `{cachePct}`.
- Curated model → context-window table covering Claude 3/4, GPT-4/5, Qwen 3,
  GLM, Kimi, DeepSeek, MiniMax; extendable via `modelContextWindows`.
- `contextWarnThreshold` + `contextWarnFormat` for a second "/compact"
  warning line.
- `skipAgents`, `skipChannels`, and `maxMessageLength` (hard cap with
  body-trimming that always preserves the footer).
- Usage-shape normalization across plugin-sdk current, Anthropic-style, and
  OpenAI-style payloads.
- Smoke test (`test.smoke.js`) covering 40 assertions across normalization,
  template rendering, stash TTL, and end-to-end hook registration.
- `examples/config.example.jsonc`, `LICENSE` (MIT), and this changelog.
