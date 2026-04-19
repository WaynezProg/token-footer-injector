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
  extractHostContextWindows: () => extractHostContextWindows,
  isAnthropicStyleUsage: () => isAnthropicStyleUsage,
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
  "gpt-5.4-mini": 2e5,
  "gpt-5.4": 2e5,
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
function isAnthropicStyleUsage(provider, usage) {
  if (usage.cacheRead > usage.input) return true;
  if (!provider) return false;
  const p = provider.toLowerCase();
  return p === "anthropic" || p === "claude-cli" || p === "claude-code" || p.startsWith("claude") || p === "openai-codex" || p === "kimi" || p === "minimax-portal";
}
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
function extractHostContextWindows(hostConfig) {
  const out = {};
  if (!hostConfig || typeof hostConfig !== "object") return out;
  const providers = hostConfig?.models?.providers;
  if (!providers || typeof providers !== "object") return out;
  for (const [provId, prov] of Object.entries(providers)) {
    const models = prov?.models;
    if (!Array.isArray(models)) continue;
    for (const m of models) {
      if (!m || typeof m !== "object") continue;
      const mm = m;
      if (typeof mm.id !== "string") continue;
      if (typeof mm.contextWindow !== "number" || !Number.isFinite(mm.contextWindow)) continue;
      out[mm.id] = mm.contextWindow;
      out[`${provId}/${mm.id}`] = mm.contextWindow;
    }
  }
  return out;
}
function resolveContextWindow(model, overrides, fallback, hostMap) {
  const tiers = [
    overrides,
    hostMap,
    DEFAULT_MODEL_CONTEXT_WINDOWS
  ];
  for (const tier of tiers) {
    if (!tier) continue;
    if (tier[model]) return tier[model];
    let best = 0;
    let bestLen = 0;
    for (const key of Object.keys(tier)) {
      if (model.startsWith(key) && key.length > bestLen) {
        best = tier[key];
        bestLen = key.length;
      }
    }
    if (best > 0) return best;
  }
  return fallback;
}
function toK(n) {
  if (n < 1e3) return "0";
  const k = n / 1e3;
  return k < 10 ? k.toFixed(1) : String(Math.round(k));
}
function buildVars(entry, contextWindow) {
  const u = entry.usage;
  const anthropicStyle = isAnthropicStyleUsage(entry.provider, u);
  const used = anthropicStyle ? u.input + u.cacheRead + u.cacheWrite : u.input;
  const cacheDenom = anthropicStyle ? u.input + u.cacheRead + u.cacheWrite : u.input;
  const pctNum = contextWindow > 0 ? used / contextWindow * 100 : 0;
  const cachePctNum = cacheDenom > 0 ? u.cacheRead / cacheDenom * 100 : 0;
  const vars = {
    model: entry.model || "unknown",
    used: String(used),
    usedK: toK(used),
    max: String(contextWindow),
    maxK: String(Math.round(contextWindow / 1e3)),
    pct: String(Math.round(pctNum)),
    in: String(u.input),
    inK: toK(used),
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
function buildFooter(entry, config, hostMap) {
  const win = resolveContextWindow(
    entry.model,
    config.modelContextWindows,
    config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    hostMap
  );
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
  const debug = config.debug === true;
  const hostMap = extractHostContextWindows(anyApi.config);
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
      if (debug) log(`llm_output FIRE agentId=${cx?.agentId} channelId=${cx?.channelId} sessionKey=${cx?.sessionKey} model=${ev?.model} usage=${JSON.stringify(ev?.usage)}`);
      if (cx?.agentId && skipAgents.has(cx.agentId)) return;
      if (cx?.channelId && skipChannels.has(cx.channelId)) return;
      const usage = normalizeUsage(ev?.usage);
      if (!usage) {
        if (debug) log(`llm_output SKIP: usage could not be normalized`);
        return;
      }
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
      if (debug) log(`llm_output STASH keys=[${keys.join(",")}] size=${stash.size()}`);
      const footer = buildFooter(entry, { ...config, contextWarnThreshold: threshold }, hostMap);
      if (!footer) return;
      const firstLine = footer.split("\n", 1)[0];
      const texts = ev.assistantTexts;
      const tail = Array.isArray(texts) && texts.length > 0 ? texts[texts.length - 1] : void 0;
      if (typeof tail === "string" && !tail.includes(firstLine)) {
        const next = applyFooter(tail, footer, cap);
        texts[texts.length - 1] = next;
        if (ev.lastAssistant && typeof ev.lastAssistant === "object" && typeof ev.lastAssistant.text === "string" && !ev.lastAssistant.text.includes(firstLine)) {
          ev.lastAssistant.text = applyFooter(ev.lastAssistant.text, footer, cap);
        }
        if (debug) log(`llm_output MUTATE assistantTexts[last] appended footer`);
      } else if (debug) {
        log(`llm_output MUTATE skip: tail already contains footer or no tail text`);
      }
    }
  );
  api.on(
    "message_sending",
    (event, ctx) => {
      const ev = event;
      const cx = ctx;
      const chan = cx?.channelId ?? ev?.metadata?.channel;
      if (debug) log(`message_sending FIRE to=${ev?.to} channelId=${cx?.channelId} metaChannel=${ev?.metadata?.channel} accountId=${cx?.accountId} contentLen=${ev?.content?.length ?? 0}`);
      if (chan && skipChannels.has(chan)) return;
      const keys = [];
      if (chan) keys.push(`channel:${chan}`);
      const entry = stash.get(keys);
      if (!entry) {
        if (debug) log(`message_sending MISS: no stash entry for keys=[${keys.join(",")}], stashSize=${stash.size()}`);
        return;
      }
      const footer = buildFooter(entry, { ...config, contextWarnThreshold: threshold }, hostMap);
      const originalContent = typeof ev.content === "string" ? ev.content : "";
      const firstLine = footer.split("\n", 1)[0];
      if (originalContent.includes(firstLine)) {
        if (debug) log(`message_sending SKIP: content already contains footer`);
        return;
      }
      const nextContent = applyFooter(originalContent, footer, cap);
      if (debug) log(`message_sending APPEND: footer='${firstLine}' appended`);
      return { content: nextContent };
    },
    { priority: 100 }
  );
  const hostMapCount = Object.keys(hostMap).length;
  log(`v1.0.4 init: ttlMs=${ttlMs}, threshold=${threshold}%, locale=${locale}, skipAgents=[${[...skipAgents].join(",")}], skipChannels=[${[...skipChannels].join(",")}], cap=${cap ?? "none"}, debug=${debug}, hostContextWindows=${hostMapCount}`);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  UsageStash,
  applyFooter,
  buildFooter,
  buildVars,
  extractHostContextWindows,
  isAnthropicStyleUsage,
  normalizeUsage,
  renderTemplate,
  resolveContextWindow
});
