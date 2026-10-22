import { CITIES, PAIRS } from "./inputs";
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
  { id: "preflight", route: "/api/preflight", price: "$0.01", summary: "Probe one public HTTPS URL without following redirects; inspect x402 v2 challenge", input: preflightInput, output: preflightOutput, example: { url: "https://x402.org" } },
  { id: "crypto", route: "/api/crypto", price: "$0.003", summary: "Indicative Solana Raydium AMM v4 vault ratios for SOL-USDC and RAY-USDC; not executable quotes or trending", input: cryptoInput, output: cryptoOutput, example: { pair: "SOL-USDC" } },
  { id: "weather", route: "/api/weather", price: "$0.003", summary: "Next six forecast points for coordinates or a supported city, MET Norway CC BY 4.0", input: weatherInput, output: weatherOutput, example: { city: "london" } }
] as const;
export function manifest(base: string, network: string, wallet: string) {
  return {
    name: "Solana x402 Microtools", version: "1.0.0", protocol: "x402", x402Version: 2,
    payment: { network, scheme: "exact", asset: "USDC", payTo: wallet, currency: "USD", header: "PAYMENT-SIGNATURE" },
    docs: `${base}/openapi.json`, health: `${base}/health`,
    attribution: { weather: "Data from MET Norway, CC BY 4.0", crypto: "On-chain pool vault balances read via Solana JSON-RPC" },
    limitations: ["Indicative reserves are not swap execution prices", "No dynamic trending, rankings or trading advice", "City lookup is a fixed list"],
    tools: TOOLS.map((x) => ({ id: x.id, method: "GET", url: `${base}${x.route}`, price: x.price, description: x.summary, inputSchema: x.input, outputSchema: x.output }))
  };
}
export function openapi(base: string) {
  const paths: Record<string, unknown> = {};
  for (const tool of TOOLS) {
    const properties = tool.input.properties as Record<string, Record<string, unknown>>;
    paths[tool.route] = { get: {
      operationId: tool.id, summary: tool.summary,
      parameters: Object.entries(properties).map(([name, spec]) => ({ name, in: "query", required: (tool.input as { required?: readonly string[] }).required?.includes(name) ?? false, schema: spec })),
      responses: {
        "200": { description: "Paid result", content: { "application/json": { schema: tool.output } } },
        "400": { description: "Bad input", content: { "application/json": { schema: error } } },
        "402": { description: `x402 v2 payment required: ${tool.price} USDC`, headers: { "PAYMENT-REQUIRED": { description: "Base64 x402 payment challenge", schema: { type: "string" } } } },
        "429": { description: "Rate limited" }, "502": { description: "Upstream failed" }, "503": { description: "Service unavailable" }
      },
      "x-x402-price": tool.price
    } };
  }
  paths["/health"] = { get: { summary: "Free readiness check (never paid)", responses: { "200": { description: "Ready" }, "503": { description: "Misconfigured" } } } };
  return { openapi: "3.1.0", info: { title: "Solana x402 Microtools", version: "1.0.0" }, servers: [{ url: base }], paths };
}
