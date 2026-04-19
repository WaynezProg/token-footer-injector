var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// index.ts
var index_exports = {};
__export(index_exports, {
  UsageStash: () => UsageStash,
  applyFooter: () => applyFooter,
  buildFooter: () => buildFooter,
  buildVars: () => buildVars,
  default: () => register,
  normalizeUsage: () => normalizeUsage,
  renderTemplate: () => renderTemplate,
  resolveContextWindow: () => resolveContextWindow
});
module.exports = __toCommonJS(index_exports);
var DEFAULT_TTL_MS = 6e4;
var DEFAULT_CONTEXT_WINDOW = 128e3;
var DEFAULT_WARN_THRESHOLD = 50;
var DEFAULT_MODEL_CONTEXT_WINDOWS = {
  // Anthropic
  "claude-opus-4-7[1m]": 1e6,
  "claude-opus-4-7": 2e5,
  "claude-opus-4-6": 2e5,
  "claude-sonnet-4-6": 2e5,
  "claude-haiku-4-5": 2e5,
  "claude-3-7-sonnet": 2e5,
  "claude-3-5-sonnet": 2e5,
  "claude-3-5-haiku": 2e5,
  "claude-3-opus": 2e5,
  "claude-": 2e5,
  // prefix fallback
  // OpenAI
  "gpt-5.4": 4e5,
  "gpt-5": 256e3,
  "gpt-4.1": 1e6,
  "gpt-4o": 128e3,
  "gpt-4": 128e3,
  "o1": 2e5,
  "o3": 2e5,
  // Qwen / Alibaba
  "qwen3.6-plus": 131072,
  "qwen3-plus": 131072,
  "qwen3-max": 262144,
  "qwen3-": 131072,
  "qwen-": 131072,
  // Others
  "glm-4.6": 128e3,
  "kimi-k2": 128e3,
  "deepseek-": 128e3,
  "minimax-": 245760
};
var DEFAULT_FORMATS = {
  en: {
    format: "\u{1F4CA} {model} | {usedK}k/{maxK}k ({pct}%) \xB7 {inK}\u2192{outK}k tokens \xB7 cache {cachePct}%",
    warn: "\u26A0\uFE0F context {pct}%, suggest /compact"
  },
  "zh-TW": {
    format: "\u{1F4CA} {model} | {usedK}k/{maxK}k ({pct}%) \xB7 {inK}\u2192{outK}k tokens \xB7 cache {cachePct}%",
    warn: "\u26A0\uFE0F context {pct}%,\u5EFA\u8B70 /compact"
  }
};
function log(msg) {
  console.log(`[token-footer-injector] ${msg}`);
}
function warn(msg) {
  console.log(`[token-footer-injector] WARN: ${msg}`);
}
function toNum(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const input = toNum(raw.input) || toNum(raw.input_tokens) || toNum(raw.prompt_tokens);
  const output = toNum(raw.output) || toNum(raw.output_tokens) || toNum(raw.completion_tokens);
  const cacheRead = toNum(raw.cacheRead) || toNum(raw.cache_read_input_tokens) || toNum(raw.cacheReadTokens);
  const cacheWrite = toNum(raw.cacheWrite) || toNum(raw.cache_creation_input_tokens) || toNum(raw.cacheWriteTokens);
  const total = toNum(raw.total) || toNum(raw.total_tokens) || input + output;
  if (input === 0 && output === 0 && total === 0) return null;
  return { input, output, cacheRead, cacheWrite, total };
}
function resolveContextWindow(model, overrides, fallback) {
  const map = { ...DEFAULT_MODEL_CONTEXT_WINDOWS, ...overrides ?? {} };
  if (map[model]) return map[model];
  let best = fallback;
  let bestLen = 0;
  for (const key of Object.keys(map)) {
    if (model.startsWith(key) && key.length > bestLen) {
      best = map[key];
      bestLen = key.length;
    }
  }
  return best;
}
function toK(n) {
  if (n < 1e3) return "0";
  const k = n / 1e3;
  return k < 10 ? k.toFixed(1) : String(Math.round(k));
}
function buildVars(entry, contextWindow) {
  const u = entry.usage;
  const used = u.input + u.cacheRead + u.cacheWrite;
  const pctNum = contextWindow > 0 ? used / contextWindow * 100 : 0;
  const totalInput = u.input + u.cacheRead + u.cacheWrite;
  const cachePctNum = totalInput > 0 ? u.cacheRead / totalInput * 100 : 0;
  const vars = {
    model: entry.model || "unknown",
    used: String(used),
    usedK: toK(used),
    max: String(contextWindow),
    maxK: String(Math.round(contextWindow / 1e3)),
    pct: String(Math.round(pctNum)),
    in: String(u.input),
    inK: toK(u.input + u.cacheRead + u.cacheWrite),
    out: String(u.output),
    outK: toK(u.output),
    total: String(u.total),
    totalK: toK(u.total),
    cacheRead: String(u.cacheRead),
    cacheReadK: toK(u.cacheRead),
    cacheWrite: String(u.cacheWrite),
    cacheWriteK: toK(u.cacheWrite),
    cachePct: String(Math.round(cachePctNum)),
    _pctNum: pctNum
  };
  return vars;
}
function renderTemplate(tmpl, vars) {
  return tmpl.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, key) => {
    if (key in vars) return vars[key];
    return match;
  });
}
function buildFooter(entry, config) {
  const win = resolveContextWindow(entry.model, config.modelContextWindows, config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW);
  const vars = buildVars(entry, win);
  const locale = config.locale === "zh-TW" ? "zh-TW" : "en";
  const defaults = DEFAULT_FORMATS[locale];
  const format = config.format ?? defaults.format;
  const warnFormat = config.contextWarnFormat ?? defaults.warn;
  const mainLine = renderTemplate(format, vars);
  if (vars._pctNum > config.contextWarnThreshold) {
    const warnLine = renderTemplate(warnFormat, vars);
    return `${mainLine}
${warnLine}`;
  }
  return mainLine;
}
var UsageStash = class {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
  }
  ttlMs;
  byKey = /* @__PURE__ */ new Map();
  set(keys, entry) {
    this.gc();
    for (const k of keys) if (k) this.byKey.set(k, entry);
  }
  get(keys) {
    this.gc();
    for (const k of keys) {
      if (!k) continue;
      const e = this.byKey.get(k);
      if (e && Date.now() - e.ts < this.ttlMs) return e;
    }
    return null;
  }
  size() {
    return this.byKey.size;
  }
  clear() {
    this.byKey.clear();
  }
  gc() {
    const now = Date.now();
    for (const [k, v] of this.byKey) {
      if (now - v.ts >= this.ttlMs) this.byKey.delete(k);
    }
  }
};
function trimToCap(content, footer, cap) {
  const joined = `${content.trimEnd()}

${footer}`;
  if (joined.length <= cap) return joined;
  const fixed = `

${footer}`;
  const bodyBudget = cap - fixed.length;
  if (bodyBudget <= 0) {
    return fixed.trim().slice(0, Math.max(0, cap));
  }
  const ellipsis = "\u2026";
  const truncated = content.slice(0, Math.max(0, bodyBudget - ellipsis.length)).trimEnd() + ellipsis;
  return `${truncated}${fixed}`;
}
function applyFooter(content, footer, cap) {
  if (!footer) return content;
  if (typeof cap === "number" && cap > 0) return trimToCap(content, footer, cap);
  return `${content.trimEnd()}

${footer}`;
}
function register(api) {
  const anyApi = api;
  const config = anyApi.pluginConfig ?? (anyApi.id && anyApi.config?.plugins?.entries?.[anyApi.id]?.config) ?? api.getConfig?.() ?? {};
  const ttlMs = typeof config.usageTtlMs === "number" && config.usageTtlMs > 0 ? config.usageTtlMs : DEFAULT_TTL_MS;
  const threshold = typeof config.contextWarnThreshold === "number" ? config.contextWarnThreshold : DEFAULT_WARN_THRESHOLD;
  const skipAgents = new Set(config.skipAgents ?? []);
  const skipChannels = new Set(config.skipChannels ?? []);
  const cap = typeof config.maxMessageLength === "number" && config.maxMessageLength > 0 ? config.maxMessageLength : void 0;
  const locale = config.locale === "zh-TW" ? "zh-TW" : "en";
  const stash = new UsageStash(ttlMs);
  if (typeof api.on !== "function") {
    warn("api.on not available on this host \u2014 plugin disabled");
    return;
  }
  api.on(
    "llm_output",
    (event, ctx) => {
      const ev = event;
      const cx = ctx;
      if (cx?.agentId && skipAgents.has(cx.agentId)) return;
      if (cx?.channelId && skipChannels.has(cx.channelId)) return;
      const usage = normalizeUsage(ev?.usage);
      if (!usage) return;
      const entry = {
        usage,
        model: ev.model ?? "unknown",
        provider: ev.provider ?? "unknown",
        ts: Date.now()
      };
      const keys = [];
      if (cx?.sessionKey) keys.push(`session:${cx.sessionKey}`);
      if (cx?.runId) keys.push(`run:${cx.runId}`);
      if (cx?.agentId) keys.push(`agent:${cx.agentId}`);
      if (cx?.channelId) keys.push(`channel:${cx.channelId}`);
      stash.set(keys, entry);
    }
  );
  api.on(
    "message_sending",
    (event, ctx) => {
      const ev = event;
      const cx = ctx;
      const chan = cx?.channelId ?? ev?.metadata?.channel;
      if (chan && skipChannels.has(chan)) return;
      const keys = [];
      if (chan) keys.push(`channel:${chan}`);
      const entry = stash.get(keys);
      if (!entry) return;
      const footer = buildFooter(entry, { ...config, contextWarnThreshold: threshold });
      const originalContent = typeof ev.content === "string" ? ev.content : "";
      const nextContent = applyFooter(originalContent, footer, cap);
      return { content: nextContent };
    },
    { priority: 100 }
  );
  log(`v1.0 init: ttlMs=${ttlMs}, threshold=${threshold}%, locale=${locale}, skipAgents=[${[...skipAgents].join(",")}], skipChannels=[${[...skipChannels].join(",")}], cap=${cap ?? "none"}`);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  UsageStash,
  applyFooter,
  buildFooter,
  buildVars,
  normalizeUsage,
  renderTemplate,
  resolveContextWindow
});
