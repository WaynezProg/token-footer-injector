var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// index.ts
var index_exports = {};
__export(index_exports, {
  default: () => register
});
module.exports = __toCommonJS(index_exports);
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
var os = __toESM(require("node:os"));
var CONTEXT_WINDOWS = {
  "qwen3.6-plus": 2048e3,
  "qwen3-coder-next": 262144,
  "qwen3-max": 131072,
  "claude-sonnet-4": 2e5,
  "claude-opus-4": 2e5,
  "gpt-5": 4e5,
  "gemini-2.5-pro": 1048576,
  "glm-5": 256e3,
  "mimo-v2.5-pro": 1048576
};
function getContextWindow(model) {
  const short = model.replace(/^.*\//, "");
  for (const [key, val] of Object.entries(CONTEXT_WINDOWS)) {
    if (short.includes(key) || key.includes(short)) return val;
  }
  if (/qwen/i.test(short)) return 1048576;
  if (/claude/i.test(short)) return 2e5;
  if (/gpt/i.test(short)) return 4e5;
  if (/gemini/i.test(short)) return 1048576;
  return 2e5;
}
function resolveStateDir() {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  if (override) return override;
  const home = process.env.OPENCLAW_HOME?.trim() || os.homedir();
  return path.join(home, ".openclaw");
}
function resolveSessionStorePath(agentId) {
  return path.join(resolveStateDir(), "agents", (agentId ?? "main").trim() || "main", "sessions", "sessions.json");
}
function readSessionStore(agentId) {
  const storePath = resolveSessionStorePath(agentId);
  if (!fs.existsSync(storePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(storePath, "utf8"));
  } catch {
    return {};
  }
}
function readSessionEntry(agentId, sessionKey) {
  if (!sessionKey) return null;
  const store = readSessionStore(agentId);
  const direct = store[sessionKey];
  if (direct) return direct;
  const normalized = sessionKey.toLowerCase().trim();
  let best = null;
  let bestTs = 0;
  for (const [k, v] of Object.entries(store)) {
    if (k.toLowerCase() !== normalized) continue;
    const ts = v?.updatedAt ?? 0;
    if (!best || ts > bestTs) {
      best = v;
      bestTs = ts;
    }
  }
  return best;
}
function inferAgentIdFromSessionKey(sessionKey) {
  const match = typeof sessionKey === "string" ? /^agent:([^:]+):/.exec(sessionKey) : null;
  return match?.[1];
}
function candidateAgentIds(agentId, sessionKey) {
  const ids = [agentId, inferAgentIdFromSessionKey(sessionKey), "main"].filter((v) => !!v && v.trim().length > 0);
  return [...new Set(ids)];
}
function readSessionMatch(agentId, sessionKey) {
  for (const id of candidateAgentIds(agentId, sessionKey)) {
    const entry = readSessionEntry(id, sessionKey);
    if (entry) return { agentId: id, sessionKey, entry };
  }
  return null;
}
function findSessionMatch(agentId, opts) {
  if (opts.sessionKey) {
    const exact = readSessionMatch(agentId, opts.sessionKey);
    if (exact) return exact;
  }
  const convId = opts.conversationId ? String(opts.conversationId) : "";
  const channel = opts.channelId ? String(opts.channelId) : "";
  let best = null;
  let bestTs = 0;
  for (const id of candidateAgentIds(agentId, opts.sessionKey)) {
    const store = readSessionStore(id);
    for (const [key, entry] of Object.entries(store)) {
      if (opts.sessionKey && key.toLowerCase() !== opts.sessionKey.toLowerCase()) continue;
      if (convId && !key.includes(convId)) continue;
      if (channel && !key.includes(channel)) continue;
      const ts = entry?.updatedAt ?? 0;
      if (!best || ts > bestTs) {
        best = { agentId: id, sessionKey: key, entry };
        bestTs = ts;
      }
    }
  }
  return best;
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
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null;
  return { input, output, cacheRead, cacheWrite };
}
function formatTokenCount(value) {
  if (!Number.isFinite(value)) return "0";
  const safe = Math.max(0, value);
  if (safe >= 1e6) return `${(safe / 1e6).toFixed(1)}m`;
  if (safe >= 1e3) {
    const precision = safe >= 1e4 ? 0 : 1;
    const formatted = (safe / 1e3).toFixed(precision);
    if (Number(formatted) >= 1e3) return `${(safe / 1e6).toFixed(1)}m`;
    return `${formatted}k`;
  }
  return String(Math.round(safe));
}
function buildFooter(params) {
  const { entry, override, fallbackModel } = params;
  const modelFull = entry?.modelProvider && entry?.model ? `${entry.modelProvider}/${entry.model}` : entry?.model ?? fallbackModel ?? "unknown";
  const modelShort = modelFull.replace(/^.*\//, "");
  const storedTotal = typeof entry?.totalTokens === "number" && entry.totalTokens > 0 ? entry.totalTokens : 0;
  const hasFreshStoredContext = storedTotal > 0;
  const input = hasFreshStoredContext && typeof entry?.inputTokens === "number" ? entry.inputTokens : override?.input ?? 0;
  const output = hasFreshStoredContext && typeof entry?.outputTokens === "number" ? entry.outputTokens : override?.output ?? 0;
  const cacheRead = hasFreshStoredContext && typeof entry?.cacheRead === "number" ? entry.cacheRead : override?.cacheRead ?? 0;
  const cacheWrite = hasFreshStoredContext && typeof entry?.cacheWrite === "number" ? entry.cacheWrite : override?.cacheWrite ?? 0;
  const window = entry?.contextTokens && entry.contextTokens > 0 ? entry.contextTokens : getContextWindow(modelFull);
  const usage = storedTotal || override?.input || 0;
  if (usage === 0 && input === 0 && output === 0) return null;
  const pct = window > 0 ? Math.min(999, Math.round(usage / window * 100)) : 0;
  return `\u{1F4CA} ${modelShort} | ${formatTokenCount(usage)}/${formatTokenCount(window)} (${pct}%) \xB7 ${formatTokenCount(input)}\u2192${formatTokenCount(output)} tokens \xB7 cache ${formatTokenCount(cacheRead)}`;
}
var FOOTER_RE = /\n*📊 [^\n]*\|[^\n]*\([^\n]*%\)[^\n]*tokens[^\n]*cache[^\n]*$/;
function stripExistingFooter(text) {
  return text.replace(FOOTER_RE, "").trimEnd();
}
function appendFooter(text, footer, cap) {
  const cleaned = stripExistingFooter(text);
  const joined = `${cleaned}

${footer}`;
  if (cap && joined.length > cap) {
    return cleaned;
  }
  return joined;
}
function register(api) {
  const anyApi = api;
  const config = anyApi.pluginConfig ?? (anyApi.id && anyApi.config?.plugins?.entries?.[anyApi.id]?.config) ?? api.getConfig?.() ?? {};
  const skipAgents = new Set(config.skipAgents ?? []);
  const skipChannels = new Set(config.skipChannels ?? []);
  const cap = typeof config.maxMessageLength === "number" && config.maxMessageLength > 0 ? config.maxMessageLength : void 0;
  const debug = config.debug === true;
  const log = (msg) => console.error(`[token-footer-injector] ${msg}`);
  const warn = (msg) => console.warn(`[token-footer-injector] WARN: ${msg}`);
  if (typeof api.on !== "function") {
    warn("api.on not available \u2014 plugin disabled");
    return;
  }
  const lastSessionByAgent = /* @__PURE__ */ new Map();
  const lastSessionByChannel = /* @__PURE__ */ new Map();
  let lastSessionGlobal = null;
  const rememberSession = (cx, sessionKey) => {
    if (!sessionKey) return;
    const tracked = {
      agentId: cx?.agentId,
      sessionKey,
      channelId: cx?.channelId,
      ts: Date.now()
    };
    if (cx?.agentId) lastSessionByAgent.set(cx.agentId, sessionKey);
    if (cx?.channelId) lastSessionByChannel.set(`${cx.agentId ?? ""}:${cx.channelId}`, tracked);
    lastSessionGlobal = tracked;
  };
  const recentSessionKey = (tracked) => {
    if (!tracked) return "";
    return Date.now() - tracked.ts <= 12e4 ? tracked.sessionKey : "";
  };
  api.on("llm_output", (event, ctx) => {
    const ev = event;
    const cx = ctx;
    if (cx?.agentId && skipAgents.has(cx.agentId)) return;
    if (cx?.channelId && skipChannels.has(cx.channelId)) return;
    const override = normalizeUsage(ev?.usage);
    if (!override) {
      if (debug) log(`llm_output SKIP: no usage`);
      return;
    }
    const sess = cx?.sessionKey ?? cx?.sessionId ?? "";
    rememberSession(cx, sess);
    const match = findSessionMatch(cx?.agentId, { sessionKey: sess, channelId: cx?.channelId });
    const footer = buildFooter({ entry: match?.entry ?? null, override, fallbackModel: ev.model });
    if (!footer) return;
    const texts = ev.assistantTexts;
    if (Array.isArray(texts) && texts.length > 0) {
      const idx = texts.length - 1;
      const tail = texts[idx];
      if (typeof tail === "string") {
        texts[idx] = appendFooter(tail, footer, cap);
      }
    }
    if (ev.lastAssistant && typeof ev.lastAssistant === "object" && typeof ev.lastAssistant.text === "string") {
      ev.lastAssistant.text = appendFooter(ev.lastAssistant.text, footer, cap);
    }
    if (debug) log(`llm_output INJECT: ${footer}`);
  });
  api.on("message_sending", (event, ctx) => {
    const ev = event;
    const cx = ctx;
    const chan = cx?.channelId ?? ev?.metadata?.channel ?? "";
    if (chan && skipChannels.has(chan)) return;
    const minLen = config?.["message-sending"]?.minLen ?? 25;
    if (!ev?.content || ev.content.length < minLen) {
      if (debug) log(`message_sending MISS: ${ev?.content?.length ?? 0} < ${minLen}`);
      return;
    }
    let sess = cx?.sessionKey ?? cx?.sessionId ?? "";
    if (!sess && cx?.agentId) {
      sess = lastSessionByAgent.get(cx.agentId) ?? "";
      if (sess && debug) log(`message_sending: fallback sessionKey from llm_output: ${sess}`);
    }
    if (!sess && chan) {
      sess = recentSessionKey(lastSessionByChannel.get(`${cx?.agentId ?? ""}:${chan}`));
      if (sess && debug) log(`message_sending: fallback sessionKey from channel: ${sess}`);
    }
    if (!sess) {
      sess = recentSessionKey(lastSessionGlobal);
      if (sess && debug) log(`message_sending: fallback sessionKey from recent llm_output: ${sess}`);
    }
    let match = findSessionMatch(cx?.agentId, { sessionKey: sess, conversationId: cx?.conversationId, channelId: chan });
    if (!match && cx?.conversationId) {
      match = findSessionMatch(cx?.agentId, { conversationId: cx.conversationId, channelId: chan });
      if (match) {
        sess = match.sessionKey;
        if (debug) log(`message_sending: matched sessionKey by conversationId: ${sess}`);
      }
    }
    if (!sess && !match) {
      if (debug) log(`message_sending SKIP: no sessionKey (chan=${chan} convId=${cx?.conversationId ?? "?"})`);
      return;
    }
    if (!match) {
      if (debug) log(`message_sending SKIP: no entry for ${sess}`);
      return;
    }
    const footer = buildFooter({ entry: match.entry });
    if (!footer) return;
    const original = typeof ev.content === "string" ? ev.content : "";
    if (FOOTER_RE.test(original) && original.includes(footer)) {
      if (debug) log(`message_sending SKIP: footer current`);
      return;
    }
    if (debug) log(`message_sending CORRECTING footer`);
    return { content: appendFooter(original, footer, cap) };
  }, { priority: 100 });
  if (debug) log(`v6.0 init: sessions.json-backed, debug=${debug}`);
}
