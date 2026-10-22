// Pre-Sign Brief tests: ChatGPT Part 6 cases ported to node:test and OUR tx-preview shape, plus real-shape cases.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { base58 } from "@scure/base";
import { buildBrief, deriveVerdict, computeBriefHash, canonicalJson, type PreviewLike } from "../src/brief";
import { parseIntent, evaluateIntent, type IntentView } from "../src/intent";
import { checkTokenizedEquity, VERIFIED_EQUITY_MINTS } from "../src/equities";
import { analyzePriorityFees, getPriorityFee, priorityFeeLamports } from "../src/priority-fee";
import { analyze, MINT_LABELS, WSOL, type RedFlag, type SimValue, type PreviewFacts } from "../src/tx-preview-analysis";
import { decodeTransaction } from "../src/tx-preview-wire";
import { parseTxPreviewBody, TxPreviewError } from "../src/tx-preview";

const a = (b: number) => base58.encode(new Uint8Array(32).fill(b));
const WALLET = a(1), RECIPIENT = a(2), WRONG = a(3), FAKE = a(5), EXTRA = a(6);
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NVDA = VERIFIED_EQUITY_MINTS.find((x) => x.ticker === "NVDAx")!.mint;
const TRUSTED = new Set(Object.keys(MINT_LABELS));
type Row = { owner: string; mint: string; decimals: number; delta_raw: string; is_wallet: boolean; symbol: string | null };
const tok = (mint: string, raw: string, owner = WALLET, decimals = 6): Row => ({ owner, mint, decimals, delta_raw: raw, is_wallet: owner === WALLET, symbol: MINT_LABELS[mint] ?? null });
const sol = (account: string, delta: number) => ({ account, delta_lamports: String(delta) });
function view(o: Partial<IntentView> = {}): IntentView {
  return { wallet: WALLET, fee_payer: WALLET, sol_changes: [], token_changes: [], fee_estimate_lamports: "5000", new_token_account_rent_lamports: "0", red_flags: [], balances_known: true, close_own_account: false, ...o };
}
const sendSol = (amount = 1_000_000_000, to = RECIPIENT) => view({ sol_changes: [sol(WALLET, -(amount + 5000)), sol(to, amount)] });
const noIntent = { checked: false, matches: false, mismatches: [], confidence: "low" as const };
const facts: PreviewFacts = { writable_accounts: [WALLET], lookups_resolved: true, close_own_account: false, compute_unit_limit: null, balances_known: true };
function preview(v: IntentView, extra: Partial<{ success: boolean; red_flags: RedFlag[] }> = {}) {
  return { success: true, summary: "s", source: "src", disclaimer: "d", programs: [], compute_unit_limit: null, compute_unit_price_micro_lamports: "0", logs: ["x"], ...v,
    token_changes: v.token_changes.map((t) => ({ ...t, is_wallet: t.owner === WALLET })), ...extra } as unknown as PreviewLike & { summary: string; source: string; disclaimer: string; logs: string[] };
}

