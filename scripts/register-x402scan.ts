// Free x402scan registry registration via SIWX (Sign-In-With-Ethereum; unfunded throwaway key, no spend).
// x402scan's SIWX challenge has accepts: [], so wrapFetchWithSIWx bails out; we sign the challenge manually.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SIGN_IN_WITH_X, createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";
const KEY = process.env.SIWX_KEY_FILE ?? "./siwx-evm.key"; // throwaway EVM key, created if missing; keep out of git
if (!existsSync(KEY)) writeFileSync(KEY, generatePrivateKey(), { mode: 0o600 });
const account = privateKeyToAccount(readFileSync(KEY, "utf8").trim() as `0x${string}`);
console.log("SIWX identity (throwaway, unfunded):", account.address);
async function siwxPost(url: string, body: unknown) {
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const first = await fetch(url, init);
  if (first.status !== 402) return first;
  const pr = JSON.parse(Buffer.from(first.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
  const ext = pr.extensions?.[SIGN_IN_WITH_X];
  const chain = ext.supportedChains[0];
  const payload = await createSIWxPayload({ ...ext.info, chainId: chain.chainId, type: chain.type }, account, url);
  return fetch(url, { ...init, headers: { ...init.headers, [SIGN_IN_WITH_X]: encodeSIWxHeader(payload) } });
}
const origin = process.env.ORIGIN ?? "https://solana-x402-microtools-mainnet.valecity.workers.dev";
const H = origin;
for (const u of (process.env.URLS ?? "").split(",").filter(Boolean)) { const x = await siwxPost("https://www.x402scan.com/api/x402/registry/register", { url: H + u }); console.log(u, x.status, (await x.text()).slice(0, 1500)); }
const r = process.env.URLS ? new Response("skipped origin") : await siwxPost("https://www.x402scan.com/api/x402/registry/register-origin", { origin });
console.log("register-origin status", r.status);
console.log((await r.text()).slice(0, 5000));
