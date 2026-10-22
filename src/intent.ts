// Deterministic intent parser + matcher (adapted from ChatGPT Pre-Sign Brief Part 2 to OUR tx-preview shape).
// Real-shape fixes: SOL = native lamports + the wallet's wSOL token delta (Jupiter wrap/unwrap), the fee is added back
// only when the wallet is the fee payer, refundable rent for NEW token accounts is added back, sends must match exactly,
// swaps within 1%, symbols resolve only via our mint-address label map (never on-chain metadata), extra SOL outflows
// on token-input swaps are caught.
import { base58 } from "@scure/base";
import { MINT_LABELS, WSOL } from "./tx-preview-analysis";
export interface IntentMatch { checked: boolean; matches: boolean; mismatches: string[]; confidence: "high" | "medium" | "low" }
export type IntentKind = "send" | "swap" | "buy" | "sell" | "approve" | "close";
export interface ParsedIntent { kind: IntentKind; amount?: string; asset?: string; target_asset?: string; recipient?: string; recipient_valid?: boolean; raw: string }
export interface IntentView {
  wallet: string; fee_payer: string;
  sol_changes: Array<{ account: string; delta_lamports: string }>;
  token_changes: Array<{ owner: string; mint: string; decimals: number; delta_raw: string }>;
  fee_estimate_lamports: string; new_token_account_rent_lamports: string;
  red_flags: Array<{ id: string }>;
  balances_known: boolean; close_own_account: boolean;
}
const AMOUNT = "(\\d+(?:\\.\\d+)?|\\.\\d+)";
const ASSET = "([A-Za-z0-9_$.-]{1,64})";
const SEND = new RegExp(`^(?:send|transfer)\\s+${AMOUNT}\\s+${ASSET}\\s+to\\s+(\\S+)$`, "i");
const TRADE = new RegExp(`^(swap|buy|sell)\\s+${AMOUNT}\\s+${ASSET}\\s+(?:for|to|into)\\s+${ASSET}$`, "i");
export const validPubkey = (v: string) => { try { return base58.decode(v).length === 32; } catch { return false; } };
const positive = (s: string) => /[1-9]/.test(s);
export function parseIntent(input?: string): ParsedIntent | null {
  if (typeof input !== "string" || !input.trim() || input.length > 200) return null;
  const raw = input.trim().replace(/\s+/g, " ");
  const send = SEND.exec(raw);
  if (send && positive(send[1])) return { kind: "send", amount: send[1], asset: send[2].replace(/^\$/, ""), recipient: send[3], recipient_valid: validPubkey(send[3]), raw };
  const trade = TRADE.exec(raw);
  if (trade && positive(trade[2])) return { kind: trade[1].toLowerCase() as "swap" | "buy" | "sell", amount: trade[2], asset: trade[3].replace(/^\$/, ""), target_asset: trade[4].replace(/^\$/, ""), raw };
  if (/^approve\s+\S.*$/i.test(raw)) return { kind: "approve", raw };
  if (/^close\s+\S.*$/i.test(raw)) return { kind: "close", raw };
  return null;
}
function decimalRaw(amount: string, decimals: number): bigint | null {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(amount)) return null;
  const [whole, frac = ""] = amount.split(".");
  if (/[1-9]/.test(frac.slice(decimals))) return null; // more precision than the asset supports
  return BigInt((whole || "0") + frac.slice(0, decimals).padEnd(decimals, "0"));
}
const abs = (a: bigint) => (a < 0n ? -a : a);
const within1pct = (obs: bigint, exp: bigint) => exp > 0n && abs(obs - exp) * 100n <= exp;
type Asset = { kind: "sol"; decimals: 9 } | { kind: "token"; mint: string; decimals: number } | { kind: "missing" } | { kind: "ambiguous" };
const LABEL_TO_MINTS = new Map<string, string[]>();
for (const [mint, label] of Object.entries(MINT_LABELS)) if (mint !== WSOL) LABEL_TO_MINTS.set(label.toLowerCase(), [...(LABEL_TO_MINTS.get(label.toLowerCase()) ?? []), mint]);
function resolveAsset(asset: string, v: IntentView): Asset {
  if (/^w?sol$/i.test(asset) || asset === WSOL) return { kind: "sol", decimals: 9 };
  const candidates = validPubkey(asset) ? [asset] : (LABEL_TO_MINTS.get(asset.toLowerCase()) ?? []);
  if (!candidates.length) return { kind: "missing" };
  const rows = v.token_changes.filter((t) => candidates.includes(t.mint));
  const mints = [...new Set(rows.map((t) => t.mint))];
  if (mints.length > 1) return { kind: "ambiguous" };
  if (!mints.length) {
    // Known asset that simply did not move: report as no flow, not as an unknown token.
    return candidates.length === 1 ? { kind: "token", mint: candidates[0], decimals: -1 } : { kind: "missing" };
  }
  return { kind: "token", mint: mints[0], decimals: rows[0].decimals };
}
const big = (s: string | undefined) => (s && /^-?\d+$/.test(s) ? BigInt(s) : 0n);
/** Effective SOL change for the wallet: lamports + wSOL token delta, with fee (if wallet pays) and new-account rent added back. */
function solEffective(v: IntentView): bigint {
  const lamports = v.sol_changes.filter((c) => c.account === v.wallet).reduce((n, c) => n + big(c.delta_lamports), 0n);
  const wsol = v.token_changes.filter((t) => t.owner === v.wallet && t.mint === WSOL).reduce((n, t) => n + big(t.delta_raw), 0n);
  const fee = v.wallet === v.fee_payer ? big(v.fee_estimate_lamports) : 0n;
  return lamports + wsol + fee + big(v.new_token_account_rent_lamports);
}
function tokenDelta(v: IntentView, owner: string, mint: string): bigint {
  return v.token_changes.filter((t) => t.owner === owner && t.mint === mint).reduce((n, t) => n + big(t.delta_raw), 0n);
}
const flow = (a: Asset, v: IntentView) => (a.kind === "sol" ? solEffective(v) : a.kind === "token" ? tokenDelta(v, v.wallet, a.mint) : 0n);
const decimalsOf = (a: Asset, v: IntentView): number | null => {
  if (a.kind === "sol") return 9;
  if (a.kind !== "token") return null;
  return a.decimals >= 0 ? a.decimals : null;
};
export function evaluateIntent(v: IntentView, intent?: string): IntentMatch {
  const p = parseIntent(intent);
  if (!p) return { checked: false, matches: false, mismatches: [], confidence: "low" };
  const mm = new Set<string>();
  if (!v.wallet || !validPubkey(v.wallet)) return { checked: true, matches: false, mismatches: ["WALLET_UNAVAILABLE"], confidence: "low" };
  if (!v.balances_known) mm.add("BALANCE_DATA_UNVERIFIED");
  // approve / close: only structural evidence, never high confidence (stays caution or worse).
  if (p.kind === "approve" || p.kind === "close") {
    const confirmed = p.kind === "approve" ? v.red_flags.some((f) => f.id === "token_approval") : v.close_own_account;
    if (!confirmed) mm.add("OPERATION_NOT_CONFIRMED");
    for (const t of v.token_changes) if (t.owner === v.wallet && t.mint !== WSOL && big(t.delta_raw) < 0n) mm.add("EXTRA_TOKEN_OUTFLOW");
    return { checked: true, matches: mm.size === 0, mismatches: [...mm], confidence: "low" };
  }
  const src = resolveAsset(p.asset!, v);
  const dst = p.target_asset ? resolveAsset(p.target_asset, v) : null;
  for (const r of [src, dst]) { if (r?.kind === "missing") mm.add("TOKEN_NOT_FOUND"); if (r?.kind === "ambiguous") mm.add("TOKEN_AMBIGUOUS"); }
  if ([src, dst].some((r) => r && (r.kind === "missing" || r.kind === "ambiguous"))) return { checked: true, matches: false, mismatches: [...mm], confidence: "low" };
  if (dst && src.kind === dst.kind && (src.kind === "sol" || (src.kind === "token" && dst.kind === "token" && src.mint === dst.mint))) mm.add("SAME_INPUT_OUTPUT_ASSET");
  const otherOutflows = (allowed: Asset[]) => {
    const allowedMints = new Set(allowed.flatMap((a) => (a.kind === "token" ? [a.mint] : a.kind === "sol" ? [WSOL] : [])));
    for (const t of v.token_changes) if (t.owner === v.wallet && !allowedMints.has(t.mint) && big(t.delta_raw) < 0n) mm.add("EXTRA_TOKEN_OUTFLOW");
    if (!allowed.some((a) => a.kind === "sol") && solEffective(v) < 0n) mm.add("EXTRA_SOL_OUTFLOW");
  };
  if (p.kind === "send") {
    if (!p.recipient_valid) mm.add("INVALID_RECIPIENT");
    const dec = decimalsOf(src, v);
    const expected = dec === null ? null : decimalRaw(p.amount!, dec);
    if (dec === null) mm.add("NO_WALLET_OUTFLOW");
    else if (expected === null || expected <= 0n) mm.add("AMOUNT_PRECISION");
    else {
      const spent = -flow(src, v);
      if (spent <= 0n) mm.add("NO_WALLET_OUTFLOW");
      else if (spent !== expected) mm.add("AMOUNT_MISMATCH");
      if (p.recipient_valid) {
        const got = src.kind === "sol"
          ? v.sol_changes.filter((c) => c.account === p.recipient).reduce((n, c) => n + big(c.delta_lamports), 0n)
          : src.kind === "token" ? tokenDelta(v, p.recipient!, src.mint) : 0n;
        if (got <= 0n) mm.add("RECIPIENT_NOT_PAID");
        else if (got !== expected) mm.add("RECIPIENT_AMOUNT_MISMATCH");
      }
    }
    otherOutflows([src]);
  } else if (dst) {
    const buy = p.kind === "buy";
    const input = buy ? dst : src, output = buy ? src : dst; // "buy X A for B": A is output, B is input
    const spend = -flow(input, v), got = flow(output, v);
    if (spend <= 0n) mm.add("NO_INPUT_OUTFLOW");
    if (got <= 0n) mm.add("NO_OUTPUT_RECEIVED");
    const dec = decimalsOf(buy ? output : input, v);
    const expected = dec === null ? null : decimalRaw(p.amount!, dec);
    if (dec !== null && (expected === null || expected <= 0n)) mm.add("AMOUNT_PRECISION");
    else if (expected !== null) {
      if (buy) { if (got > 0n && !within1pct(got, expected)) mm.add("AMOUNT_MISMATCH"); mm.add("BUY_SPEND_UNBOUNDED"); }
      else if (spend > 0n && !within1pct(spend, expected)) mm.add("AMOUNT_MISMATCH");
    }
    otherOutflows([input]);
  }
  return { checked: true, matches: mm.size === 0, mismatches: [...mm], confidence: mm.size ? "medium" : "high" };
}
