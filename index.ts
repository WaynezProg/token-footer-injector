/**
 * token-footer-injector v2.0 — OpenClaw plugin
 *
 * Session-cumulative token-usage footer. 100% hit-rate, 0 model tokens.
 *
 * v2.0: cumulative session totals (not per-call), cache% always visible.
 *
 * Flow:
 *   1. `llm_output` fires after each LLM attempt — accumulates usage into a
 *      per-session accumulator AND stashes the latest call for message_sending.
 *   2. `message_sending` fires before outbound delivery — looks up the session
 *      accumulator and appends the cumulative footer.
 */

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
  total: number;
}

interface AccumEntry {
  sessionKey: string;
  model: string;
  provider: string;
  ts: number;
  callCount: number;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
}

interface StashEntry {
  usage: NormalizedUsage;
  model: string;
  provider: string;
  ts: number;
  consumed?: boolean;
}

interface PluginConfig {
  format?: string;
  contextWarnFormat?: string;
  contextWarnThreshold?: number;
  newSessionThreshold?: number;
  modelContextWindows?: Record<string, number>;
  defaultContextWindow?: number;
  skipAgents?: string[];
  skipChannels?: string[];
  maxMessageLength?: number;
  usageTtlMs?: number;
  cumulative?: boolean;
  locale?: "en" | "zh-TW";
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
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
}

interface MessageSendingEvent {
  to?: string;
  content?: string;
  metadata?: {
    channel?: string;
    accountId?: string;
    mediaUrls?: unknown;
    [key: string]: unknown;
  };
}

interface MessageSendingCtx {
  channelId?: string;
  accountId?: string;
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
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_WARN_THRESHOLD = 50;
const DEFAULT_NEW_SESSION_THRESHOLD = 70;

const DEFAULT_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-7[1m]": 1_000_000,
  "claude-opus-4-7": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
  "claude-3-7-sonnet": 200_000,
  "claude-3-5-sonnet": 200_000,
  "claude-3-5-haiku": 200_000,
  "claude-3-opus": 200_000,
  "claude-": 200_000,
  "gpt-5.4-mini": 200_000,
  "gpt-5.4": 200_000,
  "gpt-5": 256_000,
  "gpt-4.1": 1_000_000,
  "gpt-4o": 128_000,
  "gpt-4": 128_000,
  "o1": 200_000,
  "o3": 200_000,
  "qwen3.6-plus": 131_072,
  "qwen3-plus": 131_072,
  "qwen3-max": 262_144,
  "qwen3-": 131_072,
  "qwen-": 131_072,
  "glm-4.6": 128_000,
  "kimi-k2": 128_000,
  "deepseek-": 128_000,
  "minimax-": 245_760,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void { console.log(`[token-footer-injector] ${msg}`); }
function warn(msg: string): void { console.log(`[token-footer-injector] WARN: ${msg}`); }
function toNum(v: unknown): number { return typeof v === "number" && Number.isFinite(v) ? v : 0; }

function normalizeUsage(raw: RawUsage | undefined | null): NormalizedUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const input = toNum(raw.input) || toNum(raw.input_tokens) || toNum(raw.prompt_tokens);
  const output = toNum(raw.output) || toNum(raw.output_tokens) || toNum(raw.completion_tokens);
  const cacheRead = toNum(raw.cacheRead) || toNum(raw.cache_read_input_tokens) || toNum(raw.cacheReadTokens);
  const cacheWrite = toNum(raw.cacheWrite) || toNum(raw.cache_creation_input_tokens) || toNum(raw.cacheWriteTokens);
  const total = toNum(raw.total) || toNum(raw.total_tokens) || input + output;
  if (input === 0 && output === 0 && total === 0) return null;
  return { input, output, cacheRead, cacheWrite, total };
}

function extractHostContextWindows(hostConfig: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!hostConfig || typeof hostConfig !== "object") return out;
  const providers = (hostConfig as { models?: { providers?: Record<string, unknown> } })?.models?.providers;
  if (!providers || typeof providers !== "object") return out;
  for (const [provId, prov] of Object.entries(providers)) {
    const models = (prov as { models?: unknown })?.models;
    if (!Array.isArray(models)) continue;
    for (const m of models) {
      if (!m || typeof m !== "object") continue;
      const mm = m as { id?: unknown; contextWindow?: unknown };
      if (typeof mm.id !== "string") continue;
      if (typeof mm.contextWindow !== "number" || !Number.isFinite(mm.contextWindow)) continue;
      out[mm.id] = mm.contextWindow;
      out[`${provId}/${mm.id}`] = mm.contextWindow;
    }
  }
  return out;
}

