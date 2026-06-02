# token-footer-injector

OpenClaw plugin that appends deterministic token-usage footers to outbound
agent messages.

The model does not write the footer. The plugin injects it from OpenClaw hook
data.

## Current Behavior

- `llm_output` uses only the current hook's `event.usage`.
- `llm_output` does not read `sessions.json`, because the session store may
  still contain previous-turn data at that point.
- `message_sending` and `reply_payload_sending` use `sessions.json` only after
  they can match a reliable session through `sessionKey`, `sessionId`,
  `conversationId`, or a keyed recent agent/channel mapping.
- Broad global fallback is disabled to avoid cross-turn or cross-agent footer
  mismatches.
- If `content + footer` exceeds `maxMessageLength`, the plugin keeps the
  original content and skips the footer. It never truncates user-visible
  message content.

Footer format:

```text
📊 qwen3.6-plus | 40k/2.0m (2%) · 198k→894 tokens · cache 0
```

## Configuration

Register the plugin in `openclaw.json`:

```jsonc
{
  "plugins": {
    "allow": ["token-footer-injector"],
    "entries": {
      "token-footer-injector": {
        "enabled": true,
        "config": {
          "skipAgents": [],
          "skipChannels": [],
          "maxMessageLength": 1900,
          "debug": false
        }
      }
    },
    "load": {
      "paths": [
        "/absolute/path/to/token-footer-injector"
      ]
    }
  }
}
```

### Config Schema

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `maxMessageLength` | `number` | unset | If `content + footer` exceeds this length, keep content and skip footer. |
| `skipAgents` | `string[]` | `[]` | Agent IDs that should not receive a footer. |
| `skipChannels` | `string[]` | `[]` | Channel IDs or channel labels that should not receive a footer. |
| `debug` | `boolean` | `false` | Emit `[token-footer-injector]` diagnostic logs. |

Unknown config keys are rejected by the manifest.

## Hook Flow

```text
llm_output
  normalize event.usage
  remember keyed agent/channel session hints
  append footer from current event usage only

message_sending
  require reliable session match
  read sessions.json
  correct stale or missing footer with stored totals
  skip footer if maxMessageLength would be exceeded

reply_payload_sending
  prefer payload-stage sessionKey/runId metadata
  correct normalized payload.text before channel delivery
```

## Build And Test

```bash
npm run build
node test.smoke.js
```

## Notes

- `format`, `contextWarnFormat`, `contextWarnThreshold`, `cumulative`,
  `newSessionThreshold`, `usageTtlMs`, `locale`, `modelContextWindows`, and
  `defaultContextWindow` are not implemented in v6.
- Internal sub-agent messages may not pass through the outbound hooks this
  plugin handles.
- Restart the OpenClaw gateway after installing or updating the plugin.

## License

[MIT](LICENSE) © 2026 Wayne Tu.
