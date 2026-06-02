/**
 * token-footer-injector v6.0 — OpenClaw plugin
 *
 * Reads authoritative token usage from OpenClaw's session store
 * (~/.openclaw/agents/<agentId>/sessions/sessions.json) so the footer
 * matches the output of `/status` exactly.
 *
 * At llm_output time, session store may not yet reflect the current turn
 * (persist happens after the hook fires), so event input is used only as a
 * context-usage fallback. Stored inputTokens are cumulative API prompt tokens
 * and must never be used as context usage.
 *
 * Footer format mirrors OpenClaw's formatTokenCount:
 *   📊 qwen3.6-plus | 40k/2.0m (2%) · 198→894k tokens · cache 0
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RawUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  [key: string]: unknown;
}

interface NormalizedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface StoredEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  contextTokens?: number;
  model?: string;
  modelProvider?: string;
  updatedAt?: number;
  [key: string]: unknown;
}

interface SessionMatch {
  agentId?: string;
  sessionKey: string;
  entry: StoredEntry;
}

interface TrackedSession {
  agentId?: string;
  sessionKey: string;
  channelId?: string;
  ts: number;
}

interface PluginConfig {
  maxMessageLength?: number;
  skipAgents?: string[];
  skipChannels?: string[];
  debug?: boolean;
}

interface LlmOutputEvent {
  runId?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  assistantTexts?: string[];
  lastAssistant?: { text?: string; [key: string]: unknown } | null;
  usage?: RawUsage;
}

interface LlmOutputCtx {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  channelId?: string;
}

interface MessageSendingEvent {
  content?: string;
  metadata?: { channel?: string; [key: string]: unknown };
}

interface MessageSendingCtx {
  agentId?: string;
  channelId?: string;
  sessionKey?: string;
  sessionId?: string;
  conversationId?: string;
}

interface MessageSendingResult {
  content?: string;
  cancel?: boolean;
}

interface OpenClawApi {
  on(event: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }): void;
  getConfig?(): PluginConfig;
}

// ---------------------------------------------------------------------------
// Context-window fallback (used only if entry.contextTokens is missing)
// ---------------------------------------------------------------------------

const CONTEXT_WINDOWS: Record<string, number> = {
  "qwen3.6-plus": 2_048_000,
  "qwen3-coder-next": 262_144,
  "qwen3-max": 131_072,
  "claude-sonnet-4": 200_000,
  "claude-opus-4": 200_000,
  "gpt-5": 400_000,
  "gemini-2.5-pro": 1_048_576,
  "glm-5": 256_000,
  "mimo-v2.5-pro": 1_048_576,
};

function getContextWindow(model: string): number {
  const short = model.replace(/^.*\//, "");
  for (const [key, val] of Object.entries(CONTEXT_WINDOWS)) {
    if (short.includes(key) || key.includes(short)) return val;
  }
  if (/qwen/i.test(short)) return 1_048_576;
  if (/claude/i.test(short)) return 200_000;
  if (/gpt/i.test(short)) return 400_000;
  if (/gemini/i.test(short)) return 1_048_576;
  return 200_000;
}

// ---------------------------------------------------------------------------
// Session store lookup
// ---------------------------------------------------------------------------

function resolveStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  if (override) return override;
  const home = process.env.OPENCLAW_HOME?.trim() || os.homedir();
  return path.join(home, ".openclaw");
}

function resolveSessionStorePath(agentId: string | undefined): string {
  return path.join(resolveStateDir(), "agents", (agentId ?? "main").trim() || "main", "sessions", "sessions.json");
}

function readSessionStore(agentId: string | undefined): Record<string, StoredEntry> {
  const storePath = resolveSessionStorePath(agentId);
  if (!fs.existsSync(storePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, StoredEntry>;
  } catch {
    return {};
  }
}

function readSessionEntry(agentId: string | undefined, sessionKey: string): StoredEntry | null {
  if (!sessionKey) return null;
  const store = readSessionStore(agentId);
  const direct = store[sessionKey];
  if (direct) return direct;
  const normalized = sessionKey.toLowerCase().trim();
  let best: StoredEntry | null = null;
  let bestTs = 0;
  for (const [k, v] of Object.entries(store)) {
    if (k.toLowerCase() !== normalized) continue;
    const ts = v?.updatedAt ?? 0;
    if (!best || ts > bestTs) { best = v; bestTs = ts; }
  }
  return best;
}

function inferAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  const match = typeof sessionKey === "string" ? /^agent:([^:]+):/.exec(sessionKey) : null;
  return match?.[1];
}

function candidateAgentIds(agentId: string | undefined, sessionKey: string | undefined): string[] {
  const ids = [agentId, inferAgentIdFromSessionKey(sessionKey), "main"].filter((v): v is string => !!v && v.trim().length > 0);
  return [...new Set(ids)];
}

function readSessionMatch(agentId: string | undefined, sessionKey: string): SessionMatch | null {
  for (const id of candidateAgentIds(agentId, sessionKey)) {
    const entry = readSessionEntry(id, sessionKey);
    if (entry) return { agentId: id, sessionKey, entry };
  }
  return null;
}

function findSessionMatch(agentId: string | undefined, opts: { sessionKey?: string; conversationId?: string; channelId?: string }): SessionMatch | null {
  if (opts.sessionKey) {
    const exact = readSessionMatch(agentId, opts.sessionKey);
    if (exact) return exact;
  }
  const convId = opts.conversationId ? String(opts.conversationId) : "";
  const channel = opts.channelId ? String(opts.channelId) : "";
  let best: SessionMatch | null = null;
  let bestTs = 0;
  for (const id of candidateAgentIds(agentId, opts.sessionKey)) {
    const store = readSessionStore(id);
    for (const [key, entry] of Object.entries(store)) {
      if (opts.sessionKey && key.toLowerCase() !== opts.sessionKey.toLowerCase()) continue;
      if (convId && !key.includes(convId)) continue;
      if (channel && !key.includes(channel)) continue;
      const ts = entry?.updatedAt ?? 0;
      if (!best || ts > bestTs) { best = { agentId: id, sessionKey: key, entry }; bestTs = ts; }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Usage normalization + number formatting (mirrors OpenClaw formatTokenCount)
// ---------------------------------------------------------------------------

function toNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function normalizeUsage(raw: RawUsage | undefined | null): NormalizedUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const input = toNum(raw.input) || toNum(raw.input_tokens) || toNum(raw.prompt_tokens);
  const output = toNum(raw.output) || toNum(raw.output_tokens) || toNum(raw.completion_tokens);
  const cacheRead = toNum(raw.cacheRead) || toNum(raw.cache_read_input_tokens) || toNum(raw.cacheReadTokens);
  const cacheWrite = toNum(raw.cacheWrite) || toNum(raw.cache_creation_input_tokens) || toNum(raw.cacheWriteTokens);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null;
  return { input, output, cacheRead, cacheWrite };
}

function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const safe = Math.max(0, value);
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(1)}m`;
  if (safe >= 1000) {
    const precision = safe >= 10_000 ? 0 : 1;
    const formatted = (safe / 1000).toFixed(precision);
    if (Number(formatted) >= 1000) return `${(safe / 1_000_000).toFixed(1)}m`;
    return `${formatted}k`;
  }
  return String(Math.round(safe));
}

// ---------------------------------------------------------------------------
// Footer builder
// ---------------------------------------------------------------------------

function buildFooter(params: {
  entry: StoredEntry | null;
  override?: NormalizedUsage | null;
  fallbackModel?: string;
}): string | null {
  const { entry, override, fallbackModel } = params;

  const modelFull = entry?.modelProvider && entry?.model
    ? `${entry.modelProvider}/${entry.model}`
    : entry?.model ?? fallbackModel ?? "unknown";
  const modelShort = modelFull.replace(/^.*\//, "");

  const storedTotal = typeof entry?.totalTokens === "number" && entry.totalTokens > 0
    ? entry.totalTokens
    : 0;
  const hasFreshStoredContext = storedTotal > 0;

  const input = hasFreshStoredContext && typeof entry?.inputTokens === "number"
    ? entry.inputTokens
    : override?.input ?? 0;
  const output = hasFreshStoredContext && typeof entry?.outputTokens === "number"
    ? entry.outputTokens
    : override?.output ?? 0;
  const cacheRead = hasFreshStoredContext && typeof entry?.cacheRead === "number"
    ? entry.cacheRead
    : override?.cacheRead ?? 0;
  const cacheWrite = hasFreshStoredContext && typeof entry?.cacheWrite === "number"
    ? entry.cacheWrite
    : override?.cacheWrite ?? 0;

  const window = (entry?.contextTokens && entry.contextTokens > 0)
    ? entry.contextTokens
    : getContextWindow(modelFull);

  // Context usage must match /status: use entry.totalTokens when present.
  // If the store is not updated yet, event input is the least-wrong fallback;
  // stored inputTokens are cumulative billing/prompt tokens, not context used.
  const usage = storedTotal || override?.input || 0;

  if (usage === 0 && input === 0 && output === 0) return null;

  const pct = window > 0 ? Math.min(999, Math.round((usage / window) * 100)) : 0;

  return `📊 ${modelShort} | ${formatTokenCount(usage)}/${formatTokenCount(window)} (${pct}%) · ${formatTokenCount(input)}→${formatTokenCount(output)} tokens · cache ${formatTokenCount(cacheRead)}`;
}

// ---------------------------------------------------------------------------
// Text mutation helpers
// ---------------------------------------------------------------------------

const FOOTER_RE = /\n*📊 [^\n]*\|[^\n]*\([^\n]*%\)[^\n]*tokens[^\n]*cache[^\n]*$/;

function stripExistingFooter(text: string): string {
  return text.replace(FOOTER_RE, "").trimEnd();
}

function appendFooter(text: string, footer: string, cap?: number): string {
  const cleaned = stripExistingFooter(text);
  const joined = `${cleaned}\n\n${footer}`;
  if (cap && joined.length > cap) {
    return cleaned;
  }
  return joined;
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default function register(api: OpenClawApi): void {
  const anyApi = api as Record<string, unknown> & {
    pluginConfig?: PluginConfig;
    config?: { plugins?: { entries?: Record<string, { config?: PluginConfig }> } };
    id?: string;
  };
  const config: PluginConfig =
    anyApi.pluginConfig
    ?? (anyApi.id && anyApi.config?.plugins?.entries?.[anyApi.id]?.config)
    ?? api.getConfig?.()
    ?? {};

  const skipAgents = new Set(config.skipAgents ?? []);
  const skipChannels = new Set(config.skipChannels ?? []);
  const cap = typeof config.maxMessageLength === "number" && config.maxMessageLength > 0 ? config.maxMessageLength : undefined;
  const debug = config.debug === true;

  const log = (msg: string) => console.error(`[token-footer-injector] ${msg}`);
  const warn = (msg: string) => console.warn(`[token-footer-injector] WARN: ${msg}`);

  if (typeof api.on !== "function") {
    warn("api.on not available — plugin disabled");
    return;
  }

  // Track recent sessionKeys so message_sending can find the same session even
  // when the hook context omits agentId/sessionKey.
  const lastSessionByAgent = new Map<string, string>();
  const lastSessionByChannel = new Map<string, TrackedSession>();
  let lastSessionGlobal: TrackedSession | null = null;
  const rememberSession = (cx: LlmOutputCtx, sessionKey: string) => {
    if (!sessionKey) return;
    const tracked: TrackedSession = {
      agentId: cx?.agentId,
      sessionKey,
      channelId: cx?.channelId,
      ts: Date.now(),
    };
    if (cx?.agentId) lastSessionByAgent.set(cx.agentId, sessionKey);
    if (cx?.channelId) lastSessionByChannel.set(`${cx.agentId ?? ""}:${cx.channelId}`, tracked);
    lastSessionGlobal = tracked;
  };
  const recentSessionKey = (tracked: TrackedSession | null | undefined): string => {
    if (!tracked) return "";
    return Date.now() - tracked.ts <= 120_000 ? tracked.sessionKey : "";
  };

  // llm_output: event usage is fallback only; the session store matches /status
  api.on("llm_output", (event: unknown, ctx: unknown) => {
    const ev = event as LlmOutputEvent;
    const cx = ctx as LlmOutputCtx;
    if (cx?.agentId && skipAgents.has(cx.agentId)) return;
    if (cx?.channelId && skipChannels.has(cx.channelId)) return;

    const override = normalizeUsage(ev?.usage);
    if (!override) { if (debug) log(`llm_output SKIP: no usage`); return; }

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

  // message_sending: persist has run, session store is authoritative
  api.on("message_sending", (event: unknown, ctx: unknown): MessageSendingResult | void => {
    const ev = event as MessageSendingEvent;
    const cx = ctx as MessageSendingCtx;
    const chan = cx?.channelId ?? ev?.metadata?.channel ?? "";
    if (chan && skipChannels.has(chan)) return;
    const minLen = (config as any)?.["message-sending"]?.minLen ?? 25;
    if (!ev?.content || ev.content.length < minLen) { if (debug) log(`message_sending MISS: ${ev?.content?.length ?? 0} < ${minLen}`); return; }

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
    if (!sess && !match) { if (debug) log(`message_sending SKIP: no sessionKey (chan=${chan} convId=${cx?.conversationId ?? "?"})`); return; }
    if (!match) { if (debug) log(`message_sending SKIP: no entry for ${sess}`); return; }

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
