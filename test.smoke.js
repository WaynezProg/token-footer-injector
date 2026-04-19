#!/usr/bin/env node
/**
 * Smoke test for token-footer-injector. Runs without any test framework:
 *   node test.smoke.js
 * Exits non-zero on the first failure. Prints a summary line at the end.
 */
"use strict";

const mod = require("./index.js");
const {
  default: register,
  normalizeUsage,
  resolveContextWindow,
  extractHostContextWindows,
  buildVars,
  renderTemplate,
  buildFooter,
  applyFooter,
  UsageStash,
} = mod;

let pass = 0;
let fail = 0;
const failures = [];

function eq(name, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) {
    pass++;
  } else {
    fail++;
    failures.push({ name, got, want });
    console.error(`  FAIL ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
  }
}

function truthy(name, got) {
  if (got) pass++;
  else {
    fail++;
    failures.push({ name, got });
    console.error(`  FAIL ${name} (falsy): ${JSON.stringify(got)}`);
  }
}

// ---------------------------------------------------------------------------
// normalizeUsage
// ---------------------------------------------------------------------------
console.log("normalizeUsage");
eq(
  "new shape",
  normalizeUsage({ input: 100, output: 20, cacheRead: 30, cacheWrite: 5, total: 155 }),
  { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, total: 155 },
);
eq(
  "legacy shape",
  normalizeUsage({ input_tokens: 200, output_tokens: 40, total_tokens: 240 }),
  { input: 200, output: 40, cacheRead: 0, cacheWrite: 0, total: 240 },
);
eq(
  "openai anthropic mixed cache names",
  normalizeUsage({ prompt_tokens: 100, completion_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 5 }),
  { input: 100, output: 10, cacheRead: 50, cacheWrite: 5, total: 110 },
);
eq("null", normalizeUsage(null), null);
eq("empty", normalizeUsage({}), null);

// ---------------------------------------------------------------------------
// resolveContextWindow
// ---------------------------------------------------------------------------
console.log("resolveContextWindow");
eq("exact opus 4.7", resolveContextWindow("claude-opus-4-7", undefined, 128000), 200000);
eq("exact opus 4.7 1m", resolveContextWindow("claude-opus-4-7[1m]", undefined, 128000), 1000000);
eq("prefix claude-", resolveContextWindow("claude-something-new", undefined, 128000), 200000);
eq("prefix qwen3- (hardcoded)", resolveContextWindow("qwen3-turbo", undefined, 128000), 131072);
eq("exact qwen3.6-plus (hardcoded)", resolveContextWindow("qwen3.6-plus", undefined, 128000), 131072);
eq("override wins", resolveContextWindow("custom-model", { "custom-model": 64000 }, 128000), 64000);
eq("fallback", resolveContextWindow("totally-unknown-xxx", undefined, 99999), 99999);

// host map takes priority over hardcoded defaults
eq(
  "host map beats hardcoded qwen3.6-plus",
  resolveContextWindow("qwen3.6-plus", undefined, 128000, { "qwen3.6-plus": 1000000 }),
  1000000,
);
eq(
  "plugin override still wins over host map",
  resolveContextWindow("qwen3.6-plus", { "qwen3.6-plus": 500000 }, 128000, { "qwen3.6-plus": 1000000 }),
  500000,
);

// ---------------------------------------------------------------------------
// extractHostContextWindows — parses openclaw.json shape
// ---------------------------------------------------------------------------
console.log("extractHostContextWindows");
{
  const hostConfig = {
    models: {
      providers: {
        qwen: {
          models: [
            { id: "qwen3.6-plus", contextWindow: 1000000, maxTokens: 65536 },
            { id: "qwen3-max", contextWindow: 262144 },
          ],
        },
        kimi: {
          models: [{ id: "k2p5", contextWindow: 262144 }],
        },
        noModelsField: { models: undefined },
        malformed: { models: [{ id: "bad" /* no contextWindow */ }, { contextWindow: 100 /* no id */ }] },
      },
    },
  };
  const map = extractHostContextWindows(hostConfig);
  eq("indexes bare id", map["qwen3.6-plus"], 1000000);
  eq("indexes providerId/id", map["qwen/qwen3.6-plus"], 1000000);
  eq("multiple models per provider", map["qwen3-max"], 262144);
  eq("separate providers", map["kimi/k2p5"], 262144);
  eq("missing contextWindow is skipped", map["bad"], undefined);
  eq("null safety", JSON.stringify(extractHostContextWindows(null)), "{}");
  eq("missing providers", JSON.stringify(extractHostContextWindows({ models: {} })), "{}");
}

// ---------------------------------------------------------------------------
// buildVars + renderTemplate (Anthropic-style: cache is additional to input)
// ---------------------------------------------------------------------------
console.log("buildVars + renderTemplate (Anthropic)");
{
  const entry = {
    usage: { input: 8000, output: 500, cacheRead: 40000, cacheWrite: 1000, total: 8500 },
    model: "claude-opus-4-7",
    provider: "anthropic",
    ts: Date.now(),
  };
  const vars = buildVars(entry, 200000);
  // Anthropic: used = 8000 + 40000 + 1000 = 49000 → 49k, pct = 49/200 ≈ 25%
  eq("usedK", vars.usedK, "49");
  eq("maxK", vars.maxK, "200");
  eq("pct", vars.pct, "25");
  eq("inK", vars.inK, "49");
  eq("outK", vars.outK, "0"); // 500 → < 1k → "0"
  // cachePct = 40000 / 49000 = 81.6% → 82
  eq("cachePct", vars.cachePct, "82");
  const tmpl = "📊 {model} | {usedK}k/{maxK}k ({pct}%) · {inK}→{outK}k tokens · cache {cachePct}%";
  eq(
    "render template",
    renderTemplate(tmpl, vars),
    "📊 claude-opus-4-7 | 49k/200k (25%) · 49→0k tokens · cache 82%",
  );
}

// ---------------------------------------------------------------------------
// buildVars (true OpenAI-style: e.g. qwen/zai/xai on an openai-completions API)
// ---------------------------------------------------------------------------
console.log("buildVars (openai-completions style, cacheRead ≤ input)");
{
  // Heuristic kicks in: cacheRead ≤ input → OpenAI-style → cache is subset
  const entry = {
    usage: { input: 53000, output: 500, cacheRead: 40000, cacheWrite: 0, total: 53500 },
    model: "qwen3.6-plus",
    provider: "qwen",
    ts: Date.now(),
  };
  const vars = buildVars(entry, 1000000);
  eq("OpenAI usedK (no double count)", vars.usedK, "53");
  eq("OpenAI pct", vars.pct, "5");           // 53/1000 = 5.3 → 5
  eq("OpenAI inK matches used", vars.inK, "53");
  eq("OpenAI cachePct uses input as denom", vars.cachePct, "75"); // 40/53 ≈ 75
  truthy("cachePct never over 100 for this case", Number(vars.cachePct) <= 100);
}

// ---------------------------------------------------------------------------
// buildVars (openai-codex actually returns Anthropic-style usage)
// ---------------------------------------------------------------------------
console.log("buildVars (openai-codex → Anthropic-style)");
{
  // Real observation: gpt-5.4 usage shows input=42k, cacheRead=74k — 74>42
  // so it must be Anthropic-style (cache is additional, not subset).
  const entry = {
    usage: { input: 42000, output: 3100, cacheRead: 74000, cacheWrite: 0, total: 45100 },
    model: "gpt-5.4",
    provider: "openai-codex",
    ts: Date.now(),
  };
  const vars = buildVars(entry, 200000);
  // Full prompt = 42 + 74 = 116k → 58%
  eq("codex usedK", vars.usedK, "116");
  eq("codex pct", vars.pct, "58");
  // cache hit = 74 / 116 ≈ 64% (matches /status)
  eq("codex cachePct ≤ 100", vars.cachePct, "64");
  truthy("codex cachePct not blown up", Number(vars.cachePct) <= 100);
}

// ---------------------------------------------------------------------------
// Heuristic: cacheRead > input forces Anthropic-style regardless of provider
// ---------------------------------------------------------------------------
console.log("buildVars (heuristic: cacheRead > input on unknown provider)");
{
  const entry = {
    usage: { input: 10000, output: 500, cacheRead: 80000, cacheWrite: 0, total: 10500 },
    model: "weird-future-model",
    provider: "some-new-provider",
    ts: Date.now(),
  };
  const vars = buildVars(entry, 200000);
  eq("unknown + cacheRead>input → anthropic path", vars.usedK, "90"); // 10+80=90
  eq("unknown + cacheRead>input → cachePct ≤ 100", vars.cachePct, "89"); // 80/90 ≈ 89
}

// ---------------------------------------------------------------------------
// Qwen (treated as OpenAI-style by default)
// ---------------------------------------------------------------------------
console.log("buildVars (qwen default to OpenAI-style)");
{
  const entry = {
    usage: { input: 41419, output: 191, cacheRead: 0, cacheWrite: 0, total: 41610 },
    model: "qwen3.6-plus",
    provider: "qwen",
    ts: Date.now(),
  };
  const vars = buildVars(entry, 131072);
  eq("qwen usedK", vars.usedK, "41");
  eq("qwen pct", vars.pct, "32"); // 41419/131072 → 31.6 → 32
  eq("qwen cachePct 0 when no cache", vars.cachePct, "0");
}

// ---------------------------------------------------------------------------
// buildFooter (warn line)
// ---------------------------------------------------------------------------
console.log("buildFooter");
{
  // usage puts pct above 50
  const entry = {
    usage: { input: 60000, output: 1000, cacheRead: 40000, cacheWrite: 1000, total: 61000 },
    model: "claude-opus-4-7",
    provider: "anthropic",
    ts: Date.now(),
  };
  // used = 60000+40000+1000 = 101000 / 200000 = 50.5% → 51 (warn triggered)
  const footer = buildFooter(entry, { contextWarnThreshold: 50 });
  truthy("warn present when pct > threshold", footer.includes("⚠️"));
  truthy("main line present", footer.includes("📊"));

  // Below threshold → no warn line
  const entry2 = {
    usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, total: 1100 },
    model: "claude-opus-4-7",
    provider: "anthropic",
    ts: Date.now(),
  };
  const footer2 = buildFooter(entry2, { contextWarnThreshold: 50 });
  truthy("no warn below threshold", !footer2.includes("⚠️"));

  // Custom format + zh-TW warn
  const footer3 = buildFooter(entry, {
    contextWarnThreshold: 50,
    locale: "zh-TW",
    format: "📊 {model}/{pct}%",
    contextWarnFormat: "⚠️ 注意 context {pct}%",
  });
  eq("custom main line", footer3.split("\n")[0], "📊 claude-opus-4-7/51%");
  eq("custom warn line", footer3.split("\n")[1], "⚠️ 注意 context 51%");
}

// ---------------------------------------------------------------------------
// applyFooter (cap)
// ---------------------------------------------------------------------------
console.log("applyFooter");
eq("no cap", applyFooter("hello", "FOOTER"), "hello\n\nFOOTER");
eq("cap roomy", applyFooter("hi", "FTR", 100), "hi\n\nFTR");
{
  // Force trim: body "abcdefghij" + "\n\nXY" cap 8 → body budget = 4
  const out = applyFooter("abcdefghij", "XY", 8);
  truthy("cap result ends with footer", out.endsWith("XY"));
  truthy("cap result within bounds", out.length <= 8);
}

// ---------------------------------------------------------------------------
// UsageStash
// ---------------------------------------------------------------------------
console.log("UsageStash");
{
  const s = new UsageStash(60000);
  const entry = { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, model: "m", provider: "p", ts: Date.now() };
  s.set(["session:abc", "channel:discord"], entry);
  truthy("lookup by session", s.get(["session:abc"]) !== null);
  truthy("lookup by channel", s.get(["channel:discord"]) !== null);
  eq("lookup miss", s.get(["channel:telegram"]), null);
}
{
  const s = new UsageStash(10);
  const entry = { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, model: "m", provider: "p", ts: Date.now() - 100 };
  s.set(["channel:discord"], entry);
  // Entry already older than ttl, should be considered stale
  eq("ttl expiry drops entry", s.get(["channel:discord"]), null);
}

// ---------------------------------------------------------------------------
// End-to-end register() with mock api
// ---------------------------------------------------------------------------
console.log("register() end-to-end");
{
  const hooks = {};
  const api = {
    on: (name, fn) => { hooks[name] = fn; },
    getConfig: () => ({ locale: "zh-TW" }),
  };
  register(api);
  truthy("llm_output registered", typeof hooks.llm_output === "function");
  truthy("message_sending registered", typeof hooks.message_sending === "function");

  // Simulate llm_output
  hooks.llm_output(
    {
      runId: "r1",
      sessionId: "s1",
      provider: "anthropic",
      model: "claude-opus-4-7",
      assistantTexts: ["hello"],
      usage: { input: 5000, output: 300, cacheRead: 20000, cacheWrite: 500, total: 5300 },
    },
    {
      runId: "r1",
      agentId: "main",
      sessionKey: "agent:main:discord:dm",
      channelId: "discord",
    },
  );

  // Simulate message_sending — ctx only has channelId/accountId
  const result = hooks.message_sending(
    { to: "user_xxx", content: "Hi Wayne, done!", metadata: { channel: "discord", accountId: "bot" } },
    { channelId: "discord", accountId: "bot" },
  );
  truthy("footer returned", result && typeof result.content === "string");
  truthy("footer contains 📊", result.content.includes("📊"));
  truthy("footer contains model", result.content.includes("claude-opus-4-7"));
  truthy("original body preserved", result.content.includes("Hi Wayne, done!"));

  // Skip channel
  const hooks2 = {};
  const api2 = { on: (n, fn) => { hooks2[n] = fn; }, getConfig: () => ({ skipChannels: ["discord"] }) };
  register(api2);
  hooks2.llm_output(
    { model: "m", provider: "p", usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, total: 11 } },
    { channelId: "discord" },
  );
  const skipped = hooks2.message_sending(
    { to: "x", content: "hi", metadata: { channel: "discord" } },
    { channelId: "discord" },
  );
  eq("skipChannels suppresses footer", skipped, undefined);

  // No stash available → skip silently
  const hooks3 = {};
  const api3 = { on: (n, fn) => { hooks3[n] = fn; }, getConfig: () => ({}) };
  register(api3);
  const noStash = hooks3.message_sending(
    { to: "x", content: "hi", metadata: { channel: "discord" } },
    { channelId: "discord" },
  );
  eq("no usage stash → no modification", noStash, undefined);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${pass + fail} total | ${pass} pass | ${fail} fail`);
if (fail > 0) process.exit(1);
