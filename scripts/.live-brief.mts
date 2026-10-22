import { readFileSync } from "node:fs";
import { parseTxPreviewBody, previewTransaction } from "../src/tx-preview";
const rpcUrl = readFileSync("/workspace/x402-shop/keys/alchemy_rpc.txt", "utf8").trim() + ",https://public.rpc.solanavibestation.com";
const W = "Aqgp4nKbk3WV1e7fLHepkcdwLLz3j8DwHqLTLHVEa6GK", BUYER = "5bmkKzfXpgMb3GgBw6UVWTQiv2q7LNAFvs9w6yAaVDoR";
const cases: Array<[string, string, Record<string, unknown>]> = [
  ["transfer-right", "/tmp/b-transfer.b64", { intent: `send 0.001 SOL to ${BUYER}` }],
  ["transfer-wrong-recipient", "/tmp/b-transfer.b64", { intent: `send 0.001 SOL to H14NQF2MYJv2Yf1E5SYShjdA8PnbSrM8zi7pHnb9UurR` }],
  ["transfer-wrong-amount", "/tmp/b-transfer.b64", { intent: `send 0.002 SOL to ${BUYER}` }],
  ["jup-usdc", "/tmp/b-usdc.b64", { wallet: W, intent: "swap 0.002 SOL for USDC" }],
  ["jup-nvda", "/tmp/b-nvda.b64", { wallet: W, intent: "swap 0.002 SOL for NVDAx", context: { type: "tokenized_equity", ticker: "NVDAx" } }],
  ["jup-nvda-wrongticker", "/tmp/b-nvda.b64", { wallet: W, context: { type: "tokenized_equity", ticker: "AAPLx" } }]
];
for (const [name, file, extra] of cases) {
  const t0 = performance.now();
  const input = parseTxPreviewBody("application/json", JSON.stringify({ transaction: readFileSync(file, "utf8").trim(), ...extra }));
  const out = await previewTransaction(rpcUrl, input);
  const size = JSON.stringify(out).length;
  console.log(`== ${name} ${(performance.now() - t0).toFixed(0)}ms ${size}B verdict=${out.verdict} reasons=${JSON.stringify(out.reasons)}`);
  console.log("  summary:", out.summary);
  console.log("  intent:", JSON.stringify(out.intent_match), "equity:", JSON.stringify(out.tokenized_equity));
  console.log("  prio:", JSON.stringify(out.priority_fee));
  console.log("  flags:", JSON.stringify(out.red_flags.map((f) => [f.id, f.severity])), "programs:", JSON.stringify(out.programs.map((p: any) => [p.name ?? p.id.slice(0, 6), p.top_level])));
  console.log("  tokens:", JSON.stringify(out.token_changes.map((t) => [t.symbol ?? t.mint.slice(0, 4), t.delta, t.owner.slice(0, 4)])));
}
