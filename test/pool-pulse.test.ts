import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  activityScore,
  getPoolPulse,
  parsePoolPulseQuery,
  PoolPulseError,
  resetPoolPulseCache
} from "../src/pool-pulse";
import { poolPulseOutputSchema } from "../src/pool-pulse-schemas";
import { TOOLS } from "../src/schemas";
import app from "../src/index";

const POOL_A = "5vY3GEbRNMy1TEpEbjovagmgz858fzjScEpfW16JGsLb";
const POOL_B = "4w5H9DzRP6Sp54cJETwimanPapLFfQNEJPaHQ6uNN8e8";
const POOL_C = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const BASE_A = "GJHofzJ7FNkZAY832mbeJVp33vRQ4NZ2MJWuutWCBAGS";
const BASE_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const QUOTE_SOL = "So11111111111111111111111111111111111111112";

test("pool-pulse query parsing: defaults, valid values, and 400 rejections", () => {
  assert.deepEqual(parsePoolPulseQuery(new URLSearchParams()), {
    window: "1h",
    limit: 10,
    min_liquidity_usd: 1000,
    dex: "all"
  });
  assert.deepEqual(
    parsePoolPulseQuery(new URLSearchParams("window=15m&limit=5&min_liquidity_usd=2500.5&dex=pumpswap")),
    {
      window: "15m",
      limit: 5,
      min_liquidity_usd: 2500.5,
      dex: "pumpswap"
    }
  );
  const bad = [
    "window=6h",
    "window=invalid",
    "limit=0",
    "limit=21",
    "limit=2.5",
    "limit=abc",
    "min_liquidity_usd=-1",
    "min_liquidity_usd=1000001",
    "min_liquidity_usd=NaN",
    "dex=orca",
    "unknown=1",
    "window=15m&window=1h"
  ];
  for (const q of bad) {
    assert.throws(() => parsePoolPulseQuery(new URLSearchParams(q)), q);
  }
});

test("activityScore: bounded 0-100 and rewards velocity, tx count, buy ratio, and liquidity", () => {
  assert.equal(activityScore(0, 0, 0, 0), 0);
  assert.equal(activityScore(100_000, 50_000, 100, 0), 100);
  const highBuy = activityScore(20_000, 5_000, 40, 10);
  const lowBuy = activityScore(20_000, 5_000, 10, 40);
  assert.ok(highBuy > lowBuy);
});

test("pool-pulse outputExample satisfies strict Zod schema", () => {
  const tool = TOOLS.find((t) => t.id === "pool-pulse")!;
  assert.ok(tool);
  assert.doesNotThrow(() => poolPulseOutputSchema.parse(tool.outputExample));
});

