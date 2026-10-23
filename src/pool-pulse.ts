import { InputError } from "./inputs";
import {
  isCanonicalSolanaAddress,
  poolPulseDexFilterSchema,
  poolPulseOutputSchema,
  poolPulseWindowSchema,
  type PoolPulseDexFilter,
  type PoolPulseItem,
  type PoolPulseOutput,
  type PoolPulseWindow
} from "./pool-pulse-schemas";

export class PoolPulseError extends Error {
  constructor(
    public readonly status: 400 | 429 | 502 | 503 | 504,
    message: string
  ) {
    super(message);
    this.name = "PoolPulseError";
  }
}

export interface PoolPulseQuery {
  window: PoolPulseWindow;
  limit: number;
  min_liquidity_usd: number;
  dex: PoolPulseDexFilter;
}

const ALLOWED_PARAMS = ["window", "limit", "min_liquidity_usd", "dex"] as const;

export const RAYDIUM_DEX_IDS = new Set([
  "raydium",
  "raydium-clmm",
  "raydium-cp",
  "raydium-cpmm",
  "raydium-launchlab"
]);

export const METEORA_DEX_IDS = new Set([
  "meteora",
  "meteora-dlmm",
  "meteora-damm-v2",
  "meteora-dbc"
]);

export const PUMPSWAP_DEX_IDS = new Set([
  "pumpswap",
  "pump-fun"
]);

export const ALL_ALLOWED_DEX_IDS = new Set([
  ...RAYDIUM_DEX_IDS,
  ...METEORA_DEX_IDS,
  ...PUMPSWAP_DEX_IDS
]);

export function allowedDexSet(dex: PoolPulseDexFilter): ReadonlySet<string> {
  if (dex === "raydium") return RAYDIUM_DEX_IDS;
  if (dex === "meteora") return METEORA_DEX_IDS;
  if (dex === "pumpswap") return PUMPSWAP_DEX_IDS;
  return ALL_ALLOWED_DEX_IDS;
}

function singleParam(q: URLSearchParams, name: string): string | null {
  const all = q.getAll(name);
  if (all.length > 1) throw new InputError(`Duplicate parameter: ${name}`);
  return all[0] ?? null;
}

export function parsePoolPulseQuery(q: URLSearchParams): PoolPulseQuery {
  for (const key of q.keys()) {
    if (!ALLOWED_PARAMS.includes(key as (typeof ALLOWED_PARAMS)[number])) {
      throw new InputError(`Unknown parameter: ${key}`);
    }
  }

  const windowRaw = singleParam(q, "window") ?? "1h";
  const parsedWindow = poolPulseWindowSchema.safeParse(windowRaw);
  if (!parsedWindow.success) {
    throw new InputError("window must be one of 15m, 1h");
  }

  const limitRaw = singleParam(q, "limit");
  let limit = 10;
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw.trim())) {
      throw new InputError("limit must be an integer between 1 and 20");
    }
    limit = Number(limitRaw.trim());
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new InputError("limit must be an integer between 1 and 20");
    }
  }

  const minLiqRaw = singleParam(q, "min_liquidity_usd");
  let min_liquidity_usd = 1000;
  if (minLiqRaw !== null) {
    if (!/^\d+(?:\.\d+)?$/.test(minLiqRaw.trim())) {
      throw new InputError("min_liquidity_usd must be a number between 0 and 1000000");
    }
    min_liquidity_usd = Number(minLiqRaw.trim());
    if (!Number.isFinite(min_liquidity_usd) || min_liquidity_usd < 0 || min_liquidity_usd > 1_000_000) {
      throw new InputError("min_liquidity_usd must be a number between 0 and 1000000");
    }
  }

  const dexRaw = singleParam(q, "dex") ?? "all";
  const parsedDex = poolPulseDexFilterSchema.safeParse(dexRaw);
  if (!parsedDex.success) {
    throw new InputError("dex must be one of all, raydium, meteora, pumpswap");
  }

  return {
    window: parsedWindow.data,
    limit,
    min_liquidity_usd,
    dex: parsedDex.data
  };
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));

