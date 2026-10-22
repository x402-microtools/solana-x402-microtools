// getRecentPrioritizationFees summary (adapted from ChatGPT Pre-Sign Brief Part 4).
// UNIT RESOLVED: the official RPC docs (https://solana.com/docs/rpc/http/getrecentprioritizationfees, checked
// 2026-10-22) define `prioritizationFee` as "Prioritization fee, in micro-lamports per compute unit, observed for that
// slot", i.e. the same unit as ComputeBudget SetComputeUnitPrice. Samples reflect transactions that lock ALL supplied
// writable accounts, are per-slot minimums, and are often 0, so this is a market hint, not a guarantee of landing.
// Non-fatal: any failure returns null and never changes the HTTP status.
import { rpc } from "./rpc";
export const MAX_WRITABLE_ACCOUNTS = 128; // RPC limit
export const MAX_FEE_SAMPLES = 150;
export const MIN_RELIABLE_SAMPLES = 5;
export interface PriorityFee {
  unit: "micro_lamports_per_compute_unit";
  recommended_micro_lamports: number | null; // = p75 of non-zero samples
  recent_median: number | null;
  recent_p75: number | null;
  sample_count: number;   // non-zero samples
  samples_total: number;
  note: "p75_nonzero" | "sparse_data";
  tx_compute_unit_price_micro_lamports: string;
  tx_compute_unit_limit: number | null;
  /** ceil(recommended * tx CU limit / 1e6); null when the tx sets no explicit CU limit or there is no recommendation. */
  estimated_priority_fee_lamports_at_recommended: string | null;
  accounts_queried: number;
}
function sampleValue(v: unknown): number {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  throw new TypeError("Malformed priority fee value");
}
export function analyzePriorityFees(samples: unknown): Omit<PriorityFee, "unit" | "tx_compute_unit_price_micro_lamports" | "tx_compute_unit_limit" | "estimated_priority_fee_lamports_at_recommended" | "accounts_queried"> {
  if (!Array.isArray(samples) || samples.length > MAX_FEE_SAMPLES) throw new TypeError("Malformed priority fee response");
  const values = samples.map((s) => {
    if (!s || typeof s !== "object" || !Number.isSafeInteger((s as { slot?: unknown }).slot)) throw new TypeError("Malformed fee sample");
    return sampleValue((s as { prioritizationFee?: unknown }).prioritizationFee);
  });
  const pos = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!pos.length) return { recommended_micro_lamports: null, recent_median: null, recent_p75: null, sample_count: 0, samples_total: values.length, note: "sparse_data" };
  const i = Math.floor(pos.length / 2);
  const median = pos.length % 2 ? pos[i] : Math.round(pos[i - 1] / 2 + pos[i] / 2);
  const p75 = pos[Math.max(0, Math.ceil(pos.length * 0.75) - 1)];
  return { recommended_micro_lamports: p75, recent_median: median, recent_p75: p75, sample_count: pos.length, samples_total: values.length, note: pos.length < MIN_RELIABLE_SAMPLES ? "sparse_data" : "p75_nonzero" };
}
export function priorityFeeLamports(priceMicroLamports: number, cuLimit: number): bigint {
  if (!Number.isSafeInteger(priceMicroLamports) || priceMicroLamports < 0) throw new RangeError("Invalid CU price");
  if (!Number.isSafeInteger(cuLimit) || cuLimit < 1 || cuLimit > 1_400_000) throw new RangeError("Invalid CU limit");
  return (BigInt(priceMicroLamports) * BigInt(cuLimit) + 999_999n) / 1_000_000n;
}
/** Server-derived writable accounts only (static writable + resolved ALT writable). One RPC try, short timeout. */
export async function getPriorityFee(rpcUrl: string, writable: readonly string[], tx: { cuLimit: number | null; cuPrice: string }): Promise<PriorityFee | null> {
  try {
    const accounts = [...new Set(writable)];
    if (!accounts.length || accounts.length > MAX_WRITABLE_ACCOUNTS) return null;
    const firstUrl = rpcUrl.split(",").map((u) => u.trim()).filter(Boolean)[0];
    if (!firstUrl) return null;
    const samples = await rpc<unknown>(firstUrl, "getRecentPrioritizationFees", [accounts], { timeoutMs: 2500 });
    const stats = analyzePriorityFees(samples);
    return {
      unit: "micro_lamports_per_compute_unit", ...stats,
      tx_compute_unit_price_micro_lamports: tx.cuPrice, tx_compute_unit_limit: tx.cuLimit,
      estimated_priority_fee_lamports_at_recommended: stats.recommended_micro_lamports !== null && tx.cuLimit
        ? priorityFeeLamports(stats.recommended_micro_lamports, tx.cuLimit).toString() : null,
      accounts_queried: accounts.length
    };
  } catch { return null; }
}
