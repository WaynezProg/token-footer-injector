/**
 * token-footer-injector — OpenClaw plugin
 *
 * Deterministically appends a token-usage footer to every outbound agent
 * message. The footer is sourced from the real `usage` object emitted by the
 * `llm_output` hook, so the model itself does not have to write it — the
 * result is 100% hit-rate, 100% accurate numbers, and zero model tokens
 * spent on the footer.
 *
 * Flow:
 *   1. `llm_output` (void hook) fires after each LLM attempt. We stash the
 *      usage + model under several indexes (sessionKey / channelId /
 *      agentId).
 *   2. `message_sending` (modifying hook) fires right before an outbound
 *      payload is delivered. We look the stash up by channelId (LRU), build
 *      the footer, and return `{ content: original + footer }`.
 *
 * The hook contexts do not overlap enough to do a precise join (llm_output
 * has sessionKey/agentId/channelId; message_sending has only channelId +
 * accountId), so we fall back to a per-channelId LRU with a short TTL. In
 * practice this is sufficient because outbound payloads for one LLM run
 * are dispatched sequentially for the same channel.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RawUsage {
  // Current (plugin-sdk) shape
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  // Legacy / provider-native shapes we also accept defensively
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

interface StashEntry {
  usage: NormalizedUsage;
  model: string;
  provider: string;
  ts: number;
}

interface PluginConfig {
  format?: string;
  contextWarnFormat?: string;
  contextWarnThreshold?: number;
  modelContextWindows?: Record<string, number>;
  defaultContextWindow?: number;
  skipAgents?: string[];
  skipChannels?: string[];
  maxMessageLength?: number;
  usageTtlMs?: number;
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

/**
 * Curated model → context-window map. Users can override or extend via
 * `modelContextWindows` in plugin config. Keys are matched by exact match
 * first, then longest-prefix.
 */
const DEFAULT_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  "claude-opus-4-7[1m]": 1_000_000,
  "claude-opus-4-7": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
  "claude-3-7-sonnet": 200_000,
  "claude-3-5-sonnet": 200_000,
  "claude-3-5-haiku": 200_000,
  "claude-3-opus": 200_000,
  "claude-": 200_000, // prefix fallback
  // OpenAI
  "gpt-5.4-mini": 200_000,
  "gpt-5.4": 200_000,
  "gpt-5": 256_000,
  "gpt-4.1": 1_000_000,
  "gpt-4o": 128_000,
  "gpt-4": 128_000,
  "o1": 200_000,
  "o3": 200_000,
  // Qwen / Alibaba
  "qwen3.6-plus": 131_072,
  "qwen3-plus": 131_072,
  "qwen3-max": 262_144,
  "qwen3-": 131_072,
  "qwen-": 131_072,
  // Others
  "glm-4.6": 128_000,
  "kimi-k2": 128_000,
  "deepseek-": 128_000,
  "minimax-": 245_760,
};

/**
 * Detect which cache-accounting convention the provider's usage payload
 * follows.
 *
 * Two conventions in the wild:
 *
 * - **Anthropic-style**: `input_tokens` excludes cache;
 *   `cache_read_input_tokens` and `cache_creation_input_tokens` are
 *   *additional* to it. Full prompt = input + cacheRead + cacheWrite.
 *   Seen in: Anthropic, claude-cli, kimi (anthropic-messages api),
 *   openai-codex (despite the name), minimax-portal.
 *
 * - **OpenAI-style**: `prompt_tokens` is the full prompt size with
 *   `prompt_tokens_details.cached_tokens` being a *subset* already
 *   included in it. Full prompt = input. Seen in: openai, qwen
 *   (openai-completions), zai (openai-completions), xai
 *   (openai-responses), google (gemini).
 *
 * Naming is not a reliable signal (e.g. `openai-codex` uses the
 * Anthropic convention). We therefore use a numeric heuristic first:
 * if `cacheRead > input`, the provider must be Anthropic-style because
 * an OpenAI-style cache is always a subset of input and therefore
 * cannot exceed it. Falls back to the name list only when the numeric
 * check is inconclusive (cacheRead ≤ input).
 */
export function isAnthropicStyleUsage(
  provider: string | undefined,
  usage: NormalizedUsage,
): boolean {
  if (usage.cacheRead > usage.input) return true;
  // Numeric check inconclusive (cacheRead could be a subset of input or
  // be zero). Use provider hint for correctness, but note that when
  // cacheRead == 0 both conventions yield the same result anyway.
  if (!provider) return false;
  const p = provider.toLowerCase();
  return (
    p === "anthropic" ||
    p === "claude-cli" ||
    p === "claude-code" ||
    p.startsWith("claude") ||
    p === "openai-codex" ||
    p === "kimi" ||
    p === "minimax-portal"
  );
}

