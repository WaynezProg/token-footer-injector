#!/usr/bin/env node
/**
 * Smoke test for token-footer-injector v6.
 * Verifies that the footer follows OpenClaw's session store instead of
 * transient llm_output usage whenever a stored session entry is available.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { default: register } = require("./index.js");

let pass = 0;
let fail = 0;

function ok(name, condition, detail = "") {
  if (condition) {
    pass += 1;
    return;
  }
  fail += 1;
  console.error(`  FAIL ${name}${detail ? `\n    ${detail}` : ""}`);
}

function contains(name, got, sub) {
  ok(name, typeof got === "string" && got.includes(sub), `"${sub}" not found in:\n    ${JSON.stringify(got)}`);
}

function notContains(name, got, sub) {
  ok(name, typeof got === "string" && !got.includes(sub), `"${sub}" unexpectedly found in:\n    ${JSON.stringify(got)}`);
}

function makeApi(config) {
  const hooks = {};
  const api = {
    on: (name, fn) => { hooks[name] = fn; },
    getConfig: () => config ?? {},
  };
  return { api, hooks };
}

function writeSessionEntry(stateDir, agentId, sessionKey, entry) {
  const dir = path.join(stateDir, "agents", agentId, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify({ [sessionKey]: entry }, null, 2));
}

function fire(hooks, usage, model, sessionKey, assistantText = "response text", ctxOverrides = {}, eventOverrides = {}) {
  const texts = [assistantText];
  const lastAssistant = { text: assistantText };
  hooks.llm_output(
    { model, provider: "qwen", usage, assistantTexts: texts, lastAssistant, ...eventOverrides },
    { runId: "r1", agentId: "main", sessionKey, channelId: "discord", ...ctxOverrides },
  );
  return { text: texts[0], lastAssistantText: lastAssistant.text };
}

function send(hooks, content, sessionKey) {
  return hooks.message_sending(
    { to: "user", content, metadata: { channel: "discord" } },
    { agentId: "main", sessionKey, channelId: "discord" },
  );
}

function sendWithoutSessionContext(hooks, content) {
  return hooks.message_sending(
    { to: "user", content, metadata: { channel: "discord" } },
    { channelId: "discord" },
  );
}

function sendPayload(hooks, text, sessionKey) {
  return hooks.reply_payload_sending(
    { payload: { text }, kind: "final", channel: "discord", sessionKey, runId: "r1" },
    { channelId: "discord" },
  );
}

const oldStateDir = process.env.OPENCLAW_STATE_DIR;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-footer-smoke-"));
process.env.OPENCLAW_STATE_DIR = stateDir;

try {
  const SESSION = "agent:main:discord:direct:1089164054754508810";
  const STORED_ENTRY = {
    model: "qwen3.6-plus",
    modelProvider: "qwen",
    inputTokens: 21571,
    outputTokens: 153,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 21571,
    contextTokens: 2000000,
    updatedAt: Date.now(),
  };
  const CURRENT_ENTRY = {
    model: "qwen3.6-plus",
    modelProvider: "qwen",
    inputTokens: 99830,
    outputTokens: 981,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 53203,
    contextTokens: 2000000,
    updatedAt: Date.now(),
  };
  const PARTIAL_ENTRY_WITH_CUMULATIVE_INPUT = {
    model: "qwen3.6-plus",
    modelProvider: "qwen",
    inputTokens: 99830,
    outputTokens: 981,
    cacheRead: 0,
    cacheWrite: 0,
    contextTokens: 2000000,
    updatedAt: Date.now(),
  };

  console.log("1. register()");
  {
    const { api, hooks } = makeApi({});
    register(api);
    ok("llm_output registered", typeof hooks.llm_output === "function");
    ok("message_sending registered", typeof hooks.message_sending === "function");
    ok("reply_payload_sending registered", typeof hooks.reply_payload_sending === "function");
  }

  console.log("2. llm_output ignores stale session store");
  {
    writeSessionEntry(stateDir, "main", SESSION, STORED_ENTRY);
    const { api, hooks } = makeApi({});
    register(api);
    const result = fire(
      hooks,
      { input: 183000, output: 466, cacheRead: 0, cacheWrite: 0 },
      "qwen3.6-plus",
      SESSION,
    );
    contains("llm_output uses event context", result.text, "183k/2.0m (9%)");
    contains("llm_output uses event in/out", result.text, "183k→466 tokens");
    notContains("llm_output does not use stored previous total", result.text, "22k");
  }

  console.log("3. message_sending corrects an existing stale footer");
  {
    writeSessionEntry(stateDir, "main", SESSION, STORED_ENTRY);
    const { api, hooks } = makeApi({});
    register(api);
    const stale = "final answer\n\n📊 qwen3.6-plus | 183k/2.0m (9%) · 183k→466 tokens · cache 0";
    const result = send(hooks, stale, SESSION);
    ok("message_sending returns corrected content", result && typeof result.content === "string");
    contains("corrected footer uses stored context total", result.content, "22k/2.0m (1%)");
    contains("corrected footer uses stored in/out", result.content, "22k→153 tokens");
    notContains("corrected footer removes stale 183k", result.content, "183k");
  }

  console.log("4. llm_output prefers hook context budget");
  {
    const { api, hooks } = makeApi({});
    register(api);
    const result = fire(
      hooks,
      { input: 5000, output: 200, cacheRead: 0, cacheWrite: 0 },
      "qwen3.6-plus",
      "session:budget",
      "response text",
      { contextTokenBudget: 100000 },
    );
    contains("llm_output uses contextTokenBudget", result.text, "5.0k/100k (5%)");
    notContains("llm_output avoids hardcoded qwen window", result.text, "5.0k/2.0m");
  }

  console.log("5. missing store falls back to llm_output usage");
  {
    const { api, hooks } = makeApi({});
    register(api);
    const result = fire(
      hooks,
      { input: 5000, output: 200, cacheRead: 0, cacheWrite: 0 },
      "qwen3.6-plus",
      "session:no-store",
    );
    contains("fallback footer uses event usage", result.text, "5.0k/2.0m");
    contains("fallback footer uses event in/out", result.text, "5.0k→200 tokens");
  }

  console.log("6. partial store does not use cumulative input as context");
  {
    writeSessionEntry(stateDir, "main", SESSION, PARTIAL_ENTRY_WITH_CUMULATIVE_INPUT);
    const { api, hooks } = makeApi({});
    register(api);
    const result = fire(
      hooks,
      { input: 53203, output: 904, cacheRead: 0, cacheWrite: 0 },
      "qwen3.6-plus",
      SESSION,
    );
    contains("footer uses event context fallback", result.text, "53k/2.0m (3%)");
    contains("footer uses event in/out while store lacks total", result.text, "53k→904 tokens");
    notContains("footer does not use cumulative 100k as context", result.text, "100k/2.0m");
  }

  console.log("7. message_sending does not use global recent-session fallback");
  {
    writeSessionEntry(stateDir, "main", SESSION, PARTIAL_ENTRY_WITH_CUMULATIVE_INPUT);
    const { api, hooks } = makeApi({});
    register(api);
    fire(
      hooks,
      { input: 53203, output: 904, cacheRead: 0, cacheWrite: 0 },
      "qwen3.6-plus",
      SESSION,
    );
    writeSessionEntry(stateDir, "main", SESSION, CURRENT_ENTRY);
    const stale = "final answer long enough\n\n📊 qwen3.6-plus | 100k/2.0m (5%) · 100k→981 tokens · cache 0";
    const result = sendWithoutSessionContext(hooks, stale);
    ok("message_sending skips without explicit session or keyed fallback", result === undefined);
  }

  console.log("8. message_sending can infer agentId from sessionKey");
  {
    const COO_SESSION = "agent:coo:discord:channel:1466368503803281704";
    writeSessionEntry(stateDir, "coo", COO_SESSION, {
      model: "gpt-5.5",
      modelProvider: "openai-codex",
      inputTokens: 45000,
      outputTokens: 1200,
      cacheRead: 85000,
      cacheWrite: 0,
      totalTokens: 45000,
      contextTokens: 400000,
      updatedAt: Date.now(),
    });
    const { api, hooks } = makeApi({});
    register(api);
    const result = hooks.message_sending(
      { to: "channel", content: "coo answer long enough for footer correction", metadata: { channel: "discord" } },
      { sessionKey: COO_SESSION, channelId: "channel:1466368503803281704" },
    );
    ok("coo footer is corrected without explicit agentId", result && typeof result.content === "string");
    contains("coo footer uses coo store", result.content, "45k/400k (11%)");
    contains("coo footer uses coo in/out", result.content, "45k→1.2k tokens");
  }

  console.log("9. skipChannels suppresses footer");
  {
    const { api, hooks } = makeApi({ skipChannels: ["discord"] });
    register(api);
    const result = fire(
      hooks,
      { input: 5000, output: 200, cacheRead: 0, cacheWrite: 0 },
      "qwen3.6-plus",
      SESSION,
    );
    ok("skipChannels leaves text unchanged", result.text === "response text");
  }

  console.log("10. minContentLength is configurable");
  {
    writeSessionEntry(stateDir, "main", SESSION, STORED_ENTRY);
    const { api, hooks } = makeApi({ minContentLength: 1 });
    register(api);
    const result = send(hooks, "short", SESSION);
    ok("short content can receive footer when configured", result && typeof result.content === "string");
    contains("short content footer added", result.content, "22k/2.0m (1%)");
  }

  console.log("11. skipAgents applies after message_sending session match");
  {
    const COO_SESSION = "agent:coo:discord:channel:1466368503803281704";
    writeSessionEntry(stateDir, "coo", COO_SESSION, {
      model: "gpt-5.5",
      modelProvider: "openai-codex",
      inputTokens: 45000,
      outputTokens: 1200,
      cacheRead: 85000,
      cacheWrite: 0,
      totalTokens: 45000,
      contextTokens: 400000,
      updatedAt: Date.now(),
    });
    const { api, hooks } = makeApi({ skipAgents: ["coo"] });
    register(api);
    const result = hooks.message_sending(
      { to: "channel", content: "coo answer long enough for footer correction", metadata: { channel: "discord" } },
      { sessionKey: COO_SESSION, channelId: "channel:1466368503803281704" },
    );
    ok("matched skipped agent receives no footer", result === undefined);
  }

  console.log("12. reply_payload_sending corrects with event sessionKey");
  {
    writeSessionEntry(stateDir, "main", SESSION, CURRENT_ENTRY);
    const { api, hooks } = makeApi({});
    register(api);
    const stale = "payload answer long enough\n\n📊 qwen3.6-plus | 22k/2.0m (1%) · 22k→153 tokens · cache 0";
    const result = sendPayload(hooks, stale, SESSION);
    ok("reply_payload_sending returns corrected payload", result && result.payload && typeof result.payload.text === "string");
    contains("payload correction uses current stored total", result.payload.text, "53k/2.0m (3%)");
    contains("payload correction uses current stored in/out", result.payload.text, "100k→981 tokens");
    notContains("payload correction removes stale total", result.payload.text, "22k");
  }

  console.log("13. over-cap messages keep original content and skip footer");
  {
    writeSessionEntry(stateDir, "main", SESSION, STORED_ENTRY);
    const { api, hooks } = makeApi({ maxMessageLength: 80 });
    register(api);
    const longText = "long answer ".repeat(20).trim();
    const result = fire(
      hooks,
      { input: 183000, output: 466, cacheRead: 0, cacheWrite: 0 },
      "qwen3.6-plus",
      SESSION,
      longText,
    );
    ok("over-cap llm_output keeps full text", result.text === longText);
    notContains("over-cap llm_output skips footer", result.text, "📊");

    const sent = send(hooks, longText, SESSION);
    ok("over-cap message_sending keeps full text", sent && sent.content === longText);
  }
} finally {
  if (oldStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = oldStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
}

console.log(`\n${pass + fail} total | ${pass} pass | ${fail} fail`);
if (fail > 0) process.exit(1);
