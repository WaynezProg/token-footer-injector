# token-footer-injector

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-plugin-blue.svg)](https://github.com/openclaw)

> An OpenClaw plugin that **deterministically appends a token-usage footer**
> to every outbound agent message — sourced from the real `usage` object on
> the `llm_output` hook, so the model itself never has to write it.

## TL;DR

- **100% hit-rate, 100% accurate numbers, 0 model tokens.**
- Two hooks, one job: `llm_output` stashes the usage object, `message_sending`
  appends the footer just before delivery.
- Works for Discord DMs, Discord channels, and anywhere else an agent sends
  an outbound message through the OpenClaw dispatch pipeline.
- Fully configurable footer template with placeholders — override the
  defaults or plug in your own layout without touching code.

## Why

Prompt-only rules for "write a token footer at the end of every message" are
unreliable: models forget, truncate, or mis-format the footer. Measured
hit-rates on a real deployment dropped to 13–20% on open-weight models.
This plugin removes the footer from the model's job entirely — the host
writes it after the fact, using the authoritative usage object the provider
returned.

## The Footer

Defaults (language-aware):

```
📊 claude-opus-4-7 | 49k/200k (25%) · 49→1k tokens · cache 82%
```

When context usage exceeds `contextWarnThreshold` (default 50%), an extra
line is appended:

```
⚠️ context 72%,建議 /compact
```

All numbers are computed from the real `usage` object — no approximation,
no guesswork.

## Quick Start

```bash
# 1. Clone into your OpenClaw extensions dir
cd ~/.openclaw/extensions
git clone https://github.com/WaynezProg/token-footer-injector.git

# 2. Build
cd token-footer-injector
npm run build

# 3. Register the plugin in openclaw.json (see Configuration below)

# 4. Restart the gateway
openclaw gateway restart
```

After restart, every outbound agent message will carry the footer. Verify
with gateway.log:

```
[token-footer-injector] v1.0 init: ttlMs=60000, threshold=50%, locale=zh-TW, …
```

## How it Works

Two hooks compose the behavior:

```
LLM response
    │
    ▼
llm_output  ──►  stash { usage, model, provider } indexed by
                 { sessionKey, runId, agentId, channelId }
                            │
                            │ (TTL 60s, per-channelId LRU)
                            ▼
message_sending  ──►  read stash by channelId, build footer,
                      return { content: original + "\n\n" + footer }
```

The hook contexts do not fully overlap — `llm_output` exposes
`sessionKey/agentId/channelId`, while `message_sending` only exposes
`channelId/accountId`. The plugin therefore falls back to a per-`channelId`
LRU with a short TTL. Because outbound payloads from a single LLM run are
dispatched sequentially for the same channel, this is sufficient in
practice.

## Configuration

Register the plugin in `openclaw.json`:

```jsonc
{
  "plugins": {
    "allow": ["token-footer-injector", /* ...other plugins */],
    "entries": {
      "token-footer-injector": {
        "enabled": true,
        "config": {
          "locale": "zh-TW",
          "contextWarnThreshold": 50,
          "skipAgents": [],
          "skipChannels": [],
          "maxMessageLength": 1900
        }
      }
    },
    "load": {
      "paths": [
        "/absolute/path/to/~/.openclaw/extensions/token-footer-injector"
      ]
    }
  }
}
```

### Config schema

| Field                   | Type       | Default        | Description |
| ----------------------- | ---------- | -------------- | ----------- |
| `format`                | `string`   | built-in       | Footer template. See placeholders below. |
| `contextWarnFormat`     | `string`   | built-in       | Extra line appended when context > threshold. |
| `contextWarnThreshold`  | `number`   | `50`           | Percent of the model context window. |
| `modelContextWindows`   | `object`   | curated table  | Model id → context window (tokens). Overrides merge with the defaults. |
| `defaultContextWindow`  | `number`   | `128000`       | Fallback when the model is unknown. |
| `skipAgents`            | `string[]` | `[]`           | Agent IDs for which no footer is appended. |
| `skipChannels`          | `string[]` | `[]`           | Channel IDs (e.g. `discord`) to skip. |
| `maxMessageLength`      | `number`   | —              | Hard cap on final message length. Body is trimmed first; footer is preserved. Useful for Discord (`2000`). |
| `usageTtlMs`            | `number`   | `60000`        | How long a stashed usage entry is considered fresh. |
| `locale`                | `"en"` / `"zh-TW"` | `"en"` | Language for built-in format strings. |

### Placeholders

Use these in `format` and `contextWarnFormat`:

| Placeholder      | Value                                                      |
| ---------------- | ---------------------------------------------------------- |
| `{model}`        | Model id reported by the provider                          |
| `{used}`         | Used context tokens (`input + cacheRead + cacheWrite`)     |
| `{usedK}`        | Used tokens in K (compact: `0` if <1k; one decimal if <10k)|
| `{max}`          | Context window size (absolute tokens)                       |
| `{maxK}`         | Context window size in K                                   |
| `{pct}`          | Context usage as an integer percent                        |
| `{in}` / `{inK}` | Prompt-side tokens (input + cache in K)                    |
| `{out}` / `{outK}` | Output tokens (absolute / K)                             |
| `{total}` / `{totalK}` | Total tokens reported by provider                    |
| `{cacheRead}` / `{cacheReadK}`   | Cache-read tokens (absolute / K)          |
| `{cacheWrite}` / `{cacheWriteK}` | Cache-write tokens (absolute / K)         |
| `{cachePct}`     | Cache-read ratio over the full prompt side, integer percent|

Unknown placeholders are left as-is, so you can safely write `{literal}` in
templates too.

### Built-in formats

```
en:    📊 {model} | {usedK}k/{maxK}k ({pct}%) · {inK}→{outK}k tokens · cache {cachePct}%
       ⚠️ context {pct}%, suggest /compact
zh-TW: 📊 {model} | {usedK}k/{maxK}k ({pct}%) · {inK}→{outK}k tokens · cache {cachePct}%
       ⚠️ context {pct}%,建議 /compact
```

### Example overrides

```jsonc
{
  "format": "`{model}` · {usedK}k used / {maxK}k · out {outK}k · cache {cachePct}%",
  "contextWarnFormat": "Heads up: context at {pct}% — run /compact soon.",
  "contextWarnThreshold": 70,
  "modelContextWindows": {
    "my-custom-model": 96000,
    "minimax-m2": 245760
  }
}
```

A complete `openclaw.json` snippet: [`examples/config.example.jsonc`](examples/config.example.jsonc).

## Compatibility

- **OpenClaw host**: plugin API exposing `api.on` and hook names
  `llm_output` and `message_sending` (both available in the current plugin
  SDK; see `plugin-sdk/src/plugins/hook-types.d.ts`).
- **Providers**: any provider that populates the `usage` object on
  `llm_output`. The plugin normalizes across three shapes:
  - `{ input, output, cacheRead, cacheWrite, total }` (plugin-sdk current)
  - `{ input_tokens, output_tokens, total_tokens, cache_read_input_tokens, cache_creation_input_tokens }` (Anthropic-style)
  - `{ prompt_tokens, completion_tokens }` (OpenAI-style)

## Limitations

- **Multiple outbound payloads per LLM run.** If a single response is split
  into several payloads (for example when a message exceeds the channel's
  length limit), each payload currently receives the footer. This is
  intentional for robustness; a future version may tag only the final
  payload.
- **Cross-process boundary.** The stash lives in the plugin process. If
  your host runs the LLM and the delivery in separate processes, the footer
  will not appear. (This is not the case for the standard OpenClaw
  gateway.)
- **No sub-agent IPC hook.** Internal sub-agent messages go through a
  different path than outbound messages and may not fire `message_sending`.
  Cover this in a follow-up if you need footers on those too.

## Contributing

Issues and pull requests welcome at
<https://github.com/WaynezProg/token-footer-injector>.

When adding features, please:

- Keep `index.ts` self-contained (no runtime dependencies).
- Update `CHANGELOG.md` and `package.json` `version` together.
- Run `node test.smoke.js` before pushing.

## License

[MIT](LICENSE) © 2026 Wayne Tu.
