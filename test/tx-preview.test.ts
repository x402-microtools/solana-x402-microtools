import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { base58 } from "@scure/base";
import { parseTransaction, decodeTransaction, accountKeys, toBase64 } from "../src/tx-preview-wire";
import { analyze, estimateFee, type SimValue } from "../src/tx-preview-analysis";
import { parseTxPreviewBody, previewTransaction, TxPreviewError } from "../src/tx-preview";
import app from "../src/index";

const SYSTEM = "11111111111111111111111111111111", TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const CB = "ComputeBudget111111111111111111111111111111", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const pk = (n: number) => base58.encode(new Uint8Array(32).fill(n));
const WALLET = pk(1), DEST = pk(2), TABLE = pk(9);
const shortvec = (n: number) => { const o: number[] = []; for (;;) { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; o.push(b); if (!n) return o; } };
type BIx = { p: number; a: number[]; d: number[] };
/** Hand-built wire transaction (unsigned: zeroed signatures). */
function wire(o: { v0?: boolean; header: [number, number, number]; keys: string[]; ixs: BIx[]; lookups?: Array<{ table: string; w: number[]; r: number[] }>; sigs?: number }): Uint8Array {
  const b: number[] = [...shortvec(o.sigs ?? o.header[0])];
  for (let i = 0; i < (o.sigs ?? o.header[0]); i++) b.push(...new Array(64).fill(0));
  if (o.v0) b.push(0x80);
  b.push(...o.header, ...shortvec(o.keys.length));
  for (const k of o.keys) b.push(...base58.decode(k));
  b.push(...new Array(32).fill(7), ...shortvec(o.ixs.length));
  for (const ix of o.ixs) b.push(ix.p, ...shortvec(ix.a.length), ...ix.a, ...shortvec(ix.d.length), ...ix.d);
  if (o.v0) {
    const l = o.lookups ?? []; b.push(...shortvec(l.length));
    for (const x of l) b.push(...base58.decode(x.table), ...shortvec(x.w.length), ...x.w, ...shortvec(x.r.length), ...x.r);
  }
  return Uint8Array.from(b);
}
const le = (n: bigint, bytes: number) => Array.from({ length: bytes }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const solTransfer = (lamports: bigint, v0 = false) => wire({ v0, header: [1, 0, 1], keys: [WALLET, DEST, SYSTEM], ixs: [{ p: 2, a: [0, 1], d: [...le(2n, 4), ...le(lamports, 8)] }] });
const sim = (x: Partial<SimValue>): SimValue => ({ err: null, logs: [], unitsConsumed: 150, fee: 5000, innerInstructions: [], loadedAddresses: { writable: [], readonly: [] }, preTokenBalances: [], postTokenBalances: [], ...x });
const body = (o: unknown) => JSON.stringify(o);

test("bad input is a 400/415/413 before payment", () => {
  const ok = toBase64(solTransfer(1000n));
  assert.equal(parseTxPreviewBody("application/json", body({ transaction: ok })).tx.feePayer, WALLET);
  const bad: Array<[string | undefined, string, number]> = [
    ["text/plain", body({ transaction: ok }), 415], [undefined, body({ transaction: ok }), 415],
    ["application/json", "{not json", 400], ["application/json", body({}), 400],
    ["application/json", body({ transaction: ok, extra: 1 }), 400], ["application/json", body({ transaction: ok, wallet: "abc" }), 400],
    ["application/json", body({ transaction: "AAAA" }), 400], ["application/json", body({ transaction: ok.slice(0, -8) }), 400],
    ["application/json", body({ transaction: ok, encoding: "base58" }), 400], ["application/json", "x".repeat(9000), 413]
  ];
  for (const [ct, raw, status] of bad) assert.throws(() => parseTxPreviewBody(ct, raw), (e: TxPreviewError) => e.status === status, `${ct} ${raw.slice(0, 40)}`);
});
test("wire: header/signature mismatch, bad version, trailing bytes, bad program index are rejected", () => {
  const t = solTransfer(1n);
  const extraSig = wire({ header: [1, 0, 1], keys: [WALLET, DEST, SYSTEM], ixs: [{ p: 2, a: [0, 1], d: [2, 0, 0, 0] }], sigs: 2 });
  assert.throws(() => parseTransaction(extraSig), /Signature count/);
  const v1 = solTransfer(1n, true); v1[65] = 0x81; assert.throws(() => parseTransaction(v1), /version 1/);
  assert.throws(() => parseTransaction(Uint8Array.from([...t, 0])), /Trailing/);
  assert.throws(() => parseTransaction(wire({ header: [1, 0, 1], keys: [WALLET, DEST, SYSTEM], ixs: [{ p: 0, a: [], d: [] }] })), /program id/);
  assert.throws(() => parseTransaction(wire({ header: [1, 0, 1], keys: [WALLET, DEST, SYSTEM], ixs: [{ p: 2, a: [5], d: [] }] })), /out of range/);
});
test("base64 and base58 auto-detect; RPC always receives base64", async () => {
  const t = solTransfer(5n);
  assert.equal(decodeTransaction(toBase64(t)).encoding, "base64");
  assert.equal(decodeTransaction(base58.encode(t)).encoding, "base58");
  let sent: unknown;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init: RequestInit) => { sent = JSON.parse(String(init.body)); return Response.json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: sim({ preBalances: [10, 0, 1], postBalances: [10, 0, 1] }) } }); }) as typeof fetch;
  try { await previewTransaction("https://rpc.test", { tx: decodeTransaction(base58.encode(t)).tx, encoding: "base58" }); }
  finally { globalThis.fetch = orig; }
  const p = (sent as { params: [string, Record<string, unknown>] }).params;
  assert.equal(p[0], toBase64(t));
  assert.deepEqual(p[1], { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true, commitment: "confirmed" });
});
test("RPC down is 502/504 (no settlement); 429 falls through to next RPC; -32602 is a 400", async () => {
  const input = { tx: parseTransaction(solTransfer(5n)), encoding: "base64" as const };
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    await assert.rejects(previewTransaction("https://a.test,https://b.test", input), (e: TxPreviewError) => e.status === 502);
    globalThis.fetch = (async () => { throw new Error("net"); }) as unknown as typeof fetch;
    await assert.rejects(previewTransaction("https://a.test", input), (e: TxPreviewError) => e.status === 504);
    let calls = 0;
    globalThis.fetch = (async () => (++calls === 1 ? new Response("", { status: 429 }) : Response.json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 2 }, value: sim({ preBalances: [10_000_000, 0, 1], postBalances: [8_995_000, 1_000_000, 1] }) } }))) as unknown as typeof fetch;
    assert.equal((await previewTransaction("https://a.test,https://b.test", input)).slot, 2);
    globalThis.fetch = (async () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "failed to deserialize" } })) as unknown as typeof fetch;
    await assert.rejects(previewTransaction("https://a.test", input), (e: TxPreviewError) => e.status === 400);
    // successful sim without balances = limited RPC -> try next, then 502
    globalThis.fetch = (async () => Response.json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 2 }, value: { err: null, logs: [] } } })) as unknown as typeof fetch;
    await assert.rejects(previewTransaction("https://a.test", input), (e: TxPreviewError) => e.status === 502);
  } finally { globalThis.fetch = orig; }
});
test("simple SOL transfer (legacy)", () => {
  const tx = parseTransaction(solTransfer(1_000_000n));
  assert.equal(tx.version, "legacy");
  assert.deepEqual(tx.staticWritable, [true, true, false]);
  const r = analyze(tx, sim({ preBalances: [10_000_000, 0, 1], postBalances: [8_995_000, 1_000_000, 1] }));
  assert.equal(r.success, true);
  assert.equal(r.sol_changes[0].account, WALLET); assert.equal(r.sol_changes[0].delta_sol, "-0.001005");
  assert.equal(r.red_flags.length, 0);
  assert.equal(r.summary, "Would succeed. You send 0.001 SOL. Fee ~0.000005 SOL. No red flags.");
  assert.deepEqual(r.programs, [{ id: SYSTEM, name: "System", known: true, top_level: true }]);
});
test("SPL token transfer reports token deltas for the wallet only", () => {
  const SRC = pk(3), DST_ATA = pk(4);
  const tx = parseTransaction(wire({ header: [1, 0, 1], keys: [WALLET, SRC, DST_ATA, TOKEN], ixs: [{ p: 3, a: [1, 2, 0], d: [3, ...le(2_500_000n, 8)] }] }));
  const bal = (i: number, owner: string, amount: string) => ({ accountIndex: i, mint: USDC, owner, programId: TOKEN, uiTokenAmount: { amount, decimals: 6 } });
  const r = analyze(tx, sim({ preBalances: [1e7, 2039280, 2039280, 1], postBalances: [1e7 - 5000, 2039280, 2039280, 1],
    preTokenBalances: [bal(1, WALLET, "5000000"), bal(2, DEST, "0")], postTokenBalances: [bal(1, WALLET, "2500000"), bal(2, DEST, "2500000")] }));
  assert.equal(r.token_changes.length, 1);
  assert.deepEqual([r.token_changes[0].symbol, r.token_changes[0].before, r.token_changes[0].after, r.token_changes[0].delta], ["USDC", "5", "2.5", "-2.5"]);
  assert.match(r.summary, /You send 2\.5 USDC\. Fee ~0\.000005 SOL\. No red flags\./);
});
test("v0 with lookup table: writable rules and loaded-address ordering", () => {
  const PROG = pk(5), LW = pk(6), LR = pk(8);
  // static: [wallet(w,signer), readonlyUnsigned PROG]; lookups: 1 writable, 1 readonly -> indexes 2 (w), 3 (ro)
  const bytes = wire({ v0: true, header: [1, 0, 1], keys: [WALLET, PROG], ixs: [{ p: 1, a: [0, 2, 3], d: [1] }], lookups: [{ table: TABLE, w: [4], r: [7] }] });
  const tx = parseTransaction(bytes);
  assert.equal(tx.version, 0); assert.equal(tx.lookupWritableCount, 1); assert.equal(tx.lookupReadonlyCount, 1);
  assert.deepEqual(tx.staticWritable, [true, false]);
  const ak = accountKeys(tx, { writable: [LW], readonly: [LR] });
  assert.deepEqual(ak.keys, [WALLET, PROG, LW, LR]); assert.deepEqual(ak.writable, [true, false, true, false]);
  const r = analyze(tx, sim({ loadedAddresses: { writable: [LW], readonly: [LR] }, preBalances: [1e9, 1, 5, 7], postBalances: [1e9 - 5000, 1, 6, 7] }));
  assert.deepEqual(r.lookup_tables, [TABLE]);
  assert.deepEqual(r.sol_changes.map((s) => s.account), [WALLET, LW]);
  assert.ok(r.red_flags.some((f) => f.id === "unknown_program"));
  // readonly signed / unsigned boundaries
  const t2 = parseTransaction(wire({ header: [2, 1, 1], keys: [WALLET, DEST, pk(3), SYSTEM], ixs: [{ p: 3, a: [], d: [] }], sigs: 2 }));
  assert.deepEqual(t2.staticWritable, [true, false, true, false]);
});
test("approve / setAuthority / closeAccount / assign / big SOL loss red flags", () => {
  const ATA = pk(3), EVIL = pk(4);
  const tx = parseTransaction(wire({ header: [1, 0, 2], keys: [WALLET, ATA, EVIL, TOKEN, SYSTEM], ixs: [
    { p: 3, a: [1, 2, 0], d: [4, ...le(1000n, 8)] },             // Approve
    { p: 3, a: [1, 0], d: [6, 2, 1, ...base58.decode(EVIL)] },    // SetAuthority AccountOwner -> EVIL
    { p: 3, a: [1, 2, 0], d: [9] },                               // CloseAccount -> EVIL
    { p: 4, a: [0], d: [...le(1n, 4), ...base58.decode(EVIL)] }   // System Assign wallet
  ] }));
  const bal = (amount: string) => [{ accountIndex: 1, mint: USDC, owner: WALLET, programId: TOKEN, uiTokenAmount: { amount, decimals: 6 } }];
  const r = analyze(tx, sim({ preBalances: [1e9, 2039280, 0, 1, 1], postBalances: [5e7, 0, 950_000_000 + 2039280, 1, 1], preTokenBalances: bal("10"), postTokenBalances: [],
    innerInstructions: [{ index: 0, instructions: [{ programId: TOKEN, parsed: { type: "approveChecked", info: { source: ATA, delegate: EVIL, owner: WALLET } } }] }] }));
  const ids = r.red_flags.map((f) => f.id);
  for (const id of ["token_approval", "token_account_owner_change", "close_account_to_other", "wallet_owner_reassigned", "wallet_loses_over_90pct_sol"]) assert.ok(ids.includes(id), id);
  assert.equal(ids.filter((x) => x === "token_approval").length, 2); // top-level + inner CPI
  assert.match(r.summary, /RED FLAGS/);
  // close to own wallet is NOT a flag
  const ok = parseTransaction(wire({ header: [1, 0, 1], keys: [WALLET, ATA, TOKEN], ixs: [{ p: 2, a: [1, 0, 0], d: [9] }] }));
  assert.equal(analyze(ok, sim({ preBalances: [1e9, 2039280, 1], postBalances: [1e9 + 2034280, 0, 1], preTokenBalances: bal("0") })).red_flags.length, 0);
});
test("simulation error is a 200-style result with a decoded error", () => {
  const tx = parseTransaction(solTransfer(999n));
  const r = analyze(tx, sim({ err: { InstructionError: [0, { Custom: 1 }] }, preBalances: [10, 0, 1], postBalances: [10, 0, 1] }));
  assert.equal(r.success, false);
  assert.equal(r.error, "Instruction 0 (System) failed: custom program error 0x1");
  assert.equal(r.red_flags[0].id, "simulation_failed");
});
test("fee fallback uses requested CU limit, not units consumed", () => {
  const tx = parseTransaction(wire({ header: [1, 0, 2], keys: [WALLET, DEST, CB, SYSTEM], ixs: [
    { p: 2, a: [], d: [2, ...le(300_000n, 4)] }, { p: 2, a: [], d: [3, ...le(10_000n, 8)] }, { p: 3, a: [0, 1], d: [...le(2n, 4), ...le(1n, 8)] }] }));
  assert.equal(estimateFee(tx), 5000n + 3000n);
  const r = analyze(tx, sim({ fee: null, preBalances: [1e9, 0, 1, 1], postBalances: [1e9 - 8001, 1, 1, 1] }));
  assert.equal(r.fee_estimate_method, "compute_budget_estimate"); assert.equal(r.fee_estimate_lamports, "8000");
});
test("real mainnet Jupiter v0 swap fixture (unsigned, never sent)", () => {
  const { tx } = decodeTransaction(readFileSync("test/fixtures/jupiter-v0-unsigned.b64", "utf8").trim());
  const s = JSON.parse(readFileSync("test/fixtures/jupiter-v0-sim.json", "utf8")).result.value as SimValue;
  assert.equal(tx.version, 0); assert.ok(tx.lookups.length >= 1);
  const r = analyze(tx, s, "Aqgp4nKbk3WV1e7fLHepkcdwLLz3j8DwHqLTLHVEa6GK");
  assert.equal(r.success, true);
  assert.equal(r.accounts_total, tx.staticKeys.length + s.loadedAddresses!.writable.length + s.loadedAddresses!.readonly.length);
  const usdc = r.token_changes.find((t) => t.mint === USDC)!;
  assert.equal(usdc.delta, "0.103273");
  assert.equal(r.sol_changes[0].delta_lamports, "-1005000");
  assert.ok(r.programs.some((p) => p.name === "Jupiter Aggregator v6" && p.top_level));
  assert.ok(!r.red_flags.some((f) => f.severity === "critical"), JSON.stringify(r.red_flags));
  assert.match(r.summary, /^Would succeed\. You send 0\.001 SOL\. You receive 0\.103273 USDC\./);
});
test("app: GET -> 405, bad POST body -> free 400 (no 402 challenge)", async () => {
  const env = { INBOUND_LIMIT: { limit: async () => ({ success: true }) }, UPSTREAM_LIMIT: { limit: async () => ({ success: true }) }, RATE_LIMIT_SALT: "x".repeat(40) };
  const g = await app.request("/api/tx-preview", {}, env);
  assert.equal(g.status, 405); assert.equal(g.headers.get("Allow"), "POST");
  const p = await app.request("/api/tx-preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: body({ transaction: "AAAA" }) }, env);
  assert.equal(p.status, 400); assert.equal(p.headers.get("PAYMENT-REQUIRED"), null);
  const ct = await app.request("/api/tx-preview", { method: "POST", body: body({ transaction: "AAAA" }) }, env);
  assert.equal(ct.status, 415);
  const other = await app.request("/api/weather?city=london", { method: "POST" }, env);
  assert.equal(other.status, 405);
});