export function activityScore(
  liquidity: number,
  volume5m: number,
  buys5m: number,
  sells5m: number
): number {
  const txns = buys5m + sells5m;
  const V = clamp(volume5m / Math.max(liquidity, 1) / 0.5);
  const T = clamp(Math.log1p(txns) / Math.log1p(100));
  const B = txns > 0 ? buys5m / txns : 0;
  const L = clamp(Math.log1p(liquidity) / Math.log1p(100000));
  return Math.round(35 * V + 30 * T + 20 * B + 15 * L);
}

interface RawCandidatePool {
  pool_address: string;
  dex: string;
  base_mint: string;
  base_symbol: string | null;
  quote_mint: string;
  created_at: string;
  created_ms: number;
  liquidity_usd: number | null;
  volume_5m_usd: number | null;
  buys_5m: number | null;
  sells_5m: number | null;
  price_change_5m_pct: number | null;
  observed_at: string;
}

interface CachedPoolSnapshot {
  fetchedAtMs: number;
  fetchedAtIso: string;
  sources: string[];
  candidates: RawCandidatePool[];
}

const SNAPSHOT_TTL_MS = 45_000;
const MAX_STALE_MS = 180_000;
let cachedSnapshot: CachedPoolSnapshot | null = null;

export function resetPoolPulseCache(): void {
  cachedSnapshot = null;
}

const GECKOTERMINAL_URLS = [
  "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?include=base_token,quote_token,dex&page=1",
  "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?include=base_token,quote_token,dex&page=2",
  "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?include=base_token,quote_token,dex&duration=5m",
  "https://api.geckoterminal.com/api/v2/networks/solana/dexes/raydium-launchlab/pools?include=base_token,quote_token,dex",
  "https://api.geckoterminal.com/api/v2/networks/solana/dexes/meteora-damm-v2/pools?include=base_token,quote_token,dex"
] as const;

type GtPool = {
  attributes?: {
    address?: string;
    name?: string;
    pool_created_at?: string;
    reserve_in_usd?: string | number | null;
    volume_usd?: { m5?: string | number | null };
    transactions?: { m5?: { buys?: number | null; sells?: number | null } };
    price_change_percentage?: { m5?: string | number | null };
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
    quote_token?: { data?: { id?: string } };
    dex?: { data?: { id?: string } };
  };
};

type GtIncluded = {
  id?: string;
  type?: string;
  attributes?: {
    address?: string;
    symbol?: string;
  };
};

type GtResponse = {
  data?: GtPool[];
  included?: GtIncluded[];
};

type DsPair = {
  pairAddress?: string;
  dexId?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string };
  liquidity?: { usd?: number | string | null };
  volume?: { m5?: number | string | null };
  txns?: { m5?: { buys?: number | null; sells?: number | null } };
  priceChange?: { m5?: number | string | null };
  pairCreatedAt?: number;
};

function finiteNonNegativeOrNull(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number(n.toFixed(4));
}

function finiteNumberOrNull(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(4));
}

function intNonNegativeOrNull(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const n = Number(val);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function cleanSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 32);
}

function stripSolanaPrefix(id: string | undefined): string {
  if (!id) return "";
  return id.startsWith("solana_") ? id.slice("solana_".length) : id;
}

async function fetchGeckoTerminalPage(url: string): Promise<GtResponse> {
  const res = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(4500),
    headers: {
      Accept: "application/json;version=20230302",
      "User-Agent": "solana-x402-microtools/1.0"
    }
  });
  if (!res.ok) {
    throw new PoolPulseError(res.status === 429 ? 429 : 502, `GeckoTerminal HTTP ${res.status}`);
  }
  return (await res.json()) as GtResponse;
}

