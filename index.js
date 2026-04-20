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
  default: () => register
});
module.exports = __toCommonJS(index_exports);
var DEFAULT_TTL_MS = 6e4;
var DEFAULT_CONTEXT_WINDOW = 128e3;
var DEFAULT_NEW_SESSION_THRESHOLD = 70;
var DEFAULT_CONTEXT_WINDOWS = {
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
  "gpt-5.4-mini": 2e5,
  "gpt-5.4": 2e5,
  "gpt-5": 256e3,
  "gpt-4.1": 1e6,
  "gpt-4o": 128e3,
  "gpt-4": 128e3,
  "o1": 2e5,
  "o3": 2e5,
  "qwen3.6-plus": 131072,
  "qwen3-plus": 131072,
  "qwen3-max": 262144,
  "qwen3-": 131072,
  "qwen-": 131072,
  "glm-4.6": 128e3,
  "kimi-k2": 128e3,
  "deepseek-": 128e3,
  "minimax-": 245760
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
  const tiers = [overrides, hostMap, DEFAULT_CONTEXT_WINDOWS];
  for (const tier of tiers) {
    if (!tier) continue;
    if (tier[model]) return tier[model];
    let best = 0, bestLen = 0;
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
var SessionAccumulator = class {
  bySession = /* @__PURE__ */ new Map();
  byChannel = /* @__PURE__ */ new Map();
  // channelId -> sessionKey
  add(sessionKey, channelId, usage, model, provider) {
    let acc = this.bySession.get(sessionKey);
    if (!acc) {
      acc = { sessionKey, model, provider, ts: Date.now(), callCount: 0, totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0 };
      this.bySession.set(sessionKey, acc);
    }
    acc.callCount++;
    acc.totalInput += usage.input;
    acc.totalOutput += usage.output;
    acc.totalCacheRead += usage.cacheRead;
    acc.totalCacheWrite += usage.cacheWrite;
    acc.model = model;
    acc.provider = provider;
    acc.ts = Date.now();
    if (channelId) this.byChannel.set(channelId, sessionKey);
    return acc;
  }
  getBySession(sessionKey) {
    return this.bySession.get(sessionKey) ?? null;
  }
  getByChannel(channelId) {
    const sk = this.byChannel.get(channelId);
    if (!sk) return null;
    return this.bySession.get(sk) ?? null;
  }
  size() {
    return this.bySession.size;
  }
};
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
  if (bodyBudget <= 0) return fixed.trim().slice(0, Math.max(0, cap));
  return content.slice(0, Math.max(0, bodyBudget - 1)).trimEnd() + `\u2026${fixed}`;
}
function applyFooter(content, footer, cap) {
  if (!footer) return content;
  if (typeof cap === "number" && cap > 0) return trimToCap(content, footer, cap);
  return `${content.trimEnd()}

${footer}`;
}
function buildCumulativeFooter(acc, contextWindow, newSessionThreshold, locale) {
  const used = acc.totalCacheRead > 0 ? acc.totalCacheRead : acc.totalInput;
  const pctNum = contextWindow > 0 ? used / contextWindow * 100 : 0;
  const cacheDenom = acc.totalInput + acc.totalCacheRead + acc.totalCacheWrite;
  const cachePctNum = cacheDenom > 0 ? Math.round(acc.totalCacheRead / cacheDenom * 100) : 0;
  const modelShort = acc.model.replace(/^.*\//, "");
  const warn2 = pctNum > newSessionThreshold ? locale === "zh-TW" ? ` \u26A0\uFE0F \u5EFA\u8B70 /new` : ` \u26A0\uFE0F /new` : "";
  const line1 = `\u{1F4CA} ${modelShort}\uFF5C${toK(used)}k/${Math.round(contextWindow / 1e3)}k (${Math.round(pctNum)}%) \xB7 ${acc.callCount} \u8F2A${warn2}`;
  const line2 = `  in ${toK(acc.totalInput)}k \xB7 out ${toK(acc.totalOutput)}k \xB7 cache ${cachePctNum}%`;
  return { footer: `${line1}
${line2}`, pctNum };
}
function register(api) {
  const anyApi = api;
  const config = anyApi.pluginConfig ?? (anyApi.id && anyApi.config?.plugins?.entries?.[anyApi.id]?.config) ?? api.getConfig?.() ?? {};
  const ttlMs = typeof config.usageTtlMs === "number" && config.usageTtlMs > 0 ? config.usageTtlMs : DEFAULT_TTL_MS;
  const newSessionTh = typeof config.newSessionThreshold === "number" ? config.newSessionThreshold : DEFAULT_NEW_SESSION_THRESHOLD;
  const skipAgents = new Set(config.skipAgents ?? []);
  const skipChannels = new Set(config.skipChannels ?? []);
  const cap = typeof config.maxMessageLength === "number" && config.maxMessageLength > 0 ? config.maxMessageLength : void 0;
  const locale = config.locale === "zh-TW" ? "zh-TW" : "en";
  const debug = config.debug === true;
  const cumulative = config.cumulative !== false;
  const hostMap = extractHostContextWindows(anyApi.config);
  const stash = new UsageStash(ttlMs);
  const accumulator = new SessionAccumulator();
  if (typeof api.on !== "function") {
    warn("api.on not available \u2014 plugin disabled");
    return;
  }
  api.on("llm_output", (event, ctx) => {
    const ev = event;
    const cx = ctx;
    if (debug) log(`llm_output FIRE sessionKey=${cx?.sessionKey} channelId=${cx?.channelId} model=${ev?.model}`);
    if (cx?.agentId && skipAgents.has(cx.agentId)) return;
    if (cx?.channelId && skipChannels.has(cx.channelId)) return;
    const usage = normalizeUsage(ev?.usage);
    if (!usage) {
      if (debug) log(`llm_output SKIP: no normalized usage`);
      return;
    }
    const model = ev.model ?? "unknown";
    const provider = ev.provider ?? "unknown";
    if (cx?.sessionKey && cumulative) {
      const acc = accumulator.add(cx.sessionKey, cx.channelId ?? "", usage, model, provider);
      if (debug) log(`llm_output ACCUM session=${cx.sessionKey} calls=${acc.callCount} totalIn=${acc.totalInput} totalOut=${acc.totalOutput}`);
    }
    const entry = { usage, model, provider, ts: Date.now(), consumed: false };
    const keys = [];
    if (cx?.sessionKey) keys.push(`session:${cx.sessionKey}`);
    if (cx?.runId) keys.push(`run:${cx.runId}`);
    if (cx?.agentId) keys.push(`agent:${cx.agentId}`);
    if (cx?.channelId) keys.push(`channel:${cx.channelId}`);
    stash.set(keys, entry);
    if (cumulative && cx?.sessionKey) {
      const acc = accumulator.getBySession(cx.sessionKey);
      if (acc) {
        const cw = resolveContextWindow(acc.model, config.modelContextWindows, config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW, hostMap);
        const { footer } = buildCumulativeFooter(acc, cw, newSessionTh, locale);
        if (footer) {
          const firstLine = footer.split("\n", 1)[0];
          const texts = ev.assistantTexts;
          const tail = Array.isArray(texts) && texts.length > 0 ? texts[texts.length - 1] : void 0;
          if (typeof tail === "string" && !tail.includes(firstLine)) {
            texts[texts.length - 1] = applyFooter(tail, footer, cap);
            if (ev.lastAssistant && typeof ev.lastAssistant === "object" && typeof ev.lastAssistant.text === "string" && !ev.lastAssistant.text.includes(firstLine)) {
              ev.lastAssistant.text = applyFooter(ev.lastAssistant.text, footer, cap);
            }
            if (debug) log(`llm_output MUTATE cumulative footer appended`);
          }
        }
      }
    } else if (!cumulative) {
      const cw = resolveContextWindow(model, config.modelContextWindows, config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW, hostMap);
      const used = usage.cacheRead > 0 ? usage.cacheRead : usage.input;
      const pctNum = cw > 0 ? used / cw * 100 : 0;
      const cacheDenom = usage.input + usage.cacheRead + usage.cacheWrite;
      const cachePct = cacheDenom > 0 ? Math.round(usage.cacheRead / cacheDenom * 100) : 0;
      const modelShort = model.replace(/^.*\//, "");
      const footer = `\u{1F4CA} ${modelShort}\uFF5C${toK(used)}k/${Math.round(cw / 1e3)}k (${Math.round(pctNum)}%) \xB7 ${toK(usage.input)}\u2192${toK(usage.output)}k \xB7 cache ${cachePct}%`;
      const firstLine = footer.split("\n", 1)[0];
      const texts = ev.assistantTexts;
      const tail = Array.isArray(texts) && texts.length > 0 ? texts[texts.length - 1] : void 0;
      if (typeof tail === "string" && !tail.includes(firstLine)) {
        texts[texts.length - 1] = applyFooter(tail, footer, cap);
        if (ev.lastAssistant && typeof ev.lastAssistant === "object" && typeof ev.lastAssistant.text === "string" && !ev.lastAssistant.text.includes(firstLine)) {
          ev.lastAssistant.text = applyFooter(ev.lastAssistant.text, footer, cap);
        }
      }
    }
  });
  api.on("message_sending", (event, ctx) => {
    const ev = event;
    const cx = ctx;
    const chan = cx?.channelId ?? ev?.metadata?.channel;
    if (debug) log(`message_sending FIRE channelId=${chan}`);
    if (chan && skipChannels.has(chan)) return;
    let footer = null;
    if (cumulative) {
      const acc = accumulator.getByChannel(chan ?? "");
      if (acc) {
        const cw = resolveContextWindow(acc.model, config.modelContextWindows, config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW, hostMap);
        footer = buildCumulativeFooter(acc, cw, newSessionTh, locale).footer;
      }
    }
    if (!footer) {
      const keys2 = [];
      if (chan) keys2.push(`channel:${chan}`);
      const entry2 = stash.get(keys2);
      if (!entry2) {
        if (debug) log(`message_sending MISS`);
        return;
      }
      const cw = resolveContextWindow(entry2.model, config.modelContextWindows, config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW, hostMap);
      const used = entry2.usage.cacheRead > 0 ? entry2.usage.cacheRead : entry2.usage.input;
      const pctNum = cw > 0 ? used / cw * 100 : 0;
      const cacheDenom = entry2.usage.input + entry2.usage.cacheRead + entry2.usage.cacheWrite;
      const cachePct = cacheDenom > 0 ? Math.round(entry2.usage.cacheRead / cacheDenom * 100) : 0;
      const modelShort = entry2.model.replace(/^.*\//, "");
      footer = `\u{1F4CA} ${modelShort}\uFF5C${toK(used)}k/${Math.round(cw / 1e3)}k (${Math.round(pctNum)}%) \xB7 ${toK(entry2.usage.input)}\u2192${toK(entry2.usage.output)}k \xB7 cache ${cachePct}%`;
    }
    if (!footer) return;
    const originalContent = typeof ev.content === "string" ? ev.content : "";
    const firstLine = footer.split("\n", 1)[0];
    if (originalContent.includes(firstLine)) {
      if (debug) log(`message_sending SKIP: already has footer`);
      return;
    }
    const keys = [];
    if (chan) keys.push(`channel:${chan}`);
    const entry = stash.get(keys);
    if (entry?.consumed) {
      if (debug) log(`message_sending SKIP: consumed`);
      return;
    }
    if (entry) entry.consumed = true;
    return { content: applyFooter(originalContent, footer, cap) };
  }, { priority: 100 });
  log(`v2.0 init: cumulative=${cumulative}, ttlMs=${ttlMs}, newSession=${newSessionTh}%, locale=${locale}, debug=${debug}`);
}
