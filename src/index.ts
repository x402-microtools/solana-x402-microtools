import { Hono } from "hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { InputError, parseCrypto, parsePreflight, parseWeather, type Pair } from "./inputs";
import { TOOLS, manifest, openapi } from "./schemas";
import { TokenCheckError, analyzeToken, parseTokenCheckQuery, readMintSnapshot, type MintSnapshot } from "./token-check";
import { RpcError } from "./rpc";
import { TxPreviewError, parseTxPreviewBody, previewTransaction, type TxPreviewInput } from "./tx-preview";
const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
interface Limiter { limit(input: { key: string }): Promise<{ success: boolean }> }
interface Env {
  NETWORK: "mainnet" | "devnet";
  PAY_TO_ADDRESS: string;
  FACILITATOR_URL: string;
  RATE_LIMIT_SALT: string;
  MET_CONTACT: string;
  SOLANA_RPC_URL: string;
  /** Optional secret (e.g. keyed provider URL). Tried before the public SOLANA_RPC_URL list. Never put it in wrangler.jsonc. */
  PRIMARY_RPC_URL?: string;
  INBOUND_LIMIT: Limiter;
  UPSTREAM_LIMIT: Limiter;
}
type HonoEnv = { Bindings: Env; Variables: { mintSnapshot?: MintSnapshot; txPreview?: TxPreviewInput } };
const app = new Hono<HonoEnv>();
/** Secret primary RPC first, then the public fallback list from wrangler.jsonc. */
function rpcUrls(e: Env): string {
  return [e.PRIMARY_RPC_URL, e.SOLANA_RPC_URL].map((x) => (x ?? "").trim()).filter(Boolean).join(",");
}
function config(e: Env): { network: `${string}:${string}`; payTo: string; facilitator: string } {
  if (e.NETWORK !== "mainnet" && e.NETWORK !== "devnet") throw new Error("NETWORK must be devnet or mainnet");
  if (!e.PAY_TO_ADDRESS || !BASE58.test(e.PAY_TO_ADDRESS)) throw new Error("Invalid PAY_TO_ADDRESS");
  if (!e.RATE_LIMIT_SALT || e.RATE_LIMIT_SALT.length < 32) throw new Error("Missing RATE_LIMIT_SALT (at least 32 characters)");
  if (!e.MET_CONTACT || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.MET_CONTACT)) throw new Error("MET_CONTACT must be a working contact email");
  if (!e.FACILITATOR_URL || !e.FACILITATOR_URL.startsWith("https://")) throw new Error("FACILITATOR_URL must be HTTPS");
  if (rpcUrls(e).split(",").some((u) => !u.trim().startsWith("https://"))) throw new Error("SOLANA_RPC_URL / PRIMARY_RPC_URL must be HTTPS (comma-separated list allowed)");
  return { network: e.NETWORK === "devnet" ? DEVNET : MAINNET, payTo: e.PAY_TO_ADDRESS, facilitator: e.FACILITATOR_URL };
}
app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
});
app.use("*", async (c, next) => c.req.method === "HEAD" ? c.json({ error: "HEAD is disabled" }, 405) : next());
/** Methods: POST only for the JSON-body routes (tx-preview), GET for everything else. */
const POST_ROUTES = new Set<string>(TOOLS.filter((t) => t.method === "POST").map((t) => t.route));
app.use("*", async (c, next) => {
  const post = POST_ROUTES.has(new URL(c.req.url).pathname);
  if (c.req.method === (post ? "POST" : "GET")) return next();
  c.header("Allow", post ? "POST" : "GET");
  return c.json({ error: post ? "Only POST with a JSON body is supported on this route" : "Only GET is supported" }, 405);
});
app.get("/health", (c) => {
  try {
    const cfg = config(c.env);
    return c.json({ ok: true, x402Version: 2, network: cfg.network, payment: "USDC", service: "solana-x402-microtools" });
  } catch {
    return c.json({ ok: false, error: "Missing or invalid server configuration" }, 503);
  }
});
app.get("/.well-known/x402.json", (c) => {
  const cfg = config(c.env);
  return c.json(manifest(new URL(c.req.url).origin, cfg.network, cfg.payTo));
});
// 402index.io domain-ownership proof: SHA-256 hash of the claim token (the hash is public by design; the token is not).
app.get("/.well-known/402index-verify.txt", (c) => c.text("a1755b244546bcb0ae550452fd7e9bf3a5f1ea29215b65d5a8dbeed41486b5ab"));
app.get("/openapi.json", (c) => c.json(openapi(new URL(c.req.url).origin)));
app.get("/llms.txt", (c) => c.text("Solana x402 Microtools (x402 v2, exact USDC)\nGET /.well-known/x402.json for discovery metadata and JSON schemas\nGET /openapi.json for OpenAPI 3.1\nGET /health for free liveness\nGET /api/preflight?url=... ($0.01 USDC)\nGET /api/crypto?pair=SOL-USDC|RAY-USDC|all ($0.003 USDC)\nGET /api/weather?city=london OR ?lat=51.5&lon=-0.1 ($0.003 USDC)\nGET /api/token-check?mint=<base58 SPL or Token-2022 mint> ($0.01 USDC)\nPOST /api/tx-preview JSON {\"transaction\":\"<base64|base58 unsigned or signed tx>\",\"wallet\":\"<optional address>\"} ($0.01 USDC): simulate a Solana tx before signing; balance changes, programs, fee, red flags. Optional \"intent\":\"swap 0.002 SOL for USDC\" and \"context\":{\"type\":\"tokenized_equity\",\"ticker\":\"NVDAx\"} add a Pre-Sign Brief: verdict clear|caution|avoid, reasons, intent_match, verified xStocks check, priority fee (micro-lamports/CU), brief_hash\nUse an x402 v2 Solana client. Bad input (incl. non-mint addresses) returns 400 before payment. No investment advice. Weather by MET Norway (CC BY 4.0).\n"));
app.use("/api/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (!TOOLS.some((x) => x.route === path)) return c.json({ error: "Unknown API route" }, 404);
  const key = await scopedKey(c, c.env.RATE_LIMIT_SALT, path);
  const result = await c.env.INBOUND_LIMIT.limit({ key });
  if (!result.success) {
    c.header("Retry-After", "60");
    return c.json({ error: "Rate limit exceeded" }, 429);
  }
  await next();
});
// Free pre-payment checks: bad query/body inputs get a 400 before payment. A bare URL with NO query string (or an
// empty/{} POST body) is treated as a directory discovery probe (PayAI /verify, x402scan, 402index, CDP validate):
// it gets the 402 challenge so the route can be indexed, and can never be charged because the route handler still
// validates and returns 400 (cancelling x402 settlement on >= 400).
const hasQuery = (url: string) => new URL(url).search.length > 1;
app.use("/api/preflight", async (c, next) => { if (hasQuery(c.req.url)) parsePreflight(new URL(c.req.url).searchParams); await next(); });
app.use("/api/crypto", async (c, next) => { parseCrypto(new URL(c.req.url).searchParams); await next(); });
app.use("/api/weather", async (c, next) => { if (hasQuery(c.req.url)) parseWeather(new URL(c.req.url).searchParams); await next(); });
app.use("/api/token-check", async (c, next) => {
  if (hasQuery(c.req.url)) {
    const { mint } = parseTokenCheckQuery(new URL(c.req.url).searchParams);
    c.set("mintSnapshot", await readMintSnapshot(rpcUrls(c.env), mint));
  }
  await next();
});
app.use("/api/tx-preview", async (c, next) => {
  const raw = await c.req.text();
  const trimmed = raw.trim();
  const unpaidProbe = trimmed === "{}" && !c.req.header("PAYMENT-SIGNATURE") && !c.req.header("X-PAYMENT");
  if (trimmed.length > 0 && !unpaidProbe) c.set("txPreview", parseTxPreviewBody(c.req.header("Content-Type"), raw));
  await next();
});
async function scopedKey(c: { req: { header(name: string): string | undefined } }, salt: string, route: string): Promise<string> {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const encoded = new TextEncoder().encode(`${salt}|${ip}|${route}`);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}
app.use("/api/*", async (c, next) => {
  const cfg = config(c.env);
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: cfg.facilitator }))
    .register(cfg.network, new ExactSvmScheme())
    .registerExtension(bazaarResourceServerExtension);
  const routes: Record<string, unknown> = {};
  for (const tool of TOOLS) {
    routes[`${tool.method} ${tool.route}`] = {
      accepts: [{ scheme: "exact", price: tool.price, network: cfg.network, payTo: cfg.payTo }],
      description: tool.summary,
      mimeType: "application/json",
      extensions: declareDiscoveryExtension(tool.method === "POST"
        ? { input: tool.example, inputSchema: tool.input, bodyType: "json", output: { example: tool.outputExample, schema: tool.output } }
        : { input: tool.example, inputSchema: tool.input, output: { example: tool.outputExample, schema: tool.output } })
    };
  }
  return paymentMiddleware(routes as unknown as Parameters<typeof paymentMiddleware>[0], server)(c, next);
});
async function consumeUpstream(c: { env: Env; req: { header(name: string): string | undefined } }, route: string) {
  const key = await scopedKey(c, c.env.RATE_LIMIT_SALT, route);
  const { success } = await c.env.UPSTREAM_LIMIT.limit({ key });
  if (!success) throw new ApiError(429, "Upstream allowance exceeded; retry later");
}
class ApiError extends Error {
  constructor(public status: 429 | 502 | 503 | 504, message: string) { super(message); this.name = "ApiError"; }
}
function termsFromHeader(value: string | null): { version: number; accepts: Array<Record<string, unknown>> } | null {
  if (!value || value.length > 16000) return null;
  try {
    const data = JSON.parse(atob(value)) as Record<string, unknown>;
    if (data.x402Version !== 2 || !Array.isArray(data.accepts) || data.accepts.length > 12) return null;
    const accepts = data.accepts.map((entry: unknown) => {
      if (!entry || typeof entry !== "object") throw Error("Not an object");
      const x = entry as Record<string, unknown>;
      if (x.scheme !== "exact" || typeof x.network !== "string" || typeof x.asset !== "string" || typeof x.amount !== "string" || typeof x.payTo !== "string") throw Error("Invalid requirement");
      return { scheme: x.scheme, network: String(x.network).slice(0, 120), asset: String(x.asset).slice(0, 100), amount: String(x.amount).slice(0, 40), payTo: String(x.payTo).slice(0, 100) };
    });
    return { version: 2, accepts };
  } catch { return null; }
}
app.get("/api/preflight", async (c) => {
  const { target } = parsePreflight(new URL(c.req.url).searchParams);
  await consumeUpstream(c, "preflight");
  const start = Date.now();
  let response: Response;
  try {
    response = await fetch(target.href, {
      method: "GET", redirect: "manual", signal: AbortSignal.timeout(3500),
      headers: { "Accept": "application/json", "User-Agent": "x402-Microtools-Preflight/1.0" }
    });
  } catch { throw new ApiError(504, "Target connection failed or timed out"); }
  try { await response.body?.cancel(); } catch { /* ignore */ }
  const status = response.status;
  const terms = status === 402 ? termsFromHeader(response.headers.get("PAYMENT-REQUIRED")) : null;
  return c.json({ target: target.origin + target.pathname, http_status: status,
    latency_ms: Date.now() - start, is_x402_v2: terms !== null, terms,
    checked_at: new Date().toISOString() });
});
/** Verified live Raydium AMM v4 pools (22 Oct 2026). Reserve ratios only, not executable quotes. */
const POOLS = {
  "SOL-USDC": { pool: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2", base: "DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz", quote: "HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz", mint: WSOL_MINT },
  "RAY-USDC": { pool: "6UmmUiYoBjSrhakAobJw8BvkmJtDVxaeBtbt7rxWo1mg", base: "FdmKUE4UMiJYFK5ogCngHzShuVKrFXBamPWcewDr31th", quote: "Eqrhxd7bDUCH3MepKmdVkgwazXRzY6iHhEoBpY7yAohk", mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R" }
} as const;
type ParsedTokenAccount = { data?: { parsed?: { info?: { mint?: string; tokenAmount?: { uiAmountString?: string } } } } };
function token(account: ParsedTokenAccount | null | undefined, mint: string): number {
  const info = account?.data?.parsed?.info;
  if (info?.mint !== mint || !info.tokenAmount?.uiAmountString) throw new ApiError(502, "Invalid, missing or migrated pool token vault");
  const amount = Number(info.tokenAmount.uiAmountString);
  if (!Number.isFinite(amount) || amount <= 0) throw new ApiError(502, "Empty or malformed pool vault");
  return amount;
}
const rpcCached = new Map<string, { until: number; payload: ReturnType<typeof mapPools> }>();
async function solanaPools(rpcUrl: string, pair: Pair) {
  const now = Date.now();
  const cacheKey = pair;
  const hit = rpcCached.get(cacheKey);
  if (hit && hit.until > now) return hit.payload;
  const pools = Object.entries(POOLS).filter(([key]) => pair === "all" || key === pair);
  const keys = pools.flatMap(([, p]) => [p.base, p.quote]);
  const request = { jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [keys, { encoding: "jsonParsed", commitment: "confirmed" }] };
  // Try each configured RPC in order (public RPCs may block Cloudflare Workers or rate-limit).
  type RpcResult = { result?: { context?: { slot?: number }; value?: Array<ParsedTokenAccount | null> }; error?: unknown };
  let r: RpcResult | null = null;
  let lastErr = new ApiError(502, "Solana RPC unavailable");
  for (const url of rpcUrl.split(",").map((u) => u.trim()).filter(Boolean)) {
    let response: Response;
    try { response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(4500), headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }); }
    catch { lastErr = new ApiError(504, "Solana RPC timed out"); continue; }
    if (!response.ok) { lastErr = new ApiError(response.status === 429 ? 429 : 502, "Solana RPC unavailable"); continue; }
    let json: unknown;
    try { json = await response.json(); } catch { lastErr = new ApiError(502, "Malformed RPC response"); continue; }
    const candidate = json as RpcResult;
    if (candidate.error || !candidate.result?.context?.slot || !Array.isArray(candidate.result.value) || candidate.result.value.length !== keys.length) { lastErr = new ApiError(502, "Invalid RPC result"); continue; }
    r = candidate; break;
  }
  if (!r || !r.result?.context?.slot || !Array.isArray(r.result.value)) throw lastErr;
  const mapped = mapPools(r.result.context.slot, r.result.value, pools);
  rpcCached.set(cacheKey, { until: now + 30000, payload: mapped });
  return mapped;
}
function mapPools(slot: number, values: Array<ParsedTokenAccount | null>, pools: Array<[string, (typeof POOLS)[keyof typeof POOLS]]>) {
  return pools.map(([pair, p], i) => {
    const base = token(values[2 * i], p.mint);
    const quote = token(values[2 * i + 1], USDC_MINT);
    return { pair, price_usdc: Number((quote / base).toPrecision(9)), slot,
      base_vault: p.base, quote_vault: p.quote, pool_address: p.pool, base_reserve: base, quote_reserve_usdc: quote };
  });
}
app.get("/api/crypto", async (c) => {
  const { pair } = parseCrypto(new URL(c.req.url).searchParams);
  await consumeUpstream(c, "crypto");
  const chosen = await solanaPools(rpcUrls(c.env), pair);
  return c.json({ source: "solana_mainnet_onchain_rpc", method: "raydium_amm_v4_vault_reserve_ratio_only", trending: false,
    disclaimer: "AMM vault balances can be stale or manipulated; not a trading quote, pool ranking or financial advice.",
    pairs: chosen, checked_at: new Date().toISOString() });
});
app.get("/api/weather", async (c) => {
  const loc = parseWeather(new URL(c.req.url).searchParams);
  await consumeUpstream(c, "weather");
  const url = new URL("https://api.met.no/weatherapi/locationforecast/2.0/compact");
  url.searchParams.set("lat", loc.lat.toFixed(4));
  url.searchParams.set("lon", loc.lon.toFixed(4));
  let response: Response;
  try {
    response = await fetch(url.href, {
      signal: AbortSignal.timeout(4500),
      headers: { "User-Agent": `solana-x402-microtools/1.0 (${c.env.MET_CONTACT})`, "Accept": "application/json" },
      cf: { cacheEverything: true }
    } as RequestInit & { cf: { cacheEverything: boolean } });
  } catch { throw new ApiError(504, "Weather provider timed out"); }
  if (!response.ok) throw new ApiError(response.status === 429 ? 429 : 502, "Weather provider unavailable");
  let body: unknown;
  try { body = await response.json(); } catch { throw new ApiError(502, "Weather provider returned invalid JSON"); }
  const series = (body as { properties?: { timeseries?: unknown } })?.properties?.timeseries;
  if (!Array.isArray(series) || series.length < 1) throw new ApiError(502, "Missing forecast data");
  const forecast = series.slice(0, 6).map((item: unknown) => {
    const x = item as { time?: string; data?: { instant?: { details?: Record<string, unknown> }; next_1_hours?: { details?: Record<string, unknown>; summary?: { symbol_code?: string } } } };
    const temp = x.data?.instant?.details?.air_temperature;
    const wind = x.data?.instant?.details?.wind_speed;
    if (typeof x.time !== "string" || typeof temp !== "number" || !Number.isFinite(temp) || typeof wind !== "number" || !Number.isFinite(wind)) throw new ApiError(502, "Incomplete weather data");
    const precip = x.data?.next_1_hours?.details?.precipitation_amount;
    return { time: x.time, temp_c: temp as number, wind_mps: wind as number,
      precipitation_mm_next_hour: typeof precip === "number" ? precip : null,
      symbol: x.data?.next_1_hours?.summary?.symbol_code ?? null };
  });
  return c.json({ location: loc, forecast, attribution: "Data from MET Norway, CC BY 4.0 (https://api.met.no/)",
    note: "Forecast model estimates; not live observed weather", checked_at: new Date().toISOString() });
});
app.get("/api/token-check", async (c) => {
  const { mint } = parseTokenCheckQuery(new URL(c.req.url).searchParams);
  await consumeUpstream(c, "token-check");
  const snapshot = c.get("mintSnapshot") ?? await readMintSnapshot(rpcUrls(c.env), mint);
  return c.json(await analyzeToken(rpcUrls(c.env), snapshot));
});
app.post("/api/tx-preview", async (c) => {
  const input = c.get("txPreview") ?? parseTxPreviewBody(c.req.header("Content-Type"), await c.req.text());
  await consumeUpstream(c, "tx-preview");
  return c.json(await previewTransaction(rpcUrls(c.env), input));
});
app.onError((e, c) => {
  if (e instanceof TxPreviewError || e instanceof RpcError) {
    if (e.status === 429) c.header("Retry-After", "60");
    return c.json({ error: e.message }, e.status);
  }
  if (e instanceof InputError) return c.json({ error: e.message }, 400);
  if (e instanceof TokenCheckError) {
    if (e.status === 429) c.header("Retry-After", "60");
    return c.json({ error: e.message }, e.status);
  }
  if (e instanceof ApiError) {
    if (e.status === 429) c.header("Retry-After", "60");
    return c.json({ error: e.message }, e.status);
  }
  return c.json({ error: "Service unavailable" }, 503);
});
app.notFound((c) => c.json({ error: "Not found" }, 404));
export default app;
