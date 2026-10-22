// Pre-Sign Brief v1.0 (adapted from ChatGPT Part 1). Additive fields on top of the tx-preview response.
// Verdict rules (documented in README):
//  avoid   = simulation failed, any `critical` red flag (incl. tokenized_equity_counterfeit)
//  caution = any `warning` red flag (incl. intent_identity_unverified), or a checked intent that does not match
//  clear   = success, no critical/warning flags, intent matches with high confidence or no intent given.
//  `info` flags (extra_signers, wallet_not_signer) are reported but do not change the verdict.
//  unknown_program is only raised for TOP-LEVEL programs outside our known list (Jupiter, Raydium, Orca, Meteora,
//  Pump.fun, ...), so normal Jupiter swaps routing through other AMMs via CPI stay clear.
// clear never authorises signing; it means "no problem found by these rules".
import { evaluateIntent, type IntentMatch } from "./intent";
import { checkTokenizedEquity, type EquityContext, type TokenizedEquityResult } from "./equities";
import { getPriorityFee, type PriorityFee } from "./priority-fee";
import { MINT_LABELS, WSOL, type PreviewFacts, type RedFlag } from "./tx-preview-analysis";
export type Verdict = "clear" | "caution" | "avoid";
export type PreviewLike = {
  success: boolean; wallet: string; fee_payer: string;
  sol_changes: Array<{ account: string; delta_lamports: string }>;
  token_changes: Array<{ owner: string; mint: string; decimals: number; delta_raw: string; is_wallet: boolean }>;
  programs: unknown[]; red_flags: RedFlag[];
  fee_estimate_lamports: string; new_token_account_rent_lamports: string;
  compute_unit_limit: number | null; compute_unit_price_micro_lamports: string;
};
export interface BriefInput { intent?: string; context?: EquityContext }
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError("Non-finite"); return JSON.stringify(value); }
  if (Array.isArray(value)) return "[" + value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",") + "]";
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
  }
  throw new TypeError("Not JSON");
}
export async function computeBriefHash(p: { success: boolean; sol_changes: unknown; token_changes: unknown; programs: unknown; red_flags: unknown; verdict: Verdict }): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({ success: p.success, sol_changes: p.sol_changes, token_changes: p.token_changes, programs: p.programs, red_flags: p.red_flags, verdict: p.verdict }));
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "sha256:" + Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function deriveVerdict(success: boolean, flags: RedFlag[], intent: IntentMatch): { verdict: Verdict; reasons: string[] } {
  const reasons: string[] = [];
  let avoid = !success, caution = false;
  for (const f of flags) {
    if (f.severity === "critical") { avoid = true; reasons.push(f.id.toUpperCase()); }
    else if (f.severity === "warning") { caution = true; reasons.push(f.id.toUpperCase()); }
  }
  if (!success && !reasons.includes("SIMULATION_FAILED")) reasons.unshift("SIMULATION_FAILED");
  if (intent.checked && !intent.matches) {
    caution = true;
    if (!intent.mismatches.length) reasons.push("INTENT_MISMATCH");
    for (const m of intent.mismatches) reasons.push(m.startsWith("INTENT_") ? m : `INTENT_${m}`);
  }
  return { verdict: avoid ? "avoid" : caution ? "caution" : "clear", reasons: [...new Set(reasons)] };
}
const TRUSTED = new Set(Object.keys(MINT_LABELS));
export async function buildBrief<T extends PreviewLike>(preview: T, facts: PreviewFacts, input: BriefInput, rpcUrl: string | null) {
  const flags: RedFlag[] = [...preview.red_flags];
  let intent: IntentMatch;
  try {
    intent = evaluateIntent({ ...preview, balances_known: facts.balances_known, close_own_account: facts.close_own_account }, input.intent);
  } catch {
    intent = { checked: true, matches: false, mismatches: ["INTENT_EVALUATION_ERROR"], confidence: "low" };
    flags.push({ id: "intent_evaluation_error", severity: "critical", message: "Intent verification failed internally; treat as unverified." });
  }
  // Part 7 correction: a match without verified asset identity / operation details cannot be CLEAR.
  if (intent.checked && intent.matches && intent.confidence !== "high") {
    flags.push({ id: "intent_identity_unverified", severity: "warning", message: "The intent matched, but the asset identity or operation details could not be fully verified (e.g. approve/close intents)." });
  }
  let equity: TokenizedEquityResult;
  try {
    const walletMints = preview.token_changes.filter((t) => t.is_wallet && t.mint !== WSOL).map((t) => t.mint);
    equity = checkTokenizedEquity(walletMints, TRUSTED, input.context);
    if (equity.counterfeit_risk) flags.push({ id: "tokenized_equity_counterfeit", severity: "critical", message: `Claimed tokenized stock is not a verified issuer mint: ${equity.reason}. This means unverified, not proven fraud.` });
  } catch {
    equity = { checked_mints: [], claimed_mint: null, counterfeit_risk: false, reason: null };
    flags.push({ id: "equity_check_failed", severity: "critical", message: "Tokenized-equity check failed internally." });
  }
  const { verdict, reasons } = deriveVerdict(preview.success, flags, intent);
  // Optional, non-fatal; skipped when lookup-table writable accounts were not resolved (fail closed).
  let priority_fee: PriorityFee | null = null;
  if (rpcUrl && facts.lookups_resolved && facts.writable_accounts.length) {
    priority_fee = await getPriorityFee(rpcUrl, facts.writable_accounts, { cuLimit: preview.compute_unit_limit, cuPrice: preview.compute_unit_price_micro_lamports });
  }
  const brief_hash = await computeBriefHash({ ...preview, red_flags: flags, verdict });
  return { ...preview, red_flags: flags, schema_version: "1.0" as const, verdict, reasons, intent_match: intent, priority_fee, tokenized_equity: equity, brief_hash };
}
