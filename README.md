# Solana x402 Microtools

Four small pay-per-call HTTP APIs for AI agents and scripts. Payment uses the [x402](https://x402.org) v2 protocol: the first request gets `402 Payment Required`, your client pays in **USDC on Solana mainnet**, and the request is retried automatically. There are no accounts and no API keys.

- **Base URL:** `https://solana-x402-microtools-mainnet.valecity.workers.dev`
- **Network:** `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (Solana mainnet)
- **Asset:** USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- **payTo:** `Aqgp4nKbk3WV1e7fLHepkcdwLLz3j8DwHqLTLHVEa6GK`
- **Scheme:** `exact`, settled through the PayAI facilitator (`https://facilitator.payai.network`), which pays the Solana network fee
- **Methods:** only `GET`. `HEAD` and other methods return `405`.

## Endpoints

| Route | Price | Parameters |
|---|---|---|
| `GET /api/preflight` | $0.01 (10000 atomic USDC) | `url` (required): a public `https://` URL |
| `GET /api/crypto` | $0.003 (3000) | `pair` (optional): `SOL-USDC` (default), `RAY-USDC` or `all` |
| `GET /api/weather` | $0.003 (3000) | **either** `city` **or** both `lat` and `lon` |
| `GET /api/token-check` | $0.01 (10000) | `mint` (required): base58 SPL Token or Token-2022 mint address |

Free routes: `GET /health`, `GET /.well-known/x402.json` (discovery manifest with JSON schemas), `GET /openapi.json`, `GET /llms.txt`.

Inputs are validated **before** the payment challenge, so a bad request returns `400` and you are not charged. For `/api/token-check` this includes an on-chain lookup: a non-existent account, a wallet, or a token account (not a mint) gets a free `400`. Unknown or duplicated query parameters are rejected.

### `/api/preflight?url=…`
Fetches the URL once (3.5 s timeout) **without following redirects** and without reading the body. It returns the HTTP status and latency, and, if the target answers `402` with an x402 v2 `PAYMENT-REQUIRED` header, the decoded terms (`scheme`, `network`, `asset`, `amount`, `payTo`) so an agent can check a price before paying.
- Allowed: `https://` URLs with a public DNS hostname.
- Rejected with `400`: IP literals, `localhost`/`.local`/`.internal`-style hosts, custom ports, `user:pass@`, fragments, and query parameter names that look like secrets (`token`, `api_key`, `password`, `signature`, `email`, `session`, etc.).
- Example: `/api/preflight?url=https%3A%2F%2Fx402.org`

### `/api/crypto`
- `/api/crypto` with no parameters returns **SOL-USDC only**.
- `/api/crypto?pair=RAY-USDC` returns RAY-USDC.
- `/api/crypto?pair=all` returns both SOL-USDC and RAY-USDC.
- Each pair contains `price_usdc`, `slot`, `base_reserve`, `quote_reserve_usdc`, `base_vault`, `quote_vault` and `pool_address`.
- Results are cached for about 30 s.

### `/api/weather`
- **City form:** `?city=london`. The value is case-insensitive, and spaces or hyphens become underscores, so `London` and `New York` also work. Supported cities: london, cardiff, edinburgh, new_york, san_francisco, los_angeles, toronto, paris, berlin, rome, madrid, amsterdam, tokyo, singapore, sydney, dubai, mumbai, sao_paulo, cape_town. Any other city returns `400`.
- **Coordinate form:** `?lat=51.5&lon=-0.12`. Each value can have up to 6 decimal places; latitude must be between -90 and 90 and longitude between -180 and 180.
- Do not send `city` together with `lat`/`lon`.
- Returns the next 6 forecast time steps: `time`, `temp_c`, `wind_mps`, `precipitation_mm_next_hour` and `symbol`.

### `/api/token-check?mint=…`
Reads the mint account from Solana mainnet and returns:
- `token_program` (`spl-token` or `token-2022`), `supply_raw`, `supply_ui` and `decimals`.
- `mint_authority` and `freeze_authority`: whether each is revoked, and the authority address if not.
- `extensions_present`: the names of the Token-2022 extensions on the mint.
- `risky_extensions`: each one is `true` only when it is effective, or an authority can switch it on:
  - `transfer_fee`: the fee is above 0 bps, or a fee-config authority is set;
  - `permanent_delegate`: a delegate is set;
  - `transfer_hook`: a hook program or hook authority is set;
  - `pausable`: a pause authority is set, or the mint is paused;
  - `non_transferable`: the extension is present.
- `top_10_token_accounts_share_pct`: the share of supply held by the 10 largest **token accounts**. These are not deduplicated into owners, and exchange or program vaults count. `concentration_status` is `ok`, `zero_supply` or `unavailable` (public RPCs often rate-limit this call; when that happens the rest of the result is still returned).
- `risk_flags`, `risk_points` and `risk_score`. The score is `low` at 0 points, `medium` at 1-2 and `high` at 3 or more. Points:
  - mint authority active +2, freeze authority active +2, zero supply +2;
  - top-10 accounts hold 50-80% +1, or 80% or more +2;
  - transfer fee +1, permanent delegate +3, transfer hook +2, pausable +2, non-transferable +3.

This is a heuristic, not an audit. Regulated stablecoins such as USDC score `high` because their issuer keeps mint and freeze control, so read the flags rather than the label alone. Liquidity, metadata, holder identities and hook-program behaviour are not checked.

## Client examples

### TypeScript (`@x402/fetch`)
```bash
npm i @x402/fetch@2.28.0 @x402/svm@2.28.0 @solana/kit@^5.5.1
```
`@x402/svm` 2.28.0 needs `@solana/kit` 5.x, so do not use 6.x. The full file is [`scripts/example-client.ts`](scripts/example-client.ts):
```ts
import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";

const API = "https://solana-x402-microtools-mainnet.valecity.workers.dev";
const PAY_TO = "Aqgp4nKbk3WV1e7fLHepkcdwLLz3j8DwHqLTLHVEa6GK";
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MAX_ATOMIC = 3_000n; // $0.003

const secret = Uint8Array.from(JSON.parse(readFileSync(process.env.SOLANA_KEYPAIR_FILE!, "utf8")));
const signer = await createKeyPairSignerFromBytes(secret);
const client = new x402Client();
client.registerPolicy((_v, offers) => offers.filter((x) =>
  x.network === MAINNET && x.asset === USDC && x.scheme === "exact" &&
  x.payTo === PAY_TO && BigInt(x.amount) <= MAX_ATOMIC));
client.register("solana:*", new ExactSvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);

const res = await fetchPaid(`${API}/api/weather?city=london`);
console.log(res.status, await res.text());
```

### Python (`x402[httpx,svm]`)
```bash
pip install "x402[httpx,svm]"   # tested with x402 2.25.0
```
The full file is [`examples/client.py`](examples/client.py):
```python
import asyncio, json, os
from solders.keypair import Keypair
from x402 import x402Client
from x402.mechanisms.svm import KeypairSigner
from x402.mechanisms.svm.exact import ExactSvmScheme
from x402.http.clients import wrapHttpxWithPayment

API = "https://solana-x402-microtools-mainnet.valecity.workers.dev"
PAY_TO = "Aqgp4nKbk3WV1e7fLHepkcdwLLz3j8DwHqLTLHVEa6GK"
MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
MAX_ATOMIC = 3000  # $0.003

with open(os.environ["SOLANA_KEYPAIR_FILE"]) as f:
    signer = KeypairSigner(Keypair.from_bytes(bytes(json.load(f))))

client = x402Client()
client.register_policy(lambda _v, offers: [
    o for o in offers
    if o.network == MAINNET and o.asset == USDC and o.scheme == "exact"
    and o.pay_to == PAY_TO and int(o.amount) <= MAX_ATOMIC
])
client.register("solana:*", ExactSvmScheme(signer))

async def main():
    async with wrapHttpxWithPayment(client, timeout=30) as http:
        r = await http.get(f"{API}/api/weather", params={"city": "london"})
        print(r.status_code, r.text)

asyncio.run(main())
```
`SOLANA_KEYPAIR_FILE` is a standard 64-byte Solana keypair JSON array, the same format `solana-keygen` produces.

## Safety notes
- **Use a dedicated, low-balance wallet** for paying agents. Fund it with a few cents of USDC; it does not need SOL for these calls, because the facilitator pays the network fee. Never point a client at your main wallet.
- **Pin your policy.** The examples only pay this `payTo`, in mainnet USDC, up to a fixed atomic amount. Keep a filter like that.
- **Failed calls are not settled.** The server verifies your payment, runs the tool, and only settles if the response is successful (2xx). If an upstream source (Solana RPC, MET Norway or the probed URL) fails and you get a `4xx`/`5xx`, the payment is not submitted. Settled payments are final.
- **Crypto output is a pool reserve ratio, not an oracle.** It is the USDC vault balance divided by the base-token vault balance of one Raydium AMM v4 pool, read from public Solana RPC. It is not an executable quote, not a market-wide price, not "trending" data and not financial advice, and it can be stale or moved by large trades.
- **Weather data is from MET Norway** ([api.met.no](https://api.met.no/)), licensed **CC BY 4.0**. Keep the attribution if you republish it. These are model forecasts, not live observations.
- **Preflight** makes one unpaid request to the URL you supply. It never pays the target's 402.
- **Privacy:** the service stores no request logs and no raw IP addresses. Rate limiting uses a salted hash of IP and route. Solana payments are public on-chain.

## Status
- **Verified mainnet paid call:** `GET /api/preflight?url=https://x402.org` paid $0.01 USDC and returned HTTP 200 with a `PAYMENT-RESPONSE` header, on 2026-10-22. Settlement tx: [`5GpQTrpqZL3E9ioZBn9TjqMFRYVaTq3K1yVYW6XvUWRBaZQXYfaRxyM2GC9unMsJWW2shivaTvFWPtUYxmzcCmNL`](https://solscan.io/tx/5GpQTrpqZL3E9ioZBn9TjqMFRYVaTq3K1yVYW6XvUWRBaZQXYfaRxyM2GC9unMsJWW2shivaTvFWPtUYxmzcCmNL). This was a self-test from the operator's own wallet.
- **Verified mainnet paid call:** `GET /api/token-check?mint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` paid $0.01 USDC and returned HTTP 200 with `concentration_status: "ok"`, on 2026-10-22. Settlement tx: [`24W8cDYjQ8fRb8Zy8CbqdZgikocvKXAPmcQXy65yGW4XoHsRSDx8naKHX29iWSFakfqRowxHedQL2MwSRfVCBFkL`](https://solscan.io/tx/24W8cDYjQ8fRb8Zy8CbqdZgikocvKXAPmcQXy65yGW4XoHsRSDx8naKHX29iWSFakfqRowxHedQL2MwSRfVCBFkL). This was a self-test from the operator's own wallet.
- **Verified mainnet paid call:** `GET /api/weather?city=London` paid $0.003 USDC and returned HTTP 200 with six MET Norway forecast points on 2026-10-22. Settlement tx: [`5g2QjHXDsAu7T3zhDzwfny1MryBwDfFC2Rxp14RJsuQf9PV8Do3qk49DcpyyD3erELvMrkLwdUaQ2jjFFwwR6Ycy`](https://solscan.io/tx/5g2QjHXDsAu7T3zhDzwfny1MryBwDfFC2Rxp14RJsuQf9PV8Do3qk49DcpyyD3erELvMrkLwdUaQ2jjFFwwR6Ycy). Self-test. All four paid routes have now settled at least one mainnet payment.
- Solana RPC: the server tries an optional keyed provider first (Cloudflare secret `PRIMARY_RPC_URL`, never committed), then the public endpoints in `SOLANA_RPC_URL` (a comma-separated list in `wrangler.jsonc`). `api.mainnet-beta.solana.com` blocks Cloudflare Workers, so it is only the last fallback.
- **Verified mainnet paid call:** `GET /api/crypto?pair=all` paid $0.003 USDC and returned HTTP 200 on 2026-10-22 (SOL-USDC 103.37, RAY-USDC 1.8446). Settlement tx: [`5KghBgoNsPR5ss1BxH1CUajYfpbm7khS5U8k1f56VTrSC9okbx88UdxiVcyVgwR4Qed8iZ49RepNW9NZTeG7WCc7`](https://solscan.io/tx/5KghBgoNsPR5ss1BxH1CUajYfpbm7khS5U8k1f56VTrSC9okbx88UdxiVcyVgwR4Qed8iZ49RepNW9NZTeG7WCc7). Self-test.
- Rate limits: 30 requests/min per client per route at the edge.

## Running your own copy
Requires Node ≥ 22.
```bash
npm install
npm run typecheck && npm test
# local: .dev.vars needs PAY_TO_ADDRESS, MET_CONTACT (real contact email), RATE_LIMIT_SALT (≥32 chars)
npx wrangler dev --env devnet
API_URL=http://localhost:8787 npm run test:unpaid
# deploy
npx wrangler secret put PAY_TO_ADDRESS --env mainnet   # also MET_CONTACT, RATE_LIMIT_SALT, optional PRIMARY_RPC_URL
npm run deploy:mainnet
```
The receiving wallet needs a USDC associated token account before its first payment (`scripts/create-ata.ts`).

## License and attribution
Weather: Data from MET Norway, CC BY 4.0. Crypto: on-chain Raydium pool vault balances via Solana JSON-RPC.