test("verdict: clear / warning -> caution / critical -> avoid / info ignored", () => {
  const w: RedFlag = { id: "unknown_program", severity: "warning", message: "m" };
  const c: RedFlag = { id: "token_approval", severity: "critical", message: "m" };
  const i: RedFlag = { id: "extra_signers", severity: "info", message: "m" };
  assert.equal(deriveVerdict(true, [], noIntent).verdict, "clear");
  assert.equal(deriveVerdict(true, [i], noIntent).verdict, "clear");
  assert.equal(deriveVerdict(true, [w], noIntent).verdict, "caution");
  assert.equal(deriveVerdict(true, [c], noIntent).verdict, "avoid");
  assert.equal(deriveVerdict(true, [w, c], noIntent).verdict, "avoid");
  assert.deepEqual(deriveVerdict(false, [], noIntent), { verdict: "avoid", reasons: ["SIMULATION_FAILED"] });
  const r = deriveVerdict(true, [], { checked: true, matches: false, confidence: "medium", mismatches: ["AMOUNT_MISMATCH"] });
  assert.equal(r.verdict, "caution"); assert.ok(r.reasons.includes("INTENT_AMOUNT_MISMATCH"));
});
test("intent parsing", () => {
  assert.equal(parseIntent(`send 1.5 SOL to ${RECIPIENT}`)?.recipient_valid, true);
  assert.deepEqual([parseIntent("swap 100 USDC for SOL")?.asset, parseIntent("swap 100 USDC for SOL")?.target_asset], ["USDC", "SOL"]);
  assert.equal(parseIntent("sell 2 SOL for USDC")?.kind, "sell");
  assert.equal(parseIntent("approve delegate")?.kind, "approve");
  assert.equal(parseIntent("close token account")?.kind, "close");
  assert.equal(parseIntent("please do something"), null);
  assert.equal(parseIntent("x".repeat(201)), null);
});
test("send SOL: exact match, wrong recipient, wrong amount (fee added back only when wallet pays)", () => {
  assert.deepEqual(evaluateIntent(sendSol(), `send 1 SOL to ${RECIPIENT}`), { checked: true, matches: true, mismatches: [], confidence: "high" });
  assert.ok(evaluateIntent(sendSol(1e9, WRONG), `send 1 SOL to ${RECIPIENT}`).mismatches.includes("RECIPIENT_NOT_PAID"));
  assert.ok(evaluateIntent(sendSol(2e9), `send 1 SOL to ${RECIPIENT}`).mismatches.includes("AMOUNT_MISMATCH"));
  // sends are exact: 0.5% off is a mismatch (ChatGPT draft allowed 1%)
  assert.ok(evaluateIntent(sendSol(1_005_000_000), `send 1 SOL to ${RECIPIENT}`).mismatches.includes("AMOUNT_MISMATCH"));
  // someone else pays the fee: wallet delta is exactly -amount
  assert.equal(evaluateIntent(view({ fee_payer: EXTRA, sol_changes: [sol(WALLET, -1e9), sol(RECIPIENT, 1e9)] }), `send 1 SOL to ${RECIPIENT}`).matches, true);
});
test("token send by mint and by trusted symbol; recipient rows required", () => {
  const v = view({ sol_changes: [sol(WALLET, -5000)], token_changes: [tok(USDC, "-50000000"), tok(USDC, "50000000", RECIPIENT)] });
  assert.equal(evaluateIntent(v, `transfer 50 ${USDC} to ${RECIPIENT}`).matches, true);
  assert.equal(evaluateIntent(v, `send 50 USDC to ${RECIPIENT}`).confidence, "high");
  assert.ok(evaluateIntent(view({ sol_changes: [sol(WALLET, -5000)], token_changes: [tok(USDC, "-50000000")] }), `send 50 USDC to ${RECIPIENT}`).mismatches.includes("RECIPIENT_NOT_PAID"));
});
test("swap: match, excess input, missing output, extra token outflow, extra SOL outflow, buy unbounded", () => {
  const swap = (usdc = "-100000000", lamports = 1_000_000_000) => view({ sol_changes: [sol(WALLET, lamports - 5000)], token_changes: [tok(USDC, usdc)] });
  assert.equal(evaluateIntent(swap(), "swap 100 USDC for SOL").matches, true);
  assert.ok(evaluateIntent(swap("-150000000"), "swap 100 USDC for SOL").mismatches.includes("AMOUNT_MISMATCH"));
  assert.ok(evaluateIntent(swap("-100000000", 0), "swap 100 USDC for SOL").mismatches.includes("NO_OUTPUT_RECEIVED"));
  const extra = swap(); extra.token_changes.push(tok(EXTRA, "-5000000"));
  assert.ok(evaluateIntent(extra, "swap 100 USDC for SOL").mismatches.includes("EXTRA_TOKEN_OUTFLOW"));
  const drain = view({ sol_changes: [sol(WALLET, -50_005_000)], token_changes: [tok(USDC, "-100000000"), tok(NVDA, "1000", WALLET, 8)] });
  assert.ok(evaluateIntent(drain, "swap 100 USDC for NVDAx").mismatches.includes("EXTRA_SOL_OUTFLOW"));
  assert.ok(evaluateIntent(swap(), "buy 1 SOL for USDC").mismatches.includes("BUY_SPEND_UNBOUNDED"));
});
test("real shape: Jupiter wSOL wrap + new ATA rent + fee are not counted as spend", () => {
  // wallet pays 2_000_000 swap + 2_039_280 ATA rent + 7_980 fee; wSOL temp account opened/closed inside the tx
  const v = view({ fee_estimate_lamports: "7980", new_token_account_rent_lamports: "2039280", sol_changes: [sol(WALLET, -(2_000_000 + 2_039_280 + 7_980))], token_changes: [tok(USDC, "206176")] });
  assert.deepEqual(evaluateIntent(v, "swap 0.002 SOL for USDC"), { checked: true, matches: true, mismatches: [], confidence: "high" });
  // persistent wSOL account: input shows as a wSOL token delta instead of lamports
  const w = view({ sol_changes: [sol(WALLET, -5000)], token_changes: [tok(WSOL, "-2000000", WALLET, 9), tok(USDC, "206176")] });
  assert.equal(evaluateIntent(w, "swap 0.002 SOL for USDC").matches, true);
});
test("unknown intent wording is not penalised; unknown symbol is TOKEN_NOT_FOUND (low)", () => {
  assert.deepEqual(evaluateIntent(view(), "do the usual thing"), noIntent);
  const r = evaluateIntent(view({ token_changes: [tok(FAKE, "5")] }), "swap 1 SOL for SCAMx");
  assert.deepEqual([r.matches, r.confidence, r.mismatches], [false, "low", ["TOKEN_NOT_FOUND"]]);
});
test("approve / close intents stay low confidence -> never clear", async () => {
  const approve = await buildBrief(preview(view(), { red_flags: [{ id: "token_approval", severity: "critical", message: "m" }] }), facts, { intent: "approve delegate for USDC" }, null);
  assert.equal(approve.intent_match.confidence, "low"); assert.equal(approve.verdict, "avoid");
  const close = await buildBrief(preview(view()), { ...facts, close_own_account: true }, { intent: "close my token account" }, null);
  assert.equal(close.intent_match.matches, true);
  assert.equal(close.verdict, "caution"); assert.ok(close.reasons.includes("INTENT_IDENTITY_UNVERIFIED"));
});
test("priority fee: micro-lamports/CU stats, sparse, failure -> null, >128 accounts -> null, cost math", async () => {
  const samples = [0, 0, 1000, 2000, 3000, 4000, 5000, 6000].map((prioritizationFee, slot) => ({ slot, prioritizationFee }));
  assert.deepEqual(analyzePriorityFees(samples), { recommended_micro_lamports: 5000, recent_median: 3500, recent_p75: 5000, sample_count: 6, samples_total: 8, note: "p75_nonzero" });
  assert.equal(analyzePriorityFees([{ slot: 1, prioritizationFee: 1000 }]).note, "sparse_data");
  assert.equal(analyzePriorityFees([{ slot: 1, prioritizationFee: 0 }]).recommended_micro_lamports, null);
  assert.equal(priorityFeeLamports(5000, 200_000), 1000n);
  const orig = globalThis.fetch;
  try {
    let sentParams: unknown;
    globalThis.fetch = (async (_u: unknown, init: RequestInit) => { sentParams = JSON.parse(String(init.body)).params; return Response.json({ jsonrpc: "2.0", id: 1, result: samples }); }) as typeof fetch;
    const pf = await getPriorityFee("https://rpc.test", [WALLET, WALLET, RECIPIENT], { cuLimit: 200_000, cuPrice: "0" });
    assert.deepEqual(sentParams, [[WALLET, RECIPIENT]]);
    assert.equal(pf?.unit, "micro_lamports_per_compute_unit"); assert.equal(pf?.estimated_priority_fee_lamports_at_recommended, "1000");
    globalThis.fetch = (async () => { throw new Error("timeout"); }) as unknown as typeof fetch;
    assert.equal(await getPriorityFee("https://rpc.test", [WALLET], { cuLimit: null, cuPrice: "0" }), null);
    assert.equal(await getPriorityFee("https://rpc.test", Array.from({ length: 129 }, (_, i) => a(i + 20)), { cuLimit: null, cuPrice: "0" }), null);
  } finally { globalThis.fetch = orig; }
});
test("tokenized equity: known mint, fake AAPLx claim, explicit context, plain tokens, ticker mismatch, memecoin ticker", () => {
  assert.deepEqual(checkTokenizedEquity([NVDA], TRUSTED).checked_mints, [{ mint: NVDA, known: true, ticker: "NVDAx", issuer: "Backed Finance (xStocks)", source_url: "https://solana.com/news/case-study-xstocks" }]);
  assert.equal(checkTokenizedEquity([FAKE], TRUSTED, { ticker: "AAPLx" }).counterfeit_risk, true);
  assert.equal(checkTokenizedEquity([FAKE], TRUSTED, { type: "tokenized_equity", ticker: "TSLAx", mint: FAKE }).counterfeit_risk, true);
  assert.equal(checkTokenizedEquity([USDC], TRUSTED).counterfeit_risk, false);
  assert.equal(checkTokenizedEquity([NVDA], TRUSTED, { type: "tokenized_equity", ticker: "AAPLx", mint: NVDA }).counterfeit_risk, true);
  // fixes vs draft: memecoin ticker is not an equity claim; USDC -> NVDAx with two mints resolves to the allowlisted one
  assert.equal(checkTokenizedEquity([FAKE], TRUSTED, { type: "memecoin", ticker: "BONKx" }).counterfeit_risk, false);
  assert.equal(checkTokenizedEquity([USDC, NVDA], TRUSTED, { type: "tokenized_equity" }).counterfeit_risk, false);
  assert.equal(checkTokenizedEquity([], TRUSTED, { type: "tokenized_equity", ticker: "NVDAx" }).counterfeit_risk, true);
  assert.equal(VERIFIED_EQUITY_MINTS.length, 6);
});
test("SHA-256 brief hash: canonical, independent, changes with risk", async () => {
  assert.equal(canonicalJson({ z: 3, a: { y: 2, b: 1 } }), '{"a":{"b":1,"y":2},"z":3}');
  const f = { success: true, sol_changes: [], token_changes: [], programs: [], red_flags: [], verdict: "clear" as const };
  const h = await computeBriefHash(f);
  assert.equal(h, await computeBriefHash({ verdict: "clear", red_flags: [], programs: [], token_changes: [], sol_changes: [], success: true }));
  assert.equal(h, "sha256:" + createHash("sha256").update(canonicalJson(f)).digest("hex"));
  assert.notEqual(h, await computeBriefHash({ ...f, verdict: "avoid", red_flags: [{ id: "token_approval" }] }));
});
test("buildBrief: additive fields, originals preserved, fee lookup failure still yields a brief", async () => {
  const p = preview(sendSol());
  const r = await buildBrief(p, facts, { intent: `send 1 SOL to ${RECIPIENT}` }, null);
  assert.equal(r.schema_version, "1.0"); assert.equal(r.verdict, "clear"); assert.equal(r.priority_fee, null);
  for (const k of ["summary", "source", "disclaimer", "sol_changes", "logs"]) assert.deepEqual((r as Record<string, unknown>)[k], (p as Record<string, unknown>)[k]);
  assert.match(r.brief_hash, /^sha256:[0-9a-f]{64}$/);
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    const r2 = await buildBrief(p, facts, { intent: `send 1 SOL to ${RECIPIENT}` }, "https://rpc.test");
    assert.equal(r2.priority_fee, null); assert.equal(r2.verdict, "clear");
  } finally { globalThis.fetch = orig; }
  // unresolved lookup tables: fee lookup is skipped (fail closed), no RPC call
  let called = false;
  try {
    globalThis.fetch = (async () => { called = true; return Response.json({}); }) as unknown as typeof fetch;
    await buildBrief(p, { ...facts, lookups_resolved: false }, {}, "https://rpc.test");
    assert.equal(called, false);
  } finally { globalThis.fetch = orig; }
  const fake = await buildBrief(preview(view({ token_changes: [tok(FAKE, "1000000")] })), facts, { context: { type: "tokenized_equity", ticker: "AAPLx", mint: FAKE } }, null);
  assert.equal(fake.verdict, "avoid"); assert.ok(fake.reasons.includes("TOKENIZED_EQUITY_COUNTERFEIT"));
});
test("real Jupiter v0 fixture: SOL->USDC brief is clear with a matching intent; writable accounts include ALT entries", async () => {
  const { tx } = decodeTransaction(readFileSync("test/fixtures/jupiter-v0-unsigned.b64", "utf8").trim());
  const s = JSON.parse(readFileSync("test/fixtures/jupiter-v0-sim.json", "utf8")).result.value as SimValue;
  const { facts: f, ...out } = analyze(tx, s, "Aqgp4nKbk3WV1e7fLHepkcdwLLz3j8DwHqLTLHVEa6GK");
  for (const w of s.loadedAddresses!.writable) assert.ok(f.writable_accounts.includes(w));
  assert.equal(f.lookups_resolved, true);
  const r = await buildBrief(out, f, { intent: "swap 0.001 SOL for USDC" }, null);
  assert.deepEqual([r.verdict, r.intent_match.matches, r.intent_match.confidence], ["clear", true, "high"]);
  const wrong = await buildBrief(out, f, { intent: "swap 0.01 SOL for USDC" }, null);
  assert.equal(wrong.verdict, "caution");
});
test("intent/context validated in the free pre-payment parse", () => {
  const t = readFileSync("test/fixtures/jupiter-v0-unsigned.b64", "utf8").trim();
  const ok = parseTxPreviewBody("application/json", JSON.stringify({ transaction: t, intent: "swap 0.001 SOL for USDC", context: { type: "tokenized_equity", ticker: "NVDAx", mint: NVDA } }));
  assert.equal(ok.intent, "swap 0.001 SOL for USDC");
  for (const extra of [{ intent: "x".repeat(201) }, { intent: "" }, { context: { type: "stock" } }, { context: { ticker: "1BAD" } }, { context: { mint: "abc" } }, { context: { other: 1 } }]) {
    assert.throws(() => parseTxPreviewBody("application/json", JSON.stringify({ transaction: t, ...extra })), (e: TxPreviewError) => e.status === 400, JSON.stringify(extra));
  }
});