async function fetchFreshSnapshot(nowMs: number): Promise<CachedPoolSnapshot> {
  const observedIso = new Date(nowMs).toISOString();
  const settled = await Promise.allSettled(GECKOTERMINAL_URLS.map((u) => fetchGeckoTerminalPage(u)));
  const fulfilled = settled.filter((s): s is PromiseFulfilledResult<GtResponse> => s.status === "fulfilled");

  if (fulfilled.length === 0) {
    const firstErr = settled.find((s): s is PromiseRejectedResult => s.status === "rejected")?.reason;
    if (firstErr instanceof PoolPulseError) throw firstErr;
    throw new PoolPulseError(504, "Upstream Solana pool feeds timed out or failed");
  }

  const tokenMap = new Map<string, { address?: string; symbol?: string }>();
  for (const res of fulfilled) {
    for (const inc of res.value.included ?? []) {
      if (inc.type === "token" && inc.id) {
        tokenMap.set(inc.id, {
          address: inc.attributes?.address,
          symbol: inc.attributes?.symbol
        });
      }
    }
  }

  const byAddress = new Map<string, RawCandidatePool>();
  for (const res of fulfilled) {
    for (const pool of res.value.data ?? []) {
      const attr = pool.attributes;
      if (!attr?.address || !attr.pool_created_at) continue;
      const poolAddress = attr.address.trim();
      if (byAddress.has(poolAddress) || !isCanonicalSolanaAddress(poolAddress)) continue;

      const dexId = (pool.relationships?.dex?.data?.id ?? "").trim().toLowerCase();
      if (!ALL_ALLOWED_DEX_IDS.has(dexId)) continue;

      const baseId = pool.relationships?.base_token?.data?.id;
      const quoteId = pool.relationships?.quote_token?.data?.id;
      const baseToken = baseId ? tokenMap.get(baseId) : undefined;
      const quoteToken = quoteId ? tokenMap.get(quoteId) : undefined;

      const baseMint = (baseToken?.address ?? stripSolanaPrefix(baseId)).trim();
      const quoteMint = (quoteToken?.address ?? stripSolanaPrefix(quoteId)).trim();
      if (!isCanonicalSolanaAddress(baseMint) || !isCanonicalSolanaAddress(quoteMint)) continue;

      const createdMs = Date.parse(attr.pool_created_at);
      if (!Number.isFinite(createdMs)) continue;

      const fallbackSymbol = attr.name?.includes("/") ? attr.name.split("/")[0]?.trim() : undefined;
      const baseSymbol = cleanSymbol(baseToken?.symbol ?? fallbackSymbol);

      byAddress.set(poolAddress, {
        pool_address: poolAddress,
        dex: dexId,
        base_mint: baseMint,
        base_symbol: baseSymbol,
        quote_mint: quoteMint,
        created_at: new Date(createdMs).toISOString(),
        created_ms: createdMs,
        liquidity_usd: finiteNonNegativeOrNull(attr.reserve_in_usd),
        volume_5m_usd: finiteNonNegativeOrNull(attr.volume_usd?.m5),
        buys_5m: intNonNegativeOrNull(attr.transactions?.m5?.buys),
        sells_5m: intNonNegativeOrNull(attr.transactions?.m5?.sells),
        price_change_5m_pct: finiteNumberOrNull(attr.price_change_percentage?.m5),
        observed_at: observedIso
      });
    }
  }

  const sources: string[] = ["geckoterminal"];

  // Best-effort batch enrichment via DexScreener for recent pools (<= 65m old, up to 30 addresses)
  const recentAddrs = [...byAddress.values()]
    .filter((p) => nowMs - p.created_ms <= 65 * 60_000)
    .slice(0, 30)
    .map((p) => p.pool_address);

  if (recentAddrs.length > 0) {
    try {
      const dsRes = await fetch(
        `https://api.dexscreener.com/latest/dex/pairs/solana/${recentAddrs.join(",")}`,
        {
          method: "GET",
          signal: AbortSignal.timeout(3500),
          headers: { Accept: "application/json", "User-Agent": "solana-x402-microtools/1.0" }
        }
      );
      if (dsRes.ok) {
        const dsJson = (await dsRes.json()) as { pairs?: DsPair[] | null };
        if (Array.isArray(dsJson.pairs) && dsJson.pairs.length > 0) {
          sources.push("dexscreener");
          for (const pair of dsJson.pairs) {
            const addr = pair.pairAddress?.trim();
            if (!addr) continue;
            const existing = byAddress.get(addr);
            if (!existing) continue;
            const dsLiq = finiteNonNegativeOrNull(pair.liquidity?.usd);
            if ((existing.liquidity_usd === null || existing.liquidity_usd === 0) && dsLiq !== null) {
              existing.liquidity_usd = dsLiq;
            }
            if (existing.volume_5m_usd === null) {
              existing.volume_5m_usd = finiteNonNegativeOrNull(pair.volume?.m5);
            }
            if (existing.buys_5m === null) {
              existing.buys_5m = intNonNegativeOrNull(pair.txns?.m5?.buys);
            }
            if (existing.sells_5m === null) {
              existing.sells_5m = intNonNegativeOrNull(pair.txns?.m5?.sells);
            }
            if (existing.price_change_5m_pct === null) {
              existing.price_change_5m_pct = finiteNumberOrNull(pair.priceChange?.m5);
            }
            if (existing.base_symbol === null) {
              existing.base_symbol = cleanSymbol(pair.baseToken?.symbol);
            }
          }
        }
      }
    } catch {
      // DexScreener enrichment is optional; continue with GeckoTerminal data
    }
  }

  return {
    fetchedAtMs: nowMs,
    fetchedAtIso: observedIso,
    sources,
    candidates: [...byAddress.values()]
  };
}

