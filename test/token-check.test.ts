import { test } from "node:test";
import { strict as assert } from "node:assert";
import { scoreTokenRisk, type RiskInputs } from "../src/token-check-scoring";
import { parseTokenCheckQuery } from "../src/token-check";
const clean: RiskInputs = {
  mint_authority_active: false, freeze_authority_active: false, supply_zero: false,
  top_10_token_accounts_share_pct: 49.99, transfer_fee: false,
  permanent_delegate: false, transfer_hook: false, non_transferable: false, pausable: false
};
test("clean mint scores low", () => {
  assert.deepEqual(scoreTokenRisk(clean), { risk_flags: [], risk_points: 0, risk_score: "low" });
});
test("concentration thresholds are mutually exclusive", () => {
  assert.equal(scoreTokenRisk({ ...clean, top_10_token_accounts_share_pct: 50 }).risk_points, 1);
  const result = scoreTokenRisk({ ...clean, top_10_token_accounts_share_pct: 80 });
  assert.equal(result.risk_points, 2);
  assert.deepEqual(result.risk_flags.map(x => x.id), ["top_10_accounts_at_least_80_percent"]);
});
test("control flags and risky extensions accumulate consistently", () => {
  const result = scoreTokenRisk({ ...clean, mint_authority_active: true,
    freeze_authority_active: true, transfer_fee: true, permanent_delegate: true,
    transfer_hook: true, non_transferable: true, top_10_token_accounts_share_pct: 88 });
  assert.equal(result.risk_points, 15);
  assert.equal(result.risk_score, "high");
  assert.equal(result.risk_flags.length, 7);
  assert.ok(result.risk_flags.every(x => x.rule.length > 0 && x.reason.length > 0));
});
test("zero supply has no concentration and a medium warning", () => {
  const result = scoreTokenRisk({ ...clean, supply_zero: true, top_10_token_accounts_share_pct: null });
  assert.equal(result.risk_points, 2);
  assert.equal(result.risk_score, "medium");
});
test("reject malformed mint and query before payment", () => {
  const goodMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  assert.equal(parseTokenCheckQuery(new URLSearchParams({ mint: goodMint })).mint, goodMint);
  for (const q of ["", "mint=0invalid", `mint=${goodMint}&mint=${goodMint}`, `mint=${goodMint}&other=1`, "mint=1111"]) {
    assert.throws(() => parseTokenCheckQuery(new URLSearchParams(q)));
  }
});
import { parseMintBytes } from "../src/token-check";
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", CLASSIC = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
function baseMint(opts: { mintAuth?: boolean; freezeAuth?: boolean; supply?: bigint; decimals?: number } = {}) {
  const b = new Uint8Array(82); const v = new DataView(b.buffer);
  if (opts.mintAuth) { v.setUint32(0, 1, true); b.fill(7, 4, 36); }
  v.setBigUint64(36, opts.supply ?? 1000n, true); b[44] = opts.decimals ?? 6; b[45] = 1;
  if (opts.freezeAuth) { v.setUint32(46, 1, true); b.fill(9, 50, 82); }
  return b;
}
function t22(exts: Array<[number, Uint8Array]>, accountType = 1) {
  const len = 166 + exts.reduce((n, [, d]) => n + 4 + d.length, 0);
  const b = new Uint8Array(len); b.set(baseMint()); b[165] = accountType;
  const v = new DataView(b.buffer); let o = 166;
  for (const [k, d] of exts) { v.setUint16(o, k, true); v.setUint16(o + 2, d.length, true); b.set(d, o + 4); o += 4 + d.length; }
  return b;
}
test("classic mint layout: authorities, supply at 36, decimals at 44", () => {
  const s = parseMintBytes(MINT, 1, CLASSIC, baseMint({ mintAuth: true, supply: 123456789n, decimals: 9 }));
  assert.equal(s.supply, 123456789n); assert.equal(s.decimals, 9);
  assert.ok(s.mintAuthority); assert.equal(s.freezeAuthority, null); assert.equal(s.token_program, "spl-token");
});
test("Token-2022 extensions only count when effective or controllable", () => {
  const zeroDelegate = new Uint8Array(32), setDelegate = new Uint8Array(32).fill(5);
  const nullHook = new Uint8Array(64), feeZeroNoAuth = new Uint8Array(108);
  const s1 = parseMintBytes(MINT, 1, T22, t22([[12, zeroDelegate], [14, nullHook], [1, feeZeroNoAuth], [9, new Uint8Array(0)]]));
  assert.deepEqual(s1.risky_extensions, { transfer_fee: false, permanent_delegate: false, transfer_hook: false, non_transferable: true, pausable: false });
  assert.deepEqual(s1.extensions_present, ["TransferFeeConfig", "NonTransferable", "PermanentDelegate", "TransferHook"]);
  const fee = new Uint8Array(108); new DataView(fee.buffer).setUint16(106, 50, true);
  const s2 = parseMintBytes(MINT, 1, T22, t22([[12, setDelegate], [1, fee], [26, new Uint8Array(33).fill(1)]]));
  assert.equal(s2.risky_extensions.permanent_delegate, true);
  assert.equal(s2.risky_extensions.transfer_fee, true);
  assert.equal(s2.risky_extensions.pausable, true);
});
test("non-mint accounts are 400s", () => {
  assert.throws(() => parseMintBytes(MINT, 1, T22, t22([], 2)), (e: { status: number }) => e.status === 400);
  assert.throws(() => parseMintBytes(MINT, 1, CLASSIC, new Uint8Array(165)), (e: { status: number }) => e.status === 400);
});
import { TOOLS } from "../src/schemas";
import { tokenCheckOutputSchema } from "../src/token-check-schemas";
test("discovery outputExamples satisfy strict schemas and patterns", () => {
  const tc = TOOLS.find((t) => t.id === "token-check")!;
  assert.doesNotThrow(() => tokenCheckOutputSchema.parse(tc.outputExample));
  const tp = TOOLS.find((t) => t.id === "tx-preview")!;
  assert.match((tp.outputExample as { brief_hash: string }).brief_hash, /^sha256:[0-9a-f]{64}$/);
});
