#!/usr/bin/env node
/**
 * Smoke test for token-footer-injector v2.0.
 * Tests cumulative session accumulation end-to-end through register().
 *   node test.smoke.js
 * Exits non-zero on failure.
 */
"use strict";

const mod = require("./index.js");
const { default: register } = mod;

let pass = 0;
let fail = 0;

function eq(name, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) { pass++; }
  else {
    fail++;
    console.error(`  FAIL ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
  }
}
function truthy(name, got) {
  if (got) { pass++; }
  else { fail++; console.error(`  FAIL ${name} (falsy): ${JSON.stringify(got)}`); }
}
function contains(name, got, sub) {
  if (typeof got === "string" && got.includes(sub)) { pass++; }
  else { fail++; console.error(`  FAIL ${name}\n    "${sub}" not found in:\n    ${JSON.stringify(got)}`); }
}

// ---------------------------------------------------------------------------
// Helper: build a test api with hooks and config
// ---------------------------------------------------------------------------
function makeApi(config) {
  const hooks = {};
  const api = {
    on: (name, fn) => { hooks[name] = fn; },
    getConfig: () => config ?? {},
  };
  return { api, hooks };
}

function fire(hooks, usage, model, provider, sessionKey, channelId, assistantText) {
  const texts = [assistantText ?? "response text"];
  hooks.llm_output(
    { model, provider, usage, assistantTexts: texts, lastAssistant: { text: texts[0] } },
    { runId: "r1", agentId: "main", sessionKey, channelId },
  );
  return texts[0];
}

function send(hooks, content, channelId) {
  return hooks.message_sending(
    { to: "user", content, metadata: { channel: channelId } },
    { channelId },
  );
}

// ---------------------------------------------------------------------------
// 1. Basic registration
// ---------------------------------------------------------------------------
console.log("1. register()");
{
  const { api, hooks } = makeApi({});
  register(api);
  truthy("llm_output registered", typeof hooks.llm_output === "function");
  truthy("message_sending registered", typeof hooks.message_sending === "function");
}

// ---------------------------------------------------------------------------
// 2. Single turn — footer appears, contains model + context + cache
// ---------------------------------------------------------------------------
console.log("2. single turn cumulative footer");
{
  const { api, hooks } = makeApi({ locale: "zh-TW" });
  register(api);

  fire(hooks,
    { input: 10000, output: 500, cacheRead: 40000, cacheWrite: 0, total: 10500 },
    "claude-opus-4-7", "anthropic",
    "session:test1", "discord",
  );

  const result = send(hooks, "Hello!", "discord");
  // Should be skipped (already mutated by llm_output — consume-once path)
  // OR content contains the footer from message_sending fallback

  // Either way: the mutated assistantTexts[0] should have the footer
  fire(hooks,
    { input: 10000, output: 500, cacheRead: 40000, cacheWrite: 0, total: 10500 },
    "claude-opus-4-7", "anthropic",
    "session:test1", "discord2",  // different channel
    "Another reply",
  );
  const result2 = send(hooks, "Hello!", "discord2");
  truthy("footer returned for discord2", result2 != null);
  if (result2) {
    contains("footer has 📊", result2.content, "📊");
    contains("footer has model", result2.content, "claude-opus-4-7");
    contains("footer has 輪", result2.content, "輪");
    contains("footer has cache%", result2.content, "cache");
  }
}

// ---------------------------------------------------------------------------
// 3. llm_output mutates assistantTexts in-place
// ---------------------------------------------------------------------------
console.log("3. llm_output mutates assistantTexts");
{
  const { api, hooks } = makeApi({ locale: "zh-TW" });
  register(api);

  const texts = ["This is the reply"];
  hooks.llm_output(
    { model: "qwen3.6-plus", provider: "qwen",
      usage: { input: 5000, output: 200, cacheRead: 20000, cacheWrite: 0, total: 5200 },
      assistantTexts: texts,
      lastAssistant: { text: texts[0] } },
    { runId: "r1", agentId: "a1", sessionKey: "session:m1", channelId: "ch1" },
  );
  truthy("assistantTexts[0] mutated", texts[0].includes("📊"));
  truthy("mutated text has model", texts[0].includes("qwen3.6-plus"));
  truthy("mutated text has 輪", texts[0].includes("輪"));
  contains("mutated text has cache", texts[0], "cache");
}

// ---------------------------------------------------------------------------
// 4. Multi-turn accumulation
// ---------------------------------------------------------------------------
console.log("4. multi-turn accumulation");
{
  const { api, hooks } = makeApi({ locale: "zh-TW" });
  register(api);

  const SESSION = "session:acc-test";
  const CHAN = "ch-acc";
  const MODEL = "qwen3.6-plus";
  const PROV = "qwen";

  // Turn 1
  fire(hooks, { input: 5000, output: 200, cacheRead: 0, cacheWrite: 0, total: 5200 }, MODEL, PROV, SESSION, CHAN);
  // Turn 2
  fire(hooks, { input: 5000, output: 300, cacheRead: 4000, cacheWrite: 0, total: 5300 }, MODEL, PROV, SESSION, CHAN);
  // Turn 3
  const t3text = ["Turn 3 reply"];
  hooks.llm_output(
    { model: MODEL, provider: PROV,
      usage: { input: 5000, output: 400, cacheRead: 8000, cacheWrite: 0, total: 5400 },
      assistantTexts: t3text, lastAssistant: { text: t3text[0] } },
    { runId: "r3", agentId: "a", sessionKey: SESSION, channelId: CHAN },
  );

  truthy("t3 footer mutated", t3text[0].includes("📊"));
  truthy("t3 shows 3 turns", t3text[0].includes("3 輪"));
  // totalIn should be 5000+5000+5000 = 15000 → 15k
  truthy("t3 shows cumulative input 15k", t3text[0].includes("15"));
  // totalOut 200+300+400 = 900 → <1k → "0" in toK
  truthy("t3 shows output 0k (900 < 1k)", t3text[0].includes("out 0k"));
}

// ---------------------------------------------------------------------------
// 5. Consume-once: second message_sending chunk skips footer
// ---------------------------------------------------------------------------
console.log("5. consume-once");
{
  const { api, hooks } = makeApi({});
  register(api);

  fire(hooks,
    { input: 3000, output: 100, cacheRead: 0, cacheWrite: 0, total: 3100 },
    "gpt-5.4", "openai-codex", "session:c1", "discord-co",
  );

  const r1 = send(hooks, "First chunk", "discord-co");
  const r2 = send(hooks, "Second chunk", "discord-co");
  // r1 may return footer or undefined (if llm_output already mutated)
  // r2 must NOT return a new footer (consume-once)
  eq("second chunk not re-appended", r2, undefined);
}

// ---------------------------------------------------------------------------
// 6. New session warning
// ---------------------------------------------------------------------------
console.log("6. new session warning (zh-TW)");
{
  const { api, hooks } = makeApi({ locale: "zh-TW", newSessionThreshold: 50 });
  register(api);

  const texts = ["Reply text"];
  // qwen3.6-plus hardcoded at 131072; cacheRead=90000 → 90/131 ≈ 68% > 50
  hooks.llm_output(
    { model: "qwen3.6-plus", provider: "qwen",
      usage: { input: 5000, output: 200, cacheRead: 90000, cacheWrite: 0, total: 5200 },
      assistantTexts: texts, lastAssistant: { text: texts[0] } },
    { runId: "r1", agentId: "a", sessionKey: "session:warn1", channelId: "ch-w1" },
  );
  truthy("warning in footer when > threshold", texts[0].includes("⚠️"));
  truthy("warning includes /new", texts[0].includes("/new"));
}

// ---------------------------------------------------------------------------
// 7. No warning below threshold
// ---------------------------------------------------------------------------
console.log("7. no warning below threshold");
{
  const { api, hooks } = makeApi({ locale: "zh-TW", newSessionThreshold: 70 });
  register(api);

  const texts = ["Low usage reply"];
  // 5000 input, 0 cache → used=5000, 5/131 ≈ 3.8% < 70%
  hooks.llm_output(
    { model: "qwen3.6-plus", provider: "qwen",
      usage: { input: 5000, output: 100, cacheRead: 0, cacheWrite: 0, total: 5100 },
      assistantTexts: texts, lastAssistant: { text: texts[0] } },
    { runId: "r1", agentId: "a", sessionKey: "session:nowarn1", channelId: "ch-nw1" },
  );
  truthy("no warning when below threshold", !texts[0].includes("⚠️"));
}

// ---------------------------------------------------------------------------
// 8. skipChannels suppresses footer
// ---------------------------------------------------------------------------
console.log("8. skipChannels");
{
  const { api, hooks } = makeApi({ skipChannels: ["discord"] });
  register(api);

  fire(hooks,
    { input: 5000, output: 100, cacheRead: 0, cacheWrite: 0, total: 5100 },
    "gpt-5.4", "openai", "session:sk1", "discord",
  );
  const result = send(hooks, "skipped channel", "discord");
  eq("skipChannels suppresses footer", result, undefined);
}

// ---------------------------------------------------------------------------
// 9. No stash → message_sending returns undefined
// ---------------------------------------------------------------------------
console.log("9. no usage stash → silent pass-through");
{
  const { api, hooks } = makeApi({});
  register(api);
  const result = send(hooks, "no llm_output fired", "ch-empty");
  eq("no stash → no modification", result, undefined);
}

// ---------------------------------------------------------------------------
// 10. Non-cumulative mode (cumulative: false) — per-call footer
// ---------------------------------------------------------------------------
console.log("10. non-cumulative mode");
{
  const { api, hooks } = makeApi({ cumulative: false });
  register(api);

  const texts = ["per-call reply"];
  hooks.llm_output(
    { model: "qwen3.6-plus", provider: "qwen",
      usage: { input: 5000, output: 200, cacheRead: 2000, cacheWrite: 0, total: 5200 },
      assistantTexts: texts, lastAssistant: { text: texts[0] } },
    { runId: "r1", agentId: "a", sessionKey: "session:nc1", channelId: "ch-nc1" },
  );
  truthy("non-cumulative still adds footer", texts[0].includes("📊"));
  // No "輪" since non-cumulative mode uses single-line format
  truthy("non-cumulative has model", texts[0].includes("qwen3.6-plus"));
}

// ---------------------------------------------------------------------------
// 11. maxMessageLength trims body but preserves footer
// ---------------------------------------------------------------------------
console.log("11. maxMessageLength trimming");
{
  const { api, hooks } = makeApi({ maxMessageLength: 80 });
  register(api);

  fire(hooks,
    { input: 5000, output: 100, cacheRead: 0, cacheWrite: 0, total: 5100 },
    "gpt-5.4", "openai-codex", "session:cap1", "ch-cap1",
  );
  const longBody = "A".repeat(200);
  const result = send(hooks, longBody, "ch-cap1");
  if (result) {
    truthy("capped content within maxMessageLength", result.content.length <= 80);
    truthy("footer preserved in capped content", result.content.includes("📊"));
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${pass + fail} total | ${pass} pass | ${fail} fail`);
if (fail > 0) process.exit(1);
