import { base58 } from "@scure/base";
import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const url = process.env.API_URL;
const key = process.env.SOLANA_PRIVATE_KEY;
const keyfile = process.env.SOLANA_KEYPAIR_FILE;
const recipient = process.env.EXPECTED_PAY_TO;
if (!url || !/^https?:\/\//.test(url) || (!key && !keyfile) || !recipient) {
  throw Error("Set API_URL, SOLANA_KEYPAIR_FILE (or SOLANA_PRIVATE_KEY in base58) for disposable funded devnet wallet, EXPECTED_PAY_TO (devnet recipient)");
}
const endpoint = new URL("/api/preflight", url);
endpoint.searchParams.set("url", "https://x402.org");
const secret = keyfile ? Uint8Array.from(JSON.parse(readFileSync(keyfile, "utf8")) as number[]) : base58.decode(key!);
if (secret.length !== 64) throw Error("Solana keypair must be a 64-byte secret key");
const signer = await createKeyPairSignerFromBytes(secret);
const client = new x402Client();
client.registerPolicy((_version, offers) => offers.filter((x) =>
  x.network === DEVNET && x.asset === DEVNET_USDC && x.scheme === "exact" &&
  x.payTo === recipient && BigInt(x.amount) === 10_000n
));
client.register("solana:*", new ExactSvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);
const initial = await fetch(endpoint);
if (initial.status !== 402 || !initial.headers.has("PAYMENT-REQUIRED")) {
  throw Error(`Expected unpaid x402 v2 challenge; received ${initial.status}`);
}
console.log("Received 402 challenge; now attempting ONE devnet USDC payment.");
const paid = await fetchPaid(endpoint.toString());
const payload = await paid.text();
console.log("HTTP status:", paid.status);
console.log("PAYMENT-RESPONSE:", paid.headers.get("PAYMENT-RESPONSE") ? "present" : "absent");
console.log("Response:", payload.slice(0, 2000));
if (paid.status !== 200 || !paid.headers.has("PAYMENT-RESPONSE")) process.exitCode = 1;
