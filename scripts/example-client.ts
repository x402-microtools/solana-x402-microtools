// Example buyer: pays $0.003 USDC on Solana mainnet for one weather call.
// Run: SOLANA_KEYPAIR_FILE=./buyer.json npx tsx scripts/example-client.ts
import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";

const API = "https://solana-x402-microtools-mainnet.valecity.workers.dev";
const PAY_TO = "Aqgp4nKbk3WV1e7fLHepkcdwLLz3j8DwHqLTLHVEa6GK";
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MAX_ATOMIC = 3_000n; // $0.003 (USDC has 6 decimals)

const secret = Uint8Array.from(JSON.parse(readFileSync(process.env.SOLANA_KEYPAIR_FILE!, "utf8")) as number[]);
const signer = await createKeyPairSignerFromBytes(secret);
const client = new x402Client();
// Only ever pay this service, in mainnet USDC, up to MAX_ATOMIC.
client.registerPolicy((_version, offers) => offers.filter((x) =>
  x.network === MAINNET && x.asset === USDC && x.scheme === "exact" &&
  x.payTo === PAY_TO && BigInt(x.amount) <= MAX_ATOMIC));
client.register("solana:*", new ExactSvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);

const res = await fetchPaid(`${API}/api/weather?city=london`);
console.log(res.status, res.headers.has("PAYMENT-RESPONSE") ? "paid" : "not paid");
console.log(await res.text());