const DEFAULT_FORMATS: Record<"en" | "zh-TW", { format: string; warn: string }> = {
  en: {
    format: "📊 {model} | {usedK}k/{maxK}k ({pct}%) · {inK}→{outK}k tokens · cache {cachePct}%",
    warn: "⚠️ context {pct}%, suggest /compact",
  },
  "zh-TW": {
    format: "📊 {model} | {usedK}k/{maxK}k ({pct}%) · {inK}→{outK}k tokens · cache {cachePct}%",
    warn: "⚠️ context {pct}%,建議 /compact",
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(`[token-footer-injector] ${msg}`);
}

function warn(msg: string): void {
  console.log(`[token-footer-injector] WARN: ${msg}`);
}

function toNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function normalizeUsage(raw: RawUsage | undefined | null): NormalizedUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const input =
    toNum(raw.input) ||
    toNum(raw.input_tokens) ||
    toNum(raw.prompt_tokens);
  const output =
    toNum(raw.output) ||
    toNum(raw.output_tokens) ||
    toNum(raw.completion_tokens);
  const cacheRead =
    toNum(raw.cacheRead) ||
    toNum(raw.cache_read_input_tokens) ||
    toNum(raw.cacheReadTokens);
  const cacheWrite =
    toNum(raw.cacheWrite) ||
    toNum(raw.cache_creation_input_tokens) ||
    toNum(raw.cacheWriteTokens);
  const total = toNum(raw.total) || toNum(raw.total_tokens) || input + output;
  if (input === 0 && output === 0 && total === 0) return null;
  return { input, output, cacheRead, cacheWrite, total };
}

/**
 * Extract `{modelId: contextWindow}` from the OpenClaw host config
 * (`config.models.providers.*.models[]`). This is the authoritative source
 * — OpenClaw itself uses these values for `/status`, compaction thresholds,
 * and per-turn accounting. Keeping our footer in sync with them prevents
 * the two surfaces from disagreeing (which is what produced the
 * 464k/400k "116%" footer while `/status` read 53k/200k on gpt-5.4).
 *
 * Each model is indexed twice: by bare `id` (`qwen3.6-plus`) and by
 * `providerId/id` (`qwen/qwen3.6-plus`), so callers can match either shape.
 */
