import { base58 } from "@scure/base";
import { z } from "zod";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isCanonicalSolanaAddress(value: string): boolean {
  if (!BASE58.test(value)) return false;
  try {
    const decoded = base58.decode(value);
    return decoded.length === 32 && base58.encode(decoded) === value;
  } catch {
    return false;
  }
}

export const solanaAddressSchema = z
  .string()
  .min(32)
  .max(44)
  .regex(BASE58)
  .refine(isCanonicalSolanaAddress, "Must be a canonical 32-byte Solana public key in base58");

export const poolPulseWindowSchema = z.enum(["15m", "1h"]);
export type PoolPulseWindow = z.infer<typeof poolPulseWindowSchema>;

export const poolPulseDexFilterSchema = z.enum(["all", "raydium", "meteora", "pumpswap"]);
export type PoolPulseDexFilter = z.infer<typeof poolPulseDexFilterSchema>;

export const poolPulseItemSchema = z
  .object({
    pool_address: solanaAddressSchema,
    dex: z.string().min(1),
    base_mint: solanaAddressSchema,
    base_symbol: z.string().min(1).max(32).nullable(),
    quote_mint: solanaAddressSchema,
    created_at: z.string().datetime(),
    age_minutes: z.number().min(0),
    liquidity_usd: z.number().min(0).nullable(),
    volume_5m_usd: z.number().min(0).nullable(),
    buys_5m: z.number().int().min(0).nullable(),
    sells_5m: z.number().int().min(0).nullable(),
    net_buy_transactions_5m: z.number().int().nullable(),
    price_change_5m_pct: z.number().nullable(),
    activity_score: z.number().int().min(0).max(100),
    score_version: z.literal("1"),
    observed_at: z.string().datetime()
  })
  .strict();

export type PoolPulseItem = z.infer<typeof poolPulseItemSchema>;

export const poolPulseOutputSchema = z
  .object({
    success: z.literal(true),
    network: z.literal("solana-mainnet"),
    window: poolPulseWindowSchema,
    limit: z.number().int().min(1).max(20),
    min_liquidity_usd: z.number().min(0).max(1_000_000),
    dex: poolPulseDexFilterSchema,
    count: z.number().int().min(0).max(20),
    pools: z.array(poolPulseItemSchema).max(20),
    coverage: z
      .object({
        method: z.literal("sampled_public_feeds"),
        exhaustive: z.literal(false),
        candidate_count: z.number().int().min(0),
        truncated: z.boolean()
      })
      .strict(),
    source: z.array(z.string().min(1)).min(1),
    fetched_at: z.string().datetime(),
    cache_age_seconds: z.number().int().min(0),
    disclaimer: z.string().min(1)
  })
  .strict();

export type PoolPulseOutput = z.infer<typeof poolPulseOutputSchema>;

const addressJson = {
  type: "string",
  pattern: "^[1-9A-HJ-NP-Za-km-z]{32,44}$",
  description: "Canonical 32-byte Solana public key in base58"
};

export const poolPulseInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    window: {
      type: "string",
      enum: ["15m", "1h"],
      default: "1h",
      description: "Maximum pool age window: pools created within the last 15m or 1h"
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      default: 10,
      description: "Maximum number of ranked pools to return (1-20)"
    },
    min_liquidity_usd: {
      type: "number",
      minimum: 0,
      maximum: 1000000,
      default: 1000,
      description: "Minimum USD liquidity filter (0-1000000)"
    },
    dex: {
      type: "string",
      enum: ["all", "raydium", "meteora", "pumpswap"],
      default: "all",
      description: "Filter by DEX family (all, raydium, meteora, pumpswap)"
    }
  }
} as const;

export const poolPulseOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "success",
    "network",
    "window",
    "limit",
    "min_liquidity_usd",
    "dex",
    "count",
    "pools",
    "coverage",
    "source",
    "fetched_at",
    "cache_age_seconds",
    "disclaimer"
  ],
  properties: {
    success: { type: "boolean", const: true },
    network: { type: "string", const: "solana-mainnet" },
    window: { type: "string", enum: ["15m", "1h"] },
    limit: { type: "integer", minimum: 1, maximum: 20 },
    min_liquidity_usd: { type: "number", minimum: 0, maximum: 1000000 },
    dex: { type: "string", enum: ["all", "raydium", "meteora", "pumpswap"] },
    count: { type: "integer", minimum: 0, maximum: 20 },
    pools: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "pool_address",
          "dex",
          "base_mint",
          "base_symbol",
          "quote_mint",
          "created_at",
          "age_minutes",
          "liquidity_usd",
          "volume_5m_usd",
          "buys_5m",
          "sells_5m",
          "net_buy_transactions_5m",
          "price_change_5m_pct",
          "activity_score",
          "score_version",
          "observed_at"
        ],
        properties: {
          pool_address: addressJson,
          dex: { type: "string" },
          base_mint: addressJson,
          base_symbol: { type: ["string", "null"] },
          quote_mint: addressJson,
          created_at: { type: "string", format: "date-time" },
          age_minutes: { type: "number", minimum: 0 },
          liquidity_usd: { type: ["number", "null"], minimum: 0 },
          volume_5m_usd: { type: ["number", "null"], minimum: 0 },
          buys_5m: { type: ["integer", "null"], minimum: 0 },
          sells_5m: { type: ["integer", "null"], minimum: 0 },
          net_buy_transactions_5m: { type: ["integer", "null"] },
          price_change_5m_pct: { type: ["number", "null"] },
          activity_score: { type: "integer", minimum: 0, maximum: 100 },
          score_version: { type: "string", const: "1" },
          observed_at: { type: "string", format: "date-time" }
        }
      }
    },
    coverage: {
      type: "object",
      additionalProperties: false,
      required: ["method", "exhaustive", "candidate_count", "truncated"],
      properties: {
        method: { type: "string", const: "sampled_public_feeds" },
        exhaustive: { type: "boolean", const: false },
        candidate_count: { type: "integer", minimum: 0 },
        truncated: { type: "boolean" }
      }
    },
    source: {
      type: "array",
      minItems: 1,
      items: { type: "string" }
    },
    fetched_at: { type: "string", format: "date-time" },
    cache_age_seconds: { type: "integer", minimum: 0 },
    disclaimer: { type: "string" }
  }
} as const;
