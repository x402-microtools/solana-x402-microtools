import { base58 } from "@scure/base";
import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const url = process.env.API_URL;
const key = process.env.SOLANA_PRIVATE_KEY;
const keyfile = process.env.SOLANA_KEYPAIR_FILE;
const recipient = process.env.EXPECTED_PAY_TO;
if (!url || !/^https?:\/\//.test(url) || (!key && !keyfile) || !recipient) {
  throw Error("Set API_URL, SOLANA_KEYPAIR_FILE (or SOLANA_PRIVATE_KEY in base58) for funded buyer wallet, EXPECTED_PAY_TO (mainnet recipient)");
}
const endpoint = new URL(process.env.ENDPOINT_PATH ?? "/api/preflight", url);
for (const [k, v] of new URLSearchParams(process.env.ENDPOINT_QUERY ?? "url=https://x402.org")) endpoint.searchParams.set(k, v);
// Optional POST/JSON support (e.g. /api/tx-preview): ENDPOINT_METHOD=POST and ENDPOINT_BODY='{"..."}' or ENDPOINT_BODY_FILE=path.
const method = (process.env.ENDPOINT_METHOD ?? "GET").toUpperCase();
const bodyText = process.env.ENDPOINT_BODY ?? (process.env.ENDPOINT_BODY_FILE ? readFileSync(process.env.ENDPOINT_BODY_FILE, "utf8") : undefined);
if (method !== "GET" && method !== "POST") throw Error("ENDPOINT_METHOD must be GET or POST");
if (method === "POST") { if (!bodyText) throw Error("POST needs ENDPOINT_BODY or ENDPOINT_BODY_FILE"); JSON.parse(bodyText); }
if (method === "POST" && !process.env.ENDPOINT_QUERY) endpoint.search = "";
const init = (): RequestInit => method === "POST" ? { method, headers: { "Content-Type": "application/json" }, body: bodyText } : { method };
const secret = keyfile ? Uint8Array.from(JSON.parse(readFileSync(keyfile, "utf8")) as number[]) : base58.decode(key!);
if (secret.length !== 64) throw Error("Solana keypair must be a 64-byte secret key");
const signer = await createKeyPairSignerFromBytes(secret);
const client = new x402Client();
client.registerPolicy((_version, offers) => offers.filter((x) =>
  x.network === MAINNET && x.asset === MAINNET_USDC && x.scheme === "exact" &&
  x.payTo === recipient && BigInt(x.amount) === BigInt(process.env.EXPECTED_AMOUNT ?? "10000")
));
client.register("solana:*", new ExactSvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);
const initial = await fetch(endpoint, init());
if (initial.status !== 402 || !initial.headers.has("PAYMENT-REQUIRED")) {
  throw Error(`Expected unpaid x402 v2 challenge; received ${initial.status}`);
}
console.log(`Received 402 challenge; now attempting ONE MAINNET USDC payment of ${process.env.EXPECTED_AMOUNT ?? "10000"} atomic units.`);
const paid = await fetchPaid(endpoint.toString(), init());
const payload = await paid.text();
console.log("HTTP status:", paid.status);
const pr = paid.headers.get("PAYMENT-RESPONSE");
console.log("PAYMENT-RESPONSE:", pr ? Buffer.from(pr, "base64").toString() : "absent");
console.log("Response:", payload.slice(0, 2000));
if (paid.status !== 200 || !paid.headers.has("PAYMENT-RESPONSE")) process.exitCode = 1;