test("getPoolPulse: filters, deduplicates, enriches from DexScreener, caches, and handles upstream failure", async () => {
  resetPoolPulseCache();
  const nowMs = Date.parse("2026-10-23T15:40:00.000Z");
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.geckoterminal.com")) {
        return Response.json({
          data: [
            {
              id: `solana_${POOL_A}`,
              type: "pool",
              attributes: {
                address: POOL_A,
                name: "ORTHOG / SOL",
                pool_created_at: "2026-10-23T15:32:00Z", // 8m old
                reserve_in_usd: "0", // zero on GT, enriched by DexScreener to 25000
                volume_usd: { m5: "12000" },
                transactions: { m5: { buys: 60, sells: 20 } },
                price_change_percentage: { m5: "18.5" }
              },
              relationships: {
                base_token: { data: { id: `solana_${BASE_A}` } },
                quote_token: { data: { id: `solana_${QUOTE_SOL}` } },
                dex: { data: { id: "pumpswap" } }
              }
            },
            {
              id: `solana_${POOL_B}`,
              type: "pool",
              attributes: {
                address: POOL_B,
                name: "METTEST / SOL",
                pool_created_at: "2026-10-23T15:00:00Z", // 40m old
                reserve_in_usd: "15000",
                volume_usd: { m5: "3000" },
                transactions: { m5: { buys: 15, sells: 10 } },
                price_change_percentage: { m5: "-2.1" }
              },
              relationships: {
                base_token: { data: { id: `solana_${BASE_B}` } },
                quote_token: { data: { id: `solana_${QUOTE_SOL}` } },
                dex: { data: { id: "meteora-damm-v2" } }
              }
            },
            {
              id: `solana_${POOL_C}`,
              type: "pool",
              attributes: {
                address: POOL_C,
                name: "RAYTEST / SOL",
                pool_created_at: "2026-10-23T15:30:00Z", // 10m old, low liquidity (500)
                reserve_in_usd: "500",
                volume_usd: { m5: "200" },
                transactions: { m5: { buys: 5, sells: 2 } },
                price_change_percentage: { m5: "1.0" }
              },
              relationships: {
                base_token: { data: { id: `solana_${BASE_A}` } },
                quote_token: { data: { id: `solana_${QUOTE_SOL}` } },
                dex: { data: { id: "raydium" } }
              }
            }
          ],
          included: [
            { id: `solana_${BASE_A}`, type: "token", attributes: { address: BASE_A, symbol: "ORTHOG" } },
            { id: `solana_${BASE_B}`, type: "token", attributes: { address: BASE_B, symbol: "METTEST" } },
            { id: `solana_${QUOTE_SOL}`, type: "token", attributes: { address: QUOTE_SOL, symbol: "SOL" } }
          ]
        });
      }
      if (url.includes("api.dexscreener.com")) {
        return Response.json({
          pairs: [
            {
              pairAddress: POOL_A,
              liquidity: { usd: 25000 },
              baseToken: { address: BASE_A, symbol: "ORTHOG" }
            }
          ]
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const r1 = await getPoolPulse({ window: "1h", limit: 10, min_liquidity_usd: 1000, dex: "all" }, nowMs);
    assert.equal(r1.count, 2);
    assert.deepEqual(r1.source, ["geckoterminal", "dexscreener"]);
    assert.equal(r1.pools[0].pool_address, POOL_A);
    assert.equal(r1.pools[0].liquidity_usd, 25000);
    assert.equal(r1.pools[0].net_buy_transactions_5m, 40);
    assert.equal(r1.pools[1].pool_address, POOL_B);

    // 15m window excludes POOL_B (40m old); cached snapshot is reused with cache_age_seconds = 10
    const r2 = await getPoolPulse({ window: "15m", limit: 1, min_liquidity_usd: 100, dex: "all" }, nowMs + 10_000);
    assert.equal(r2.cache_age_seconds, 10);
    assert.equal(r2.coverage.candidate_count, 2); // POOL_A and POOL_C
    assert.equal(r2.coverage.truncated, true);
    assert.equal(r2.count, 1);

    // Upstream failure with fresh/stale cache falls back to cache; with empty cache throws 502/504
    resetPoolPulseCache();
    globalThis.fetch = (async () => new Response("error", { status: 503 })) as typeof fetch;
    await assert.rejects(
      getPoolPulse({ window: "1h", limit: 10, min_liquidity_usd: 1000, dex: "all" }, nowMs),
      (e: PoolPulseError) => e.status === 502
    );
  } finally {
    globalThis.fetch = origFetch;
    resetPoolPulseCache();
  }
});

test("app routes: /api/pool-pulse bad query -> free 400; /mcp JSON-RPC initialize, tools/list, tools/call", async () => {
  const env = {
    NETWORK: "mainnet" as const,
    PAY_TO_ADDRESS: "Aqgp4nKbk3WV1e7fLHepkcdwLLz3j8DwHqLTLHVEa6GK",
    FACILITATOR_URL: "https://facilitator.payai.network",
    RATE_LIMIT_SALT: "x".repeat(40),
    MET_CONTACT: "valecity@mail.grokbot.com",
    SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    INBOUND_LIMIT: { limit: async () => ({ success: true }) },
    UPSTREAM_LIMIT: { limit: async () => ({ success: true }) }
  };

  const badQuery = await app.request("https://example.com/api/pool-pulse?window=99h", {}, env);
  assert.equal(badQuery.status, 400);
  assert.equal(badQuery.headers.get("PAYMENT-REQUIRED"), null);

  const getMcp = await app.request("https://example.com/mcp", { method: "GET" }, env);
  assert.equal(getMcp.status, 200);
  const mcpMeta = (await getMcp.json()) as { tools: unknown[] };
  assert.equal(mcpMeta.tools.length, 6);

  const initRes = await app.request(
    "https://example.com/mcp",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })
    },
    env
  );
  assert.equal(initRes.status, 200);
  const initJson = (await initRes.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
  assert.equal(initJson.result.protocolVersion, "2025-03-26");
  assert.equal(initJson.result.serverInfo.name, "solana-x402-microtools");

  const listRes = await app.request(
    "https://example.com/mcp",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    },
    env
  );
  assert.equal(listRes.status, 200);
  const listJson = (await listRes.json()) as { result: { tools: Array<{ name: string }> } };
  assert.deepEqual(
    listJson.result.tools.map((t) => t.name),
    [
      "solana_preflight",
      "solana_crypto_market",
      "weather_forecast",
      "solana_token_check",
      "solana_transaction_preview",
      "solana_pool_pulse"
    ]
  );

  const callRes = await app.request(
    "https://example.com/mcp",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "solana_pool_pulse", arguments: {} } })
    },
    env
  );
  assert.equal(callRes.status, 200);
  const callJson = (await callRes.json()) as { result: { content: Array<{ text: string }> } };
  assert.match(callJson.result.content[0].text, /\/api\/pool-pulse/);
});
