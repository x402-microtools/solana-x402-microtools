/** Pure analysis of a simulateTransaction result. No network; unit-testable. */
import { base58 } from "@scure/base";
import { accountKeys, type ParsedTx } from "./tx-preview-wire";
export const SYSTEM = "11111111111111111111111111111111";
export const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";
export const KNOWN_PROGRAMS: Record<string, string> = {
  [SYSTEM]: "System", [TOKEN]: "SPL Token", [TOKEN_2022]: "Token-2022", [COMPUTE_BUDGET]: "Compute Budget",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Account",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo", Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: "Memo (v1)",
  AddressLookupTab1e1111111111111111111111111: "Address Lookup Table", Stake11111111111111111111111111111111111111: "Stake",
  Ed25519SigVerify111111111111111111111111111: "Ed25519 precompile", KeccakSecp256k11111111111111111111111111111: "Secp256k1 precompile",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter Aggregator v6",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4", CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "Raydium CPMM", whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpool",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM", Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: "Meteora Pools",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun", pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap AMM"
};
const MINT_LABELS: Record<string, string> = {
  [WSOL]: "wSOL", EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC", Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: "BONK", JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP"
};
export type TokenBalance = { accountIndex: number; mint: string; owner?: string; programId?: string; uiTokenAmount: { amount: string; decimals: number } };
export type InnerIx = { programId?: string; program?: string; parsed?: { type?: string; info?: Record<string, unknown> } | string; accounts?: string[]; data?: string; stackHeight?: number };
export interface SimValue {
  err: unknown;
  logs?: string[] | null;
  unitsConsumed?: number;
  fee?: number | null;
  preBalances?: number[] | null;
  postBalances?: number[] | null;
  preTokenBalances?: TokenBalance[] | null;
  postTokenBalances?: TokenBalance[] | null;
  loadedAddresses?: { writable: string[]; readonly: string[] } | null;
  innerInstructions?: Array<{ index: number; instructions: InnerIx[] }> | null;
}
export type Severity = "critical" | "warning" | "info";
export type RedFlag = { id: string; severity: Severity; message: string; instruction?: string };
type Action = { type: string; program: string; info: Record<string, unknown>; where: string };
export function lamportsToSol(l: bigint): string { return formatUnits(l, 9); }
export function formatUnits(raw: bigint, decimals: number): string {
  const neg = raw < 0n, v = neg ? -raw : raw;
  if (decimals === 0) return (neg ? "-" : "") + v.toString();
  const s = v.toString().padStart(decimals + 1, "0");
  const out = `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, "");
  return (neg && out !== "0" ? "-" : "") + out;
}
const u32 = (d: Uint8Array, o: number) => d.length >= o + 4 ? new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o, true) : null;
const u64 = (d: Uint8Array, o: number) => d.length >= o + 8 ? new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true) : null;
const AUTH_TYPES = ["mintTokens", "freezeAccount", "accountOwner", "closeAccount"];
/** Decode the few top-level instructions that matter for red flags into the same shape RPC uses for parsed inner ixs. */
function decodeTopLevel(program: string, accs: string[], data: Uint8Array): { type: string; info: Record<string, unknown> } | null {
  if (program === SYSTEM) {
    const tag = u32(data, 0);
    if (tag === 1) return { type: "assign", info: { account: accs[0], owner: data.length >= 36 ? base58.encode(data.subarray(4, 36)) : null } };
    if (tag === 2) return { type: "transfer", info: { source: accs[0], destination: accs[1], lamports: u64(data, 4)?.toString() } };
    if (tag === 10) return { type: "assignWithSeed", info: { account: accs[0], base: accs[1] } };
    return null;
  }
  if (program === TOKEN || program === TOKEN_2022) {
    const tag = data[0];
    if (tag === 4) return { type: "approve", info: { source: accs[0], delegate: accs[1], owner: accs[2], amount: u64(data, 1)?.toString() } };
    if (tag === 13) return { type: "approveChecked", info: { source: accs[0], mint: accs[1], delegate: accs[2], owner: accs[3], tokenAmount: { amount: u64(data, 1)?.toString() } } };
    if (tag === 6) {
      const hasNew = data[2] === 1 && data.length >= 35;
      return { type: "setAuthority", info: { account: accs[0], authority: accs[1], authorityType: AUTH_TYPES[data[1]] ?? `type${data[1]}`, newAuthority: hasNew ? base58.encode(data.subarray(3, 35)) : null } };
    }
    if (tag === 9) return { type: "closeAccount", info: { account: accs[0], destination: accs[1], owner: accs[2] } };
    return null;
  }
  return null;
}
function computeBudget(tx: ParsedTx): { limit: number | null; microLamports: bigint } {
  let limit: number | null = null, price = 0n;
  for (const ix of tx.instructions) {
    if (tx.staticKeys[ix.programIndex] !== COMPUTE_BUDGET) continue;
    if (ix.data[0] === 2) limit = u32(ix.data, 1);
    if (ix.data[0] === 3) price = u64(ix.data, 1) ?? 0n;
  }
  return { limit, microLamports: price };
}
/** Fallback fee estimate when the RPC does not report `fee`: 5000 lamports/signature + ceil(price * requested CU limit / 1e6). */
export function estimateFee(tx: ParsedTx): bigint {
  const { limit, microLamports } = computeBudget(tx);
  const nonBudget = tx.instructions.filter((ix) => tx.staticKeys[ix.programIndex] !== COMPUTE_BUDGET).length;
  const cu = BigInt(limit ?? Math.min(1_400_000, 200_000 * nonBudget));
  return 5000n * BigInt(tx.signatureCount) + (microLamports * cu + 999_999n) / 1_000_000n;
}
export function describeError(err: unknown, programAt: (i: number) => string): string | null {
  if (err === null || err === undefined) return null;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err && "InstructionError" in err) {
    const [i, inner] = (err as { InstructionError: [number, unknown] }).InstructionError;
    const prog = programAt(i);
    const name = KNOWN_PROGRAMS[prog] ?? prog;
    let why: string;
    if (inner && typeof inner === "object" && "Custom" in inner) why = `custom program error 0x${Number((inner as { Custom: number }).Custom).toString(16)}`;
    else why = typeof inner === "string" ? inner : JSON.stringify(inner);
    return `Instruction ${i} (${name}) failed: ${why}`;
  }
  return JSON.stringify(err).slice(0, 300);
}
export function analyze(tx: ParsedTx, sim: SimValue, wallet?: string) {
  const loaded = sim.loadedAddresses ?? { writable: [], readonly: [] };
  const { keys } = accountKeys(tx, loaded);
  const me = wallet ?? tx.feePayer;
  const watched = new Set([me, tx.feePayer]);
  const flags: RedFlag[] = [];
  const pre = sim.preBalances ?? [], post = sim.postBalances ?? [];
  const balancesKnown = pre.length === keys.length && post.length === keys.length;
  // SOL changes: watched accounts always; other accounts with a non-zero delta (capped).
  const solChanges: Array<{ account: string; before_lamports: string; after_lamports: string; delta_lamports: string; delta_sol: string; is_wallet: boolean; is_fee_payer: boolean }> = [];
  let walletSol: { before: bigint; after: bigint } | null = null;
  if (balancesKnown) {
    keys.forEach((k, i) => {
      const b = BigInt(pre[i]), a = BigInt(post[i]);
      if (k === me) walletSol = { before: b, after: a };
      if (!watched.has(k) && a === b) return;
      solChanges.push({ account: k, before_lamports: b.toString(), after_lamports: a.toString(), delta_lamports: (a - b).toString(), delta_sol: lamportsToSol(a - b), is_wallet: k === me, is_fee_payer: k === tx.feePayer });
    });
    solChanges.sort((x, y) => Number(y.is_wallet) - Number(x.is_wallet) || Number(y.is_fee_payer) - Number(x.is_fee_payer));
  }
  const otherSolOmitted = Math.max(0, solChanges.length - 25);
  solChanges.splice(25);
  // Token changes per owner+mint (from pre/postTokenBalances). Accounts absent before were created; absent after were closed.
  const ownerOf = new Map<string, string>(); // token account -> owner
  const agg = new Map<string, { owner: string; mint: string; decimals: number; program: string | null; before: bigint; after: bigint; accounts: Set<string> }>();
  const add = (list: TokenBalance[] | null | undefined, side: "before" | "after") => {
    for (const t of list ?? []) {
      const acct = keys[t.accountIndex];
      if (!acct || !t.owner || !/^\d+$/.test(t.uiTokenAmount?.amount ?? "")) continue;
      ownerOf.set(acct, t.owner);
      const id = `${t.owner}|${t.mint}`;
      const row = agg.get(id) ?? { owner: t.owner, mint: t.mint, decimals: t.uiTokenAmount.decimals, program: t.programId ?? null, before: 0n, after: 0n, accounts: new Set<string>() };
      row[side] += BigInt(t.uiTokenAmount.amount); row.accounts.add(acct); agg.set(id, row);
    }
  };
  add(sim.preTokenBalances, "before"); add(sim.postTokenBalances, "after");
  // Rent locked into NEW token accounts owned by the wallet (refundable when the account is closed).
  let newAccountRent = 0n, newAccounts = 0;
  if (balancesKnown) keys.forEach((k, i) => {
    if (watched.has(ownerOf.get(k) ?? "") && !watched.has(k) && pre[i] === 0 && post[i] > 0) { newAccountRent += BigInt(post[i]); newAccounts++; }
  });
  const tokenChanges = [...agg.values()].filter((r) => watched.has(r.owner) && r.before !== r.after).map((r) => ({
    owner: r.owner, mint: r.mint, symbol: MINT_LABELS[r.mint] ?? null, token_program: r.program === TOKEN_2022 ? "token-2022" : r.program === TOKEN ? "spl-token" : r.program,
    decimals: r.decimals, before: formatUnits(r.before, r.decimals), after: formatUnits(r.after, r.decimals), delta: formatUnits(r.after - r.before, r.decimals),
    delta_raw: (r.after - r.before).toString(), is_wallet: r.owner === me, token_accounts: [...r.accounts]
  }));
  // Programs and actions (top-level decoded here; inner ones as parsed by the RPC).
  const programs = new Map<string, { id: string; name: string | null; known: boolean; top_level: boolean }>();
  const seeProgram = (id: string, top: boolean) => {
    const p = programs.get(id) ?? { id, name: KNOWN_PROGRAMS[id] ?? null, known: id in KNOWN_PROGRAMS, top_level: false };
    p.top_level ||= top; programs.set(id, p);
  };
  const actions: Action[] = [];
  tx.instructions.forEach((ix, i) => {
    const program = tx.staticKeys[ix.programIndex];
    seeProgram(program, true);
    const d = decodeTopLevel(program, ix.accounts.map((a) => keys[a] ?? `#${a}`), ix.data);
    if (d) actions.push({ ...d, program, where: `#${i}` });
  });
  for (const group of sim.innerInstructions ?? []) {
    group.instructions.forEach((ix, j) => {
      if (typeof ix.programId === "string") seeProgram(ix.programId, false);
      if (ix.parsed && typeof ix.parsed === "object" && typeof ix.parsed.type === "string") {
        actions.push({ type: ix.parsed.type, program: ix.programId ?? "", info: ix.parsed.info ?? {}, where: `#${group.index}.${j + 1}` });
      }
    });
  }
  const mine = (acct: unknown) => typeof acct === "string" && (watched.has(acct) || watched.has(ownerOf.get(acct) ?? ""));
  for (const a of actions) {
    const info = a.info;
    if ((a.type === "approve" || a.type === "approveChecked") && (mine(info.source) || mine(info.owner))) {
      flags.push({ id: "token_approval", severity: "critical", instruction: a.where,
        message: `Grants ${String(info.delegate)} a delegate allowance over your token account ${String(info.source)}; the delegate can move those tokens later without asking.` });
    }
    if (a.type === "setAuthority" && (mine(info.account) || mine(info.authority) || mine(info.mint))) {
      const owner = info.authorityType === "accountOwner";
      flags.push({ id: owner ? "token_account_owner_change" : "authority_change", severity: "critical", instruction: a.where,
        message: `Changes the ${String(info.authorityType)} authority of ${String(info.account ?? info.mint)} to ${info.newAuthority ? String(info.newAuthority) : "none"}.` });
    }
    if (a.type === "closeAccount" && mine(info.account) && !watched.has(String(info.destination))) {
      flags.push({ id: "close_account_to_other", severity: "critical", instruction: a.where,
        message: `Closes your token account ${String(info.account)} and sends its rent/SOL to someone else (${String(info.destination)}).` });
    }
    if ((a.type === "assign" || a.type === "assignWithSeed") && watched.has(String(info.account))) {
      flags.push({ id: "wallet_owner_reassigned", severity: "critical", instruction: a.where,
        message: `Reassigns the owner program of your wallet ${String(info.account)}${info.owner ? ` to ${String(info.owner)}` : ""}; this is a known wallet-drainer pattern.` });
    }
  }
  const unknownTop = [...programs.values()].filter((p) => p.top_level && !p.known);
  for (const p of unknownTop) flags.push({ id: "unknown_program", severity: "warning", message: `Calls a program not on our known list: ${p.id}. Check it before signing.` });
  if (walletSol !== null) {
    const ws = walletSol as { before: bigint; after: bigint };
    if (ws.before > 0n && ws.after * 10n < ws.before) {
      flags.push({ id: "wallet_loses_over_90pct_sol", severity: "critical", message: `Your SOL balance drops by more than 90% (${lamportsToSol(ws.before)} → ${lamportsToSol(ws.after)} SOL).` });
    }
  }
  if (wallet && !tx.signers.includes(wallet)) flags.push({ id: "wallet_not_signer", severity: "info", message: "The wallet you named is not a signer of this transaction." });
  const otherSigners = tx.signers.filter((s) => !watched.has(s));
  if (otherSigners.length) flags.push({ id: "extra_signers", severity: "info", message: `Also needs signatures from: ${otherSigners.join(", ")}.` });
  const error = describeError(sim.err, (i) => { const ix = tx.instructions[i]; return ix ? tx.staticKeys[ix.programIndex] : "?"; });
  if (error) flags.unshift({ id: "simulation_failed", severity: "critical", message: `Would fail: ${error}` });
  if (!balancesKnown && !error) flags.push({ id: "balances_unavailable", severity: "warning", message: "The RPC did not return balance changes; the preview is incomplete." });
  const feeFromRpc = typeof sim.fee === "number" && Number.isSafeInteger(sim.fee) && sim.fee >= 0;
  const fee = feeFromRpc ? BigInt(sim.fee as number) : estimateFee(tx);
  return {
    success: error === null, error, sim_error_raw: sim.err ?? null,
    summary: summarize(error, walletSol, me === tx.feePayer, fee, tokenChanges.filter((t) => t.is_wallet), flags, { rent: newAccountRent, count: newAccounts }),
    new_token_account_rent_lamports: newAccountRent.toString(),
    wallet: me, fee_payer: tx.feePayer, version: tx.version, signatures_required: tx.signatureCount, signed: tx.signed.some(Boolean),
    sol_changes: solChanges, sol_changes_omitted: otherSolOmitted, token_changes: tokenChanges,
    programs: [...programs.values()], red_flags: flags,
    units_consumed: typeof sim.unitsConsumed === "number" ? sim.unitsConsumed : null,
    compute_unit_limit: computeBudget(tx).limit, compute_unit_price_micro_lamports: computeBudget(tx).microLamports.toString(),
    fee_estimate_lamports: fee.toString(), fee_estimate_sol: lamportsToSol(fee), fee_estimate_method: feeFromRpc ? "rpc_simulation" : "compute_budget_estimate",
    accounts_total: keys.length, lookup_tables: tx.lookups.map((l) => l.table),
    logs: (sim.logs ?? []).slice(0, 50), logs_truncated: (sim.logs ?? []).length > 50
  };
}
function summarize(error: string | null, ws: { before: bigint; after: bigint } | null, walletPaysFee: boolean, fee: bigint,
  tokens: Array<{ mint: string; symbol: string | null; delta: string; delta_raw: string }>, flags: RedFlag[], created: { rent: bigint; count: number }): string {
  const parts: string[] = [error ? `Would FAIL (${error}).` : "Would succeed."];
  const label = (t: { mint: string; symbol: string | null }) => t.symbol ?? `token ${t.mint.slice(0, 4)}…${t.mint.slice(-4)}`;
  if (!error) {
    const sends: string[] = [], gets: string[] = [];
    if (ws) {
      const net = ws.after - ws.before + (walletPaysFee ? fee : 0n); // exclude the fee from "send"
      if (net < 0n) sends.push(`${lamportsToSol(-net)} SOL`); else if (net > 0n) gets.push(`${lamportsToSol(net)} SOL`);
    }
    for (const t of tokens) {
      if (BigInt(t.delta_raw) < 0n) sends.push(`${t.delta.slice(1)} ${label(t)}`); else gets.push(`${t.delta} ${label(t)}`);
    }
    const rentNote = created.count ? ` (incl. ${lamportsToSol(created.rent)} SOL refundable rent for ${created.count} new token account${created.count > 1 ? "s" : ""})` : "";
    if (sends.length) parts.push(`You send ${sends.join(" + ")}${rentNote}.`);
    if (gets.length) parts.push(`You receive ${gets.join(" + ")}.`);
    if (!sends.length && !gets.length) parts.push("No balance changes for your wallet apart from the fee.");
  }
  parts.push(`Fee ~${lamportsToSol(fee)} SOL${walletPaysFee ? "" : " (paid by another fee payer)"}.`);
  const serious = flags.filter((f) => f.severity !== "info" && f.id !== "simulation_failed");
  parts.push(serious.length ? `RED FLAGS: ${serious.map((f) => f.id).join(", ")}.` : "No red flags.");
  return parts.join(" ");
}
