# Changelog

All notable changes to this project are documented in this file. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
