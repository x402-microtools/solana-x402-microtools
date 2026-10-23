import { CITIES, PAIRS } from "./inputs";
import { tokenCheckInputJsonSchema, tokenCheckOutputJsonSchema } from "./token-check-schemas";
import { txPreviewInputJsonSchema, txPreviewOutputJsonSchema } from "./tx-preview";
const error = { type: "object", additionalProperties: false, required: ["error"], properties: { error: { type: "string" } } };
const preflightInput = {
  type: "object", additionalProperties: false, required: ["url"],
  properties: { url: { type: "string", format: "uri", maxLength: 1600, description: "HTTPS URL with a public DNS hostname, no custom port, URL credentials or secret-bearing query parameters" } }
};
const cryptoInput = {
  type: "object", additionalProperties: false,
  properties: { pair: { type: "string", enum: PAIRS, default: "SOL-USDC", description: "all returns curated pool snapshots, not trending rankings" } }
};
const weatherInput = {
  type: "object", additionalProperties: false,
  properties: {
    city: { type: "string", enum: Object.keys(CITIES) },
    lat: { type: "number", minimum: -90, maximum: 90 },
    lon: { type: "number", minimum: -180, maximum: 180 }
  },
  oneOf: [{ required: ["city"] }, { required: ["lat", "lon"] }]
};
const preflightOutput = { type: "object", required: ["target", "http_status", "latency_ms", "is_x402_v2", "terms", "checked_at"], properties: {
  target: { type: "string" }, http_status: { type: "integer" }, latency_ms: { type: "integer" },
  is_x402_v2: { type: "boolean" }, terms: { type: ["object", "null"] }, checked_at: { type: "string", format: "date-time" }
} };
const cryptoOutput = { type: "object", required: ["source", "method", "pairs", "trending"], properties: {
  source: { type: "string" }, method: { type: "string" }, trending: { type: "boolean", const: false },
  pairs: { type: "array", items: { type: "object", required: ["pair", "price_usdc", "slot", "base_vault", "quote_vault"], properties: {
    pair: { type: "string" }, price_usdc: { type: "number" }, slot: { type: "integer" },
    base_vault: { type: "string" }, quote_vault: { type: "string" }
  } } }
} };
const weatherOutput = { type: "object", required: ["location", "forecast", "attribution"], properties: {
  location: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" }, city: { type: ["string", "null"] } } },
  forecast: { type: "array", items: { type: "object", required: ["time", "temp_c", "wind_mps"], properties: {
    time: { type: "string", format: "date-time" }, temp_c: { type: "number" }, wind_mps: { type: "number" },
    precipitation_mm_next_hour: { type: ["number", "null"] }, symbol: { type: ["string", "null"] }
  } } }, attribution: { type: "string" }
} };
export const TOOLS = [
  { id: "preflight", method: "GET", route: "/api/preflight", price: "$0.01", summary: "Probe one public HTTPS URL without following redirects; inspect x402 v2 challenge", input: preflightInput, output: preflightOutput, example: { url: "https://x402.org" },
    outputExample: { target: "https://x402.org/", http_status: 200, latency_ms: 20, is_x402_v2: false, terms: null, checked_at: "2026-10-22T00:00:00Z" } },
  { id: "crypto", method: "GET", route: "/api/crypto", price: "$0.003", summary: "Indicative Solana Raydium AMM v4 vault ratios for SOL-USDC and RAY-USDC; not executable quotes or trending", input: cryptoInput, output: cryptoOutput, example: { pair: "SOL-USDC" },
    outputExample: { source: "solana_rpc", method: "indicative_vault_ratio", trending: false, pairs: [] } },
  { id: "weather", method: "GET", route: "/api/weather", price: "$0.003", summary: "Next six forecast points for coordinates or a supported city, MET Norway CC BY 4.0", input: weatherInput, output: weatherOutput, example: { city: "london" },
    outputExample: { location: { lat: 51.5074, lon: -0.1278, city: "london" }, forecast: [], attribution: "MET Norway (CC BY 4.0)" } },
  { id: "token-check", method: "GET", route: "/api/token-check", price: "$0.01", summary: "Solana SPL / Token-2022 mint safety check: mint & freeze authority, risky Token-2022 extensions (permanent delegate, transfer hook, transfer fee, pausable, non-transferable), best-effort top-10 token-account concentration, heuristic risk score", input: tokenCheckInputJsonSchema, output: tokenCheckOutputJsonSchema, example: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
    outputExample: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", token_program: "spl-token", is_token_2022: false, mint_authority: { revoked: false, address: "BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG" }, freeze_authority: { revoked: false, address: "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar" }, supply_raw: "8029356837919150", supply_ui: "8029356837.91915", decimals: 6, top_10_token_accounts_share_pct: 34.3932, top_10_token_accounts_balance_raw: "2761557447750674", top_10_token_accounts_count: 10, concentration_status: "ok", risky_extensions: { transfer_fee: false, permanent_delegate: false, transfer_hook: false, non_transferable: false, pausable: false }, extensions_present: [], risk_flags: [{ id: "mint_authority_active", points: 2, rule: "Mint authority is not revoked (+2).", reason: "The authority can create additional tokens, changing supply." }, { id: "freeze_authority_active", points: 2, rule: "Freeze authority is not revoked (+2).", reason: "The authority can freeze individual token accounts." }], risk_points: 4, risk_score: "high", risk_scoring_rule: "0 points = low; 1-2 points = medium; 3+ points = high", mint_slot: 460132384, largest_accounts_slot: 460132414, checked_at: "2026-10-22T18:11:55.170Z", limitations: "Heuristic, not an audit or trading recommendation." } },
  { id: "tx-preview", method: "POST", route: "/api/tx-preview", price: "$0.01", summary: "Solana transaction preview BEFORE signing: simulate an unsigned or signed legacy/v0 transaction (address lookup tables resolved) and get SOL and SPL/Token-2022 balance changes for your wallet, programs invoked (known/unknown), fee estimate and red flags (token approvals, authority/owner changes, close-to-other, wallet reassign, >90% SOL loss, simulation failure). JSON body. Optional Pre-Sign Brief (schema 1.0): pass intent (e.g. 'swap 0.002 SOL for USDC', 'send 0.001 SOL to <address>') and/or context {type, ticker, mint}; get verdict clear|caution|avoid with reasons, intent_match, verified xStocks tokenized-equity check, priority-fee market hint (micro-lamports/CU) and a sha256 brief_hash.", input: txPreviewInputJsonSchema, output: txPreviewOutputJsonSchema,
    example: { transaction: "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQABA5IyE34vOnuTe3EFREAvP/9CVS1NogZXz/j89+6yqH8kRFcXQRpRgtbYGfC3Y1fSutkWE9If7iTMBOb38N1MPsQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJo2tp2UQI3pVZDgHdOHCzmjIVcZATBnljClf1RN74NPAQICAAEMAgAAAEBCDwAAAAAAAA==", wallet: "Aqgp4nKbk3WV1e7fLHepkcdwLLz3j8DwHqLTLHVEa6GK", intent: "send 0.001 SOL to 5bmkKzfXpgMb3GgBw6UVWTQiv2q7LNAFvs9w6yAaVDoR" },
    outputExample: { schema_version: "1.0", verdict: "clear", reasons: [], intent_match: { checked: true, matches: true, mismatches: [], confidence: "high" },
      tokenized_equity: { checked_mints: [], claimed_mint: null, counterfeit_risk: false, reason: null }, priority_fee: null, brief_hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", success: true, error: null, summary: "Would succeed. You send 0.001 SOL. Fee ~0.000005 SOL. No red flags.", wallet: "Aqgp4nKbk3WV1e7fLHepkcdwLLz3j8DwHqLTLHVEa6GK",
      sol_changes: [{ account: "Aqgp4nKbk3WV1e7fLHepkcdwLLz3j8DwHqLTLHVEa6GK", delta_lamports: "-1005000", delta_sol: "-0.001005", is_wallet: true }], token_changes: [],
      programs: [{ id: "11111111111111111111111111111111", name: "System", known: true, top_level: true }], red_flags: [], units_consumed: 150,
      fee_estimate_lamports: "5000", fee_estimate_method: "rpc_simulation", source: "solana-mainnet-rpc simulateTransaction", fetched_at: "2026-10-22T00:00:00Z", disclaimer: "Simulation only" } }
] as const;
export function manifest(base: string, network: string, wallet: string) {
  return {
    name: "Solana x402 Microtools", version: "1.0.0", protocol: "x402", x402Version: 2,
    payment: { network, scheme: "exact", asset: "USDC", payTo: wallet, currency: "USD", header: "PAYMENT-SIGNATURE" },
    docs: `${base}/openapi.json`, health: `${base}/health`,
    attribution: { weather: "Data from MET Norway, CC BY 4.0", crypto: "On-chain pool vault balances read via Solana JSON-RPC" },
    limitations: ["Indicative reserves are not swap execution prices", "No dynamic trending, rankings or trading advice", "City lookup is a fixed list", "Token check is a heuristic, not an audit; concentration is best-effort via public RPC", "Transaction preview is a point-in-time simulation; red flags are heuristics, not an audit"],
    tools: TOOLS.map((x) => ({ id: x.id, method: x.method, ...(x.method === "POST" ? { bodyType: "json" } : {}), url: `${base}${x.route}`, price: x.price, description: x.summary, inputSchema: x.input, outputSchema: x.output }))
  };
}
export function openapi(base: string) {
  const paths: Record<string, unknown> = {};
  for (const tool of TOOLS) {
    const properties = tool.input.properties as Record<string, Record<string, unknown>>;
    const required = (tool.input as { required?: readonly string[] }).required;
    const request = tool.method === "POST"
      ? { requestBody: { required: true, content: { "application/json": { schema: tool.input, example: tool.example } } } }
      : { parameters: Object.entries(properties).map(([name, spec]) => ({ name, in: "query", required: required?.includes(name) ?? false, schema: spec })) };
    paths[tool.route] = { [tool.method.toLowerCase()]: {
      operationId: tool.id, summary: tool.summary, ...request,
      responses: {
        "200": { description: "Paid result", content: { "application/json": { schema: tool.output } } },
        "400": { description: "Bad input (free, before payment)", content: { "application/json": { schema: error } } },
        "402": { description: `x402 v2 payment required: ${tool.price} USDC`, headers: { "PAYMENT-REQUIRED": { description: "Base64 x402 payment challenge", schema: { type: "string" } } } },
        "429": { description: "Rate limited" }, "502": { description: "Upstream failed" }, "503": { description: "Service unavailable" }
      },
      "x-x402-price": tool.price
    } };
  }
  paths["/health"] = { get: { summary: "Free readiness check (never paid)", responses: { "200": { description: "Ready" }, "503": { description: "Misconfigured" } } } };
  return { openapi: "3.1.0", info: { title: "Solana x402 Microtools", version: "1.0.0" }, servers: [{ url: base }], paths };
}