export async function getPoolPulse(query: PoolPulseQuery, nowMs = Date.now()): Promise<PoolPulseOutput> {
  let snapshot = cachedSnapshot;
  if (!snapshot || nowMs - snapshot.fetchedAtMs > SNAPSHOT_TTL_MS) {
    try {
      snapshot = await fetchFreshSnapshot(nowMs);
      cachedSnapshot = snapshot;
    } catch (err) {
      if (cachedSnapshot && nowMs - cachedSnapshot.fetchedAtMs <= MAX_STALE_MS) {
        snapshot = cachedSnapshot;
      } else {
        throw err instanceof PoolPulseError
          ? err
          : new PoolPulseError(502, "Upstream Solana pool feeds unavailable");
      }
    }
  }

  const maxAgeMinutes = query.window === "15m" ? 15 : 60;
  const dexSet = allowedDexSet(query.dex);

  const scored: PoolPulseItem[] = [];
  for (const c of snapshot.candidates) {
    if (!dexSet.has(c.dex)) continue;
    const ageMinutes = Number(Math.max(0, (nowMs - c.created_ms) / 60_000).toFixed(2));
    if (ageMinutes > maxAgeMinutes) continue;
    const liq = c.liquidity_usd ?? 0;
    if (liq < query.min_liquidity_usd) continue;

    const buys = c.buys_5m;
    const sells = c.sells_5m;
    const netBuys = buys !== null && sells !== null ? buys - sells : null;
    const score = activityScore(liq, c.volume_5m_usd ?? 0, buys ?? 0, sells ?? 0);

    scored.push({
      pool_address: c.pool_address,
      dex: c.dex,
      base_mint: c.base_mint,
      base_symbol: c.base_symbol,
      quote_mint: c.quote_mint,
      created_at: c.created_at,
      age_minutes: ageMinutes,
      liquidity_usd: c.liquidity_usd,
      volume_5m_usd: c.volume_5m_usd,
      buys_5m: buys,
      sells_5m: sells,
      net_buy_transactions_5m: netBuys,
      price_change_5m_pct: c.price_change_5m_pct,
      activity_score: score,
      score_version: "1",
      observed_at: c.observed_at
    });
  }

  scored.sort((a, b) => {
    if (b.activity_score !== a.activity_score) return b.activity_score - a.activity_score;
    const volDiff = (b.volume_5m_usd ?? 0) - (a.volume_5m_usd ?? 0);
    if (volDiff !== 0) return volDiff;
    const liqDiff = (b.liquidity_usd ?? 0) - (a.liquidity_usd ?? 0);
    if (liqDiff !== 0) return liqDiff;
    return a.pool_address.localeCompare(b.pool_address);
  });

  const candidateCount = scored.length;
  const pools = scored.slice(0, query.limit);
  const cacheAgeSeconds = Math.max(0, Math.floor((nowMs - snapshot.fetchedAtMs) / 1000));

  const output: PoolPulseOutput = {
    success: true,
    network: "solana-mainnet",
    window: query.window,
    limit: query.limit,
    min_liquidity_usd: query.min_liquidity_usd,
    dex: query.dex,
    count: pools.length,
    pools,
    coverage: {
      method: "sampled_public_feeds",
      exhaustive: false,
      candidate_count: candidateCount,
      truncated: candidateCount > query.limit
    },
    source: snapshot.sources,
    fetched_at: snapshot.fetchedAtIso,
    cache_age_seconds: cacheAgeSeconds,
    disclaimer:
      "Sampled public DEX feed (not a full chain index). Newly created pools carry extreme rug, illiquidity and manipulation risk. Activity score measures 5m trading velocity and liquidity, not token safety. Pair with /api/token-check and /api/tx-preview before signing. Not financial advice."
  };

  return poolPulseOutputSchema.parse(output);
}