function resolveContextWindow(model: string, overrides: Record<string, number> | undefined, fallback: number, hostMap?: Record<string, number>): number {
  const tiers: Array<Record<string, number> | undefined> = [overrides, hostMap, DEFAULT_CONTEXT_WINDOWS];
  for (const tier of tiers) {
    if (!tier) continue;
    if (tier[model]) return tier[model];
    let best = 0, bestLen = 0;
    for (const key of Object.keys(tier)) {
      if (model.startsWith(key) && key.length > bestLen) { best = tier[key]; bestLen = key.length; }
    }
    if (best > 0) return best;
  }
  return fallback;
}

function toK(n: number): string {
  if (n < 1000) return "0";
  const k = n / 1000;
  return k < 10 ? k.toFixed(1) : String(Math.round(k));
}

// ---------------------------------------------------------------------------
// Session Accumulator
// ---------------------------------------------------------------------------

class SessionAccumulator {
  private bySession = new Map<string, AccumEntry>();
  private byChannel = new Map<string, string>(); // channelId -> sessionKey

  add(sessionKey: string, channelId: string, usage: NormalizedUsage, model: string, provider: string): AccumEntry {
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

  getBySession(sessionKey: string): AccumEntry | null {
    return this.bySession.get(sessionKey) ?? null;
  }

  getByChannel(channelId: string): AccumEntry | null {
    const sk = this.byChannel.get(channelId);
    if (!sk) return null;
    return this.bySession.get(sk) ?? null;
  }

  size(): number { return this.bySession.size; }
}

// ---------------------------------------------------------------------------
// Stash (for message_sending fallback)
// ---------------------------------------------------------------------------

class UsageStash {
  private byKey = new Map<string, StashEntry>();
  constructor(private ttlMs: number) {}
  set(keys: string[], entry: StashEntry): void {
    this.gc();
    for (const k of keys) if (k) this.byKey.set(k, entry);
  }
  get(keys: string[]): StashEntry | null {
    this.gc();
    for (const k of keys) { if (!k) continue; const e = this.byKey.get(k); if (e && Date.now() - e.ts < this.ttlMs) return e; }
    return null;
  }
  size(): number { return this.byKey.size; }
  private gc(): void {
    const now = Date.now();
    for (const [k, v] of this.byKey) { if (now - v.ts >= this.ttlMs) this.byKey.delete(k); }
  }
}

// ---------------------------------------------------------------------------
// Footer helpers
// ---------------------------------------------------------------------------

function trimToCap(content: string, footer: string, cap: number): string {
  const joined = `${content.trimEnd()}\n\n${footer}`;
  if (joined.length <= cap) return joined;
  const fixed = `\n\n${footer}`;
  const bodyBudget = cap - fixed.length;
  if (bodyBudget <= 0) return fixed.trim().slice(0, Math.max(0, cap));
  return content.slice(0, Math.max(0, bodyBudget - 1)).trimEnd() + `…${fixed}`;
}

function applyFooter(content: string, footer: string, cap?: number): string {
  if (!footer) return content;
  if (typeof cap === "number" && cap > 0) return trimToCap(content, footer, cap);
  return `${content.trimEnd()}\n\n${footer}`;
}

// ---------------------------------------------------------------------------
// Build cumulative footer
// ---------------------------------------------------------------------------

function buildCumulativeFooter(
  acc: AccumEntry,
  contextWindow: number,
  newSessionThreshold: number,
  locale: "en" | "zh-TW",
): { footer: string; pctNum: number } {
  const used = acc.totalCacheRead > 0 ? acc.totalCacheRead : acc.totalInput;
  const pctNum = contextWindow > 0 ? (used / contextWindow) * 100 : 0;
  const cacheDenom = acc.totalInput + acc.totalCacheRead + acc.totalCacheWrite;
  const cachePctNum = cacheDenom > 0 ? Math.round((acc.totalCacheRead / cacheDenom) * 100) : 0;

  const modelShort = acc.model.replace(/^.*\//, "");
  const warn = pctNum > newSessionThreshold
    ? (locale === "zh-TW" ? ` ⚠️ 建議 /new` : ` ⚠️ /new`)
    : "";

  const line1 = `📊 ${modelShort}｜${toK(used)}k/${Math.round(contextWindow / 1000)}k (${Math.round(pctNum)}%) · ${acc.callCount} 輪${warn}`;
  const line2 = `  in ${toK(acc.totalInput)}k · out ${toK(acc.totalOutput)}k · cache ${cachePctNum}%`;

  return { footer: `${line1}\n${line2}`, pctNum };
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

  const ttlMs = typeof config.usageTtlMs === "number" && config.usageTtlMs > 0 ? config.usageTtlMs : DEFAULT_TTL_MS;
  const newSessionTh = typeof config.newSessionThreshold === "number" ? config.newSessionThreshold : DEFAULT_NEW_SESSION_THRESHOLD;
  const skipAgents = new Set(config.skipAgents ?? []);
  const skipChannels = new Set(config.skipChannels ?? []);
  const cap = typeof config.maxMessageLength === "number" && config.maxMessageLength > 0 ? config.maxMessageLength : undefined;
  const locale: "en" | "zh-TW" = config.locale === "zh-TW" ? "zh-TW" : "en";
  const debug = config.debug === true;
  const cumulative = config.cumulative !== false; // default true

  const hostMap = extractHostContextWindows(anyApi.config);
  const stash = new UsageStash(ttlMs);
  const accumulator = new SessionAccumulator();

  if (typeof api.on !== "function") { warn("api.on not available — plugin disabled"); return; }

  // -------------------------------------------------------------------------
  // llm_output → accumulate + stash + primary injection
  // -------------------------------------------------------------------------
  api.on("llm_output", (event: unknown, ctx: unknown) => {
    const ev = event as LlmOutputEvent;
    const cx = ctx as LlmOutputCtx;
    if (debug) log(`llm_output FIRE sessionKey=${cx?.sessionKey} channelId=${cx?.channelId} model=${ev?.model}`);
    if (cx?.agentId && skipAgents.has(cx.agentId)) return;
    if (cx?.channelId && skipChannels.has(cx.channelId)) return;

    const usage = normalizeUsage(ev?.usage);
    if (!usage) { if (debug) log(`llm_output SKIP: no normalized usage`); return; }

    const model = ev.model ?? "unknown";
    const provider = ev.provider ?? "unknown";

    // Accumulate
    if (cx?.sessionKey && cumulative) {
      const acc = accumulator.add(cx.sessionKey, cx.channelId ?? "", usage, model, provider);
      if (debug) log(`llm_output ACCUM session=${cx.sessionKey} calls=${acc.callCount} totalIn=${acc.totalInput} totalOut=${acc.totalOutput}`);
    }

    // Stash for message_sending fallback
    const entry: StashEntry = { usage, model, provider, ts: Date.now(), consumed: false };
    const keys: string[] = [];
    if (cx?.sessionKey) keys.push(`session:${cx.sessionKey}`);
    if (cx?.runId) keys.push(`run:${cx.runId}`);
    if (cx?.agentId) keys.push(`agent:${cx.agentId}`);
    if (cx?.channelId) keys.push(`channel:${cx.channelId}`);
    stash.set(keys, entry);

    // Primary injection: mutate assistantTexts in place
    if (cumulative && cx?.sessionKey) {
      const acc = accumulator.getBySession(cx.sessionKey);
      if (acc) {
        const cw = resolveContextWindow(acc.model, config.modelContextWindows, config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW, hostMap);
        const { footer } = buildCumulativeFooter(acc, cw, newSessionTh, locale);
        if (footer) {
          const firstLine = footer.split("\n", 1)[0];
          const texts = ev.assistantTexts;
          const tail = Array.isArray(texts) && texts.length > 0 ? texts[texts.length - 1] : undefined;
          if (typeof tail === "string" && !tail.includes(firstLine)) {
            texts![texts!.length - 1] = applyFooter(tail, footer, cap);
            if (ev.lastAssistant && typeof ev.lastAssistant === "object" && typeof ev.lastAssistant.text === "string" && !ev.lastAssistant.text.includes(firstLine)) {
              ev.lastAssistant.text = applyFooter(ev.lastAssistant.text, footer, cap);
            }
            if (debug) log(`llm_output MUTATE cumulative footer appended`);
          }
        }
      }
    } else if (!cumulative) {
      // Non-cumulative fallback (v1 behavior)
      const cw = resolveContextWindow(model, config.modelContextWindows, config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW, hostMap);
      const used = usage.cacheRead > 0 ? usage.cacheRead : usage.input;
      const pctNum = cw > 0 ? (used / cw) * 100 : 0;
      const cacheDenom = usage.input + usage.cacheRead + usage.cacheWrite;
      const cachePct = cacheDenom > 0 ? Math.round((usage.cacheRead / cacheDenom) * 100) : 0;
      const modelShort = model.replace(/^.*\//, "");
      const footer = `📊 ${modelShort}｜${toK(used)}k/${Math.round(cw / 1000)}k (${Math.round(pctNum)}%) · ${toK(usage.input)}→${toK(usage.output)}k · cache ${cachePct}%`;

      const firstLine = footer.split("\n", 1)[0];
      const texts = ev.assistantTexts;
      const tail = Array.isArray(texts) && texts.length > 0 ? texts[texts.length - 1] : undefined;
      if (typeof tail === "string" && !tail.includes(firstLine)) {
        texts![texts!.length - 1] = applyFooter(tail, footer, cap);
        if (ev.lastAssistant && typeof ev.lastAssistant === "object" && typeof ev.lastAssistant.text === "string" && !ev.lastAssistant.text.includes(firstLine)) {
          ev.lastAssistant.text = applyFooter(ev.lastAssistant.text, footer, cap);
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // message_sending → append footer (fallback for channels that skip llm_output)
  // -------------------------------------------------------------------------
  api.on("message_sending", (event: unknown, ctx: unknown): MessageSendingResult | void => {
    const ev = event as MessageSendingEvent;
    const cx = ctx as MessageSendingCtx;
    const chan = cx?.channelId ?? ev?.metadata?.channel;
    if (debug) log(`message_sending FIRE channelId=${chan}`);
    if (chan && skipChannels.has(chan)) return;

    let footer: string | null = null;

    if (cumulative) {
      const acc = accumulator.getByChannel(chan ?? "");
      if (acc) {
        const cw = resolveContextWindow(acc.model, config.modelContextWindows, config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW, hostMap);
        footer = buildCumulativeFooter(acc, cw, newSessionTh, locale).footer;
      }
    }

    if (!footer) {
      const keys: string[] = [];
      if (chan) keys.push(`channel:${chan}`);
      const entry = stash.get(keys);
      if (!entry) { if (debug) log(`message_sending MISS`); return; }
      const cw = resolveContextWindow(entry.model, config.modelContextWindows, config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW, hostMap);
      const used = entry.usage.cacheRead > 0 ? entry.usage.cacheRead : entry.usage.input;
      const pctNum = cw > 0 ? (used / cw) * 100 : 0;
      const cacheDenom = entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite;
      const cachePct = cacheDenom > 0 ? Math.round((entry.usage.cacheRead / cacheDenom) * 100) : 0;
      const modelShort = entry.model.replace(/^.*\//, "");
      footer = `📊 ${modelShort}｜${toK(used)}k/${Math.round(cw / 1000)}k (${Math.round(pctNum)}%) · ${toK(entry.usage.input)}→${toK(entry.usage.output)}k · cache ${cachePct}%`;
    }

    if (!footer) return;

    const originalContent = typeof ev.content === "string" ? ev.content : "";
    const firstLine = footer.split("\n", 1)[0];
    if (originalContent.includes(firstLine)) { if (debug) log(`message_sending SKIP: already has footer`); return; }

    const keys: string[] = [];
    if (chan) keys.push(`channel:${chan}`);
    const entry = stash.get(keys);
    if (entry?.consumed) { if (debug) log(`message_sending SKIP: consumed`); return; }
    if (entry) entry.consumed = true;

    return { content: applyFooter(originalContent, footer, cap) };
  }, { priority: 100 });

  log(`v2.0 init: cumulative=${cumulative}, ttlMs=${ttlMs}, newSession=${newSessionTh}%, locale=${locale}, debug=${debug}`);
}