export function extractHostContextWindows(hostConfig: unknown): Record<string, number> {
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

export function resolveContextWindow(
  model: string,
  overrides: Record<string, number> | undefined,
  fallback: number,
  hostMap?: Record<string, number>,
): number {
  // Priority: plugin config overrides > host config (openclaw.json) > hardcoded defaults > fallback
  // Each tier supports exact match first, then longest-prefix match.
  const tiers: Array<Record<string, number> | undefined> = [
    overrides,
    hostMap,
    DEFAULT_MODEL_CONTEXT_WINDOWS,
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

function round(n: number, digits = 0): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function toK(n: number): string {
  // < 10 → 1 decimal; >= 10 → integer. Keeps footer compact.
  if (n < 1000) return "0";
  const k = n / 1000;
  return k < 10 ? k.toFixed(1) : String(Math.round(k));
}

interface FooterVars {
  model: string;
  used: string;
  usedK: string;
  max: string;
  maxK: string;
  pct: string;
  in: string;
  inK: string;
  out: string;
  outK: string;
  total: string;
  totalK: string;
  cacheRead: string;
  cacheReadK: string;
  cacheWrite: string;
  cacheWriteK: string;
  cachePct: string;
  [key: string]: string;
}

export function buildVars(entry: StashEntry, contextWindow: number): FooterVars & { _pctNum: number } {
  const u = entry.usage;
  // Context usage is aligned with OpenClaw `/status`:
  //   /status "Context" = the persisted session cache portion (cacheRead).
  // We use `cacheRead` when available and fall back to `input` on fresh
  // turns where no cache has built up yet, so a brand-new session still
  // reports something meaningful. This makes the footer's `{usedK}/{maxK}
  // ({pct}%)` numerically identical to `/status`.
  const used = u.cacheRead > 0 ? u.cacheRead : u.input;
  const pctNum = contextWindow > 0 ? (used / contextWindow) * 100 : 0;

  // Cache hit % — denominator depends on whose convention the provider
  // follows (Anthropic adds cache to input; OpenAI treats cache as a
  // subset of input). isAnthropicStyleUsage uses a numeric heuristic to
  // detect Anthropic-style payloads even when the provider name suggests
  // otherwise (e.g. openai-codex, which ships anthropic-messages shape).
  const anthropicStyle = isAnthropicStyleUsage(entry.provider, u);
  const cacheDenom = anthropicStyle ? u.input + u.cacheRead + u.cacheWrite : u.input;
  const cachePctNum = cacheDenom > 0 ? (u.cacheRead / cacheDenom) * 100 : 0;

  const vars: FooterVars & { _pctNum: number } = {
    model: entry.model || "unknown",
    used: String(used),
    usedK: toK(used),
    max: String(contextWindow),
    maxK: String(Math.round(contextWindow / 1000)),
    pct: String(Math.round(pctNum)),
    // {in}/{inK} show the current turn's non-cached input (matches
    // `/status` "Tokens: Nk in"), not the full prompt side.
    in: String(u.input),
    inK: toK(u.input),
    out: String(u.output),
    outK: toK(u.output),
    total: String(u.total),
    totalK: toK(u.total),
    cacheRead: String(u.cacheRead),
    cacheReadK: toK(u.cacheRead),
    cacheWrite: String(u.cacheWrite),
    cacheWriteK: toK(u.cacheWrite),
    cachePct: String(Math.round(cachePctNum)),
    _pctNum: pctNum,
  };
  return vars;
}

export function renderTemplate(tmpl: string, vars: Record<string, string>): string {
  return tmpl.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, key) => {
    if (key in vars) return vars[key];
    return match;
  });
}

export function buildFooter(
  entry: StashEntry,
  config: Required<Pick<PluginConfig, "contextWarnThreshold">> & PluginConfig,
  hostMap?: Record<string, number>,
): string {
  const win = resolveContextWindow(
    entry.model,
    config.modelContextWindows,
    config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    hostMap,
  );
  const vars = buildVars(entry, win);
  const locale: "en" | "zh-TW" = config.locale === "zh-TW" ? "zh-TW" : "en";
  const defaults = DEFAULT_FORMATS[locale];
  const format = config.format ?? defaults.format;
  const warnFormat = config.contextWarnFormat ?? defaults.warn;
  const mainLine = renderTemplate(format, vars);
  if (vars._pctNum > config.contextWarnThreshold) {
    const warnLine = renderTemplate(warnFormat, vars);
    return `${mainLine}\n${warnLine}`;
  }
  return mainLine;
}

// ---------------------------------------------------------------------------
// Stash
// ---------------------------------------------------------------------------

export class UsageStash {
  private byKey = new Map<string, StashEntry>();
  constructor(private ttlMs: number) {}

  set(keys: string[], entry: StashEntry): void {
    this.gc();
    for (const k of keys) if (k) this.byKey.set(k, entry);
  }

  get(keys: string[]): StashEntry | null {
    this.gc();
    for (const k of keys) {
      if (!k) continue;
      const e = this.byKey.get(k);
      if (e && Date.now() - e.ts < this.ttlMs) return e;
    }
    return null;
  }

  size(): number {
    return this.byKey.size;
  }

  clear(): void {
    this.byKey.clear();
  }

  private gc(): void {
    const now = Date.now();
    for (const [k, v] of this.byKey) {
      if (now - v.ts >= this.ttlMs) this.byKey.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Footer application
// ---------------------------------------------------------------------------

function trimToCap(content: string, footer: string, cap: number): string {
  const joined = `${content.trimEnd()}\n\n${footer}`;
  if (joined.length <= cap) return joined;
  // Preserve the footer; trim the body.
  const fixed = `\n\n${footer}`;
  const bodyBudget = cap - fixed.length;
  if (bodyBudget <= 0) {
    // Degenerate case: footer alone exceeds the cap. Return footer truncated.
    return fixed.trim().slice(0, Math.max(0, cap));
  }
  const ellipsis = "…";
  const truncated = content.slice(0, Math.max(0, bodyBudget - ellipsis.length)).trimEnd() + ellipsis;
  return `${truncated}${fixed}`;
}

export function applyFooter(content: string, footer: string, cap?: number): string {
  if (!footer) return content;
  if (typeof cap === "number" && cap > 0) return trimToCap(content, footer, cap);
  return `${content.trimEnd()}\n\n${footer}`;
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
  const threshold = typeof config.contextWarnThreshold === "number" ? config.contextWarnThreshold : DEFAULT_WARN_THRESHOLD;
  const skipAgents = new Set(config.skipAgents ?? []);
  const skipChannels = new Set(config.skipChannels ?? []);
  const cap = typeof config.maxMessageLength === "number" && config.maxMessageLength > 0 ? config.maxMessageLength : undefined;
  const locale: "en" | "zh-TW" = config.locale === "zh-TW" ? "zh-TW" : "en";
  const debug = config.debug === true;

  // Pull the authoritative context-window table from the OpenClaw host
  // config (`config.models.providers.*.models[].contextWindow`). These are
  // the exact same values the core uses for /status, compaction, and
  // budgeting, so we stay in sync automatically.
  const hostMap = extractHostContextWindows(anyApi.config);

  const stash = new UsageStash(ttlMs);

  if (typeof api.on !== "function") {
    warn("api.on not available on this host — plugin disabled");
    return;
  }

  // -------------------------------------------------------------------------
  // llm_output → stash usage
  // -------------------------------------------------------------------------
  api.on(
    "llm_output",
    (event: unknown, ctx: unknown) => {
      const ev = event as LlmOutputEvent;
      const cx = ctx as LlmOutputCtx;
      if (debug) log(`llm_output FIRE agentId=${cx?.agentId} channelId=${cx?.channelId} sessionKey=${cx?.sessionKey} model=${ev?.model} usage=${JSON.stringify(ev?.usage)}`);
      if (cx?.agentId && skipAgents.has(cx.agentId)) return;
      if (cx?.channelId && skipChannels.has(cx.channelId)) return;
      const usage = normalizeUsage(ev?.usage);
      if (!usage) {
        if (debug) log(`llm_output SKIP: usage could not be normalized`);
        return;
      }
      const entry: StashEntry = {
        usage,
        model: ev.model ?? "unknown",
        provider: ev.provider ?? "unknown",
        ts: Date.now(),
      };
      // Index by every axis we can. Same entry, multiple lookup keys.
      const keys: string[] = [];
      if (cx?.sessionKey) keys.push(`session:${cx.sessionKey}`);
      if (cx?.runId) keys.push(`run:${cx.runId}`);
      if (cx?.agentId) keys.push(`agent:${cx.agentId}`);
      if (cx?.channelId) keys.push(`channel:${cx.channelId}`);
      stash.set(keys, entry);
      if (debug) log(`llm_output STASH keys=[${keys.join(",")}] size=${stash.size()}`);

      // --- Primary injection path ---
      // Many outbound adapters (notably Discord) skip `message_sending`. The
      // llm_output hook runs void-parallel: handlers execute synchronously
      // inside `hooks.map(async ...)`, so mutating `event.assistantTexts`
      // (same reference as the core's outer variable) before the handler
      // yields is enough to have the footer propagated downstream.
      const footer = buildFooter(entry, { ...config, contextWarnThreshold: threshold }, hostMap);
      if (!footer) return;
      const firstLine = footer.split("\n", 1)[0];
      const texts = ev.assistantTexts;
      const tail = Array.isArray(texts) && texts.length > 0 ? texts[texts.length - 1] : undefined;
      if (typeof tail === "string" && !tail.includes(firstLine)) {
        const next = applyFooter(tail, footer, cap);
        texts![texts!.length - 1] = next;
        if (ev.lastAssistant && typeof ev.lastAssistant === "object" && typeof ev.lastAssistant.text === "string" && !ev.lastAssistant.text.includes(firstLine)) {
          ev.lastAssistant.text = applyFooter(ev.lastAssistant.text, footer, cap);
        }
        if (debug) log(`llm_output MUTATE assistantTexts[last] appended footer`);
      } else if (debug) {
        log(`llm_output MUTATE skip: tail already contains footer or no tail text`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // message_sending → append footer
  // -------------------------------------------------------------------------
  api.on(
    "message_sending",
    (event: unknown, ctx: unknown): MessageSendingResult | void => {
      const ev = event as MessageSendingEvent;
      const cx = ctx as MessageSendingCtx;
      const chan = cx?.channelId ?? ev?.metadata?.channel;
      if (debug) log(`message_sending FIRE to=${ev?.to} channelId=${cx?.channelId} metaChannel=${ev?.metadata?.channel} accountId=${cx?.accountId} contentLen=${ev?.content?.length ?? 0}`);
      if (chan && skipChannels.has(chan)) return;

      const keys: string[] = [];
      if (chan) keys.push(`channel:${chan}`);
      const entry = stash.get(keys);
      if (!entry) {
        if (debug) log(`message_sending MISS: no stash entry for keys=[${keys.join(",")}], stashSize=${stash.size()}`);
        return;
      }

      const footer = buildFooter(entry, { ...config, contextWarnThreshold: threshold }, hostMap);
      const originalContent = typeof ev.content === "string" ? ev.content : "";
      // Guard against double-injection: if llm_output already mutated the
      // upstream assistantTexts, the content will already carry the footer.
      const firstLine = footer.split("\n", 1)[0];
      if (originalContent.includes(firstLine)) {
        if (debug) log(`message_sending SKIP: content already contains footer`);
        return;
      }
      const nextContent = applyFooter(originalContent, footer, cap);
      if (debug) log(`message_sending APPEND: footer='${firstLine}' appended`);
      return { content: nextContent };
    },
    { priority: 100 },
  );

  const hostMapCount = Object.keys(hostMap).length;
  log(`v1.0.5 init: ttlMs=${ttlMs}, threshold=${threshold}%, locale=${locale}, skipAgents=[${[...skipAgents].join(",")}], skipChannels=[${[...skipChannels].join(",")}], cap=${cap ?? "none"}, debug=${debug}, hostContextWindows=${hostMapCount}`);
}
