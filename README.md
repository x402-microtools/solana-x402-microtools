# Solana x402 Microtools

Six small pay-per-call HTTP APIs for AI agents and scripts, plus a free JSON-RPC 2.0 MCP discovery endpoint (`POST /mcp`). Payment uses the [x402](https://x402.org) v2 protocol: the first request gets `402 Payment Required`, your client pays in **USDC on Solana mainnet**, and the request is retried automatically. There are no accounts and no API keys.

- **Base URL:** `https://solana-x402-microtools-mainnet.valecity.workers.dev`
- **Network:** `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (Solana mainnet)
- **Asset:** USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- **payTo:** `Aqgp4nKbk3WV1e7fLHepkcdwLLz3j8DwHqLTLHVEa6GK`
- **Scheme:** `exact`, settled through the PayAI facilitator (`https://facilitator.payai.network`), which pays the Solana network fee
- **Methods:** `GET`, except `POST /api/tx-preview` (JSON body). `HEAD` and other methods return `405`.

## Endpoints

| Route | Price | Parameters |
|---|---|---|
| `GET /api/preflight` | $0.01 (10000 atomic USDC) | `url` (required): a public `https://` URL |
| `GET /api/crypto` | $0.003 (3000) | `pair` (optional): `SOL-USDC` (default), `RAY-USDC` or `all` |
| `GET /api/weather` | $0.003 (3000) | **either** `city` **or** both `lat` and `lon` |
| `GET /api/token-check` | $0.01 (10000) | `mint` (required): base58 SPL Token or Token-2022 mint address |
| `POST /api/tx-preview` | $0.01 (10000) | JSON body: `transaction` (required, base64 or base58, unsigned or signed, legacy or v0, max 1232 bytes), `wallet`, `encoding`, `intent`, `context` (all optional) |
| `GET /api/pool-pulse` | $0.003 (3000) | `window` (`15m` or `1h`, default `1h`), `limit` (`1`–`20`, default `10`), `min_liquidity_usd` (`0`–`1000000`, default `1000`), `dex` (`all`, `raydium`, `meteora`, `pumpswap`, default `all`) |

Free routes: `GET /health`, `GET /.well-known/x402.json` (discovery manifest with JSON schemas), `GET /.well-known/mcp.json`, `GET /mcp` and `POST /mcp` (JSON-RPC 2.0 MCP tool discovery), `GET /openapi.json`, `GET /llms.txt`.

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

### `POST /api/tx-preview`
Simulate a Solana transaction **before you sign it** and see what it would actually do. Send the serialized transaction (all-zero signature slots are fine, so an unsigned transaction from Jupiter or any SDK works as-is):
```bash
curl -X POST https://solana-x402-microtools-mainnet.valecity.workers.dev/api/tx-preview \
  -H 'Content-Type: application/json' \
  -d '{"transaction":"<base64 tx>","wallet":"<your address, optional>"}'
# -> 402 with a PAYMENT-REQUIRED challenge; an x402 client pays $0.01 and retries with the same body
```
What happens: the server calls `simulateTransaction` (with `sigVerify: false`, `replaceRecentBlockhash: true`, `innerInstructions: true`) on mainnet. The RPC resolves address lookup tables and returns pre/post balances, so v0 transactions are covered. You get:
- `success`, `error` (decoded, e.g. `Instruction 0 (System) failed: custom program error 0x1`) and a plain-English `summary`, e.g. `Would succeed. You send 0.00348844 SOL (incl. 0.00148844 SOL refundable rent for 1 new token account). You receive 68321.99715 BONK. Fee ~0.000005431 SOL. No red flags.`
- `sol_changes`: lamport before/after/delta for your wallet and fee payer, plus any other account whose balance changes.
- `token_changes`: per-mint SPL / Token-2022 before/after/delta for token accounts **owned by your wallet** (or the fee payer), including accounts created or closed by the transaction. A few well-known mints get a symbol (USDC, USDT, wSOL, BONK, JUP); others show the mint address only.
- `programs`: every program invoked (top-level and inner CPI), labelled when well known (System, SPL Token, Token-2022, ATA, Compute Budget, Memo, Jupiter v6, Raydium AMM v4/CLMM/CPMM, Orca Whirlpool, Meteora DLMM/Pools, Pump.fun, PumpSwap, ...).
- `red_flags` (`critical` / `warning` / `info`): `simulation_failed`, `token_approval` (approve/approveChecked on your token account, including inside CPIs), `token_account_owner_change` / `authority_change` (setAuthority), `close_account_to_other` (closes your token account and sends the rent elsewhere), `wallet_owner_reassigned` (System assign of your wallet, a drainer pattern), `wallet_loses_over_90pct_sol`, `unknown_program` (top-level program not on the list), `extra_signers`, `wallet_not_signer`.
- `fee_estimate_lamports` (from the RPC's own `fee` field; if missing, 5000 per signature plus compute-unit price × requested CU limit), `units_consumed`, `compute_unit_limit`, `compute_unit_price_micro_lamports`, `lookup_tables`, the first 50 `logs`, `slot`, `source`, `fetched_at`, `disclaimer`.

#### Pre-Sign Brief (optional, schema 1.0, same price)
Add an `intent` and/or `context` to the same request and every response gains these extra fields (all existing fields stay as they were):
```bash
curl -X POST .../api/tx-preview -H 'Content-Type: application/json' -d '{
  "transaction": "<base64 tx>", "wallet": "<you>",
  "intent": "swap 0.002 SOL for NVDAx",
  "context": { "type": "tokenized_equity", "ticker": "NVDAx" } }'
```
- `verdict`: `clear`, `caution` or `avoid`, with `reasons` (upper-case codes).
  - `avoid`: the simulation failed, or there is any `critical` red flag (for example a token approval, an owner change, a close that sends rent to someone else, a wallet reassign, losing over 90% of your SOL, or `tokenized_equity_counterfeit`).
  - `caution`: any `warning` red flag (for example `unknown_program` or `intent_identity_unverified`), or an intent that does not match what the transaction does.
  - `clear`: it succeeds, there are no critical or warning flags, and any intent matched with high confidence. `info` flags (`extra_signers`, `wallet_not_signer`) do not change the verdict.
  - **`clear` does not authorise signing.** It only means these rules found nothing.
- `unknown_program` is only raised for **top-level** programs outside the known list (Jupiter v6, Raydium, Orca, Meteora, Pump.fun and others). A normal Jupiter swap that routes through other exchanges inside Jupiter's call is therefore `clear`.
- `intent_match` has `checked`, `matches`, `mismatches` and `confidence`. Supported wording (anything else is `checked:false` with no penalty):
  - `send|transfer <amount> <SOL|symbol|mint> to <address>`: must match **exactly**, for both your outflow and the recipient's inflow.
  - `swap|sell <amount> <asset> for <asset>`: the input must be within 1%, and some output must arrive.
  - `buy <amount> <asset> for <asset>`: always flagged `BUY_SPEND_UNBOUNDED`, because the spend is not stated.
  - `approve …` and `close …`: always low confidence, so never `clear`.
  - How amounts are counted: SOL means native SOL plus wrapped SOL (wSOL). The network fee is added back when your wallet pays it, and refundable rent for new token accounts is added back too, so Jupiter wrap/unwrap and ATA creation don't count as spending.
  - Symbols are matched only through our own address-based list (SOL, USDC, USDT, BONK, JUP, xStocks), never through token metadata. Other tokens need their mint address.
  - Mismatch codes: `AMOUNT_MISMATCH`, `RECIPIENT_NOT_PAID`, `RECIPIENT_AMOUNT_MISMATCH`, `NO_OUTPUT_RECEIVED`, `EXTRA_TOKEN_OUTFLOW`, `EXTRA_SOL_OUTFLOW`, `TOKEN_NOT_FOUND`, …
- `tokenized_equity`: `checked_mints`, `claimed_mint`, `counterfeit_risk` and `reason`. The allowlist holds 6 verified xStocks mints (Backed Finance). Each is listed on <https://solana.com/news/case-study-xstocks>, is a Token-2022 mint on-chain whose metadata has the matching symbol and the issuer's update authority, and has issuer metadata at `xstocks-metadata.backed.fi/tokens/Solana/<TICKER>/metadata.json`:
  NVDAx `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh`, TSLAx `XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB`, AAPLx `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp`, SPYx `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W`, MSFTx `XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX`, AMZNx `Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg`.
  - `counterfeit_risk` is set only when you **claim** a stock (`context.type: "tokenized_equity"`, or a stock-like ticker such as `NVDAx`) and the token is not one of these mints, or its ticker doesn't match. It means "not verified", not proven fraud.
  - The issuers' own controls on these mints (permanent delegate, pausable, frozen-by-default accounts, transfer hook) are expected and are not counted against them.
- `priority_fee`: a summary of `getRecentPrioritizationFees` for the transaction's writable accounts, as worked out by the server (including accounts loaded from lookup tables).
  - Values are in **micro-lamports per compute unit**, as the official RPC docs define. You get the p75 (`recommended_micro_lamports`), the median, the sample counts, your transaction's own CU price and limit, and the cost in lamports at p75 for your CU limit.
  - It is `null` if the lookup fails or the lookup tables could not be resolved. That never changes the HTTP status or your charge, and it is a market hint, not a guarantee the transaction lands.
- `brief_hash`: `sha256:` over canonical JSON (sorted keys) of `success`, `sol_changes`, `token_changes`, `programs`, `red_flags` and `verdict`. It is a fingerprint for your records, not a signed attestation.
- A bad `intent` (empty or over 200 characters) or a bad `context` (unknown type, bad ticker or mint, extra keys) gets a free `400` before payment. The transaction is simulated exactly once.
- For a `send` intent, the recipient's token changes are also listed in `token_changes` with `is_wallet: false`.

Free `400`s (no payment): non-JSON or non-`application/json` body (`415`), unknown fields, bad base64/base58, a structurally invalid transaction (signature count not matching the header, unsupported version, trailing bytes, bad indexes), or a body over 8 KB (`413`). The transaction is only parsed before payment; it is not simulated until you pay.
A simulation that reports a transaction failure is still a paid `200` (the preview worked and told you it would fail). If every RPC is down you get `502`/`504` and are not charged.

Limits: this is a point-in-time simulation. State can change before you sign, swap amounts can differ, and an unknown program can do things the red-flag rules do not recognise. Token changes only cover accounts owned by your wallet or fee payer. Never use it as the only check before autonomous signing. Not financial advice.

### `/api/pool-pulse`
Returns newly created Solana DEX pools (Raydium, Meteora, PumpSwap) created within `window` (`15m` or `1h`, default `1h`) with at least `min_liquidity_usd` (default `1000`), ranked descending by `activity_score` (`0`–`100`, `score_version: "1"`).
- Each pool entry includes `pool_address`, `dex`, `base_mint`, `base_symbol`, `quote_mint`, `created_at`, `age_minutes`, `liquidity_usd`, `volume_5m_usd`, `buys_5m`, `sells_5m`, `net_buy_transactions_5m`, `price_change_5m_pct`, `activity_score`, `score_version`, and `observed_at`.
- `coverage` reports `{ method: "sampled_public_feeds", exhaustive: false, candidate_count, truncated }`, along with `source` (`["geckoterminal", "dexscreener"]`), `fetched_at`, and `cache_age_seconds`.
-Snapshots are cached for 45 seconds so polling agents get low-latency responses without rate-limiting upstream feeds. If upstream feeds are unavailable and no fresh snapshot exists, the endpoint returns `502`/`504` and cancels settlement.

### `POST /mcp` & `GET /mcp` (Free MCP discovery)
Stateless JSON-RPC 2.0 Model Context Protocol (MCP) endpoint supporting `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call` for all 6 tools (`solana_preflight`, `solana_crypto_market`, `weather_forecast`, `solana_token_check`, `solana_transaction_preview`, `solana_pool_pulse`).

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

### Solana Agent Kit v2 plugin
[`solana-agent-kit-plugin-tx-preview`](https://github.com/x402-microtools/solana-agent-kit-plugin-tx-preview) is a free, MIT-licensed, opt-in plugin that wraps `POST /api/tx-preview` as the method `previewTransaction` and the action `PREVIEW_TRANSACTION_BEFORE_SIGNING`. You supply the x402-paying `fetch`. The plugin never signs, sends or blocks.

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
- **Verified mainnet paid call:** `POST /api/tx-preview` with a genuine unsigned SOL transfer (never signed or sent) paid $0.01 USDC and returned HTTP 200 with the correct preview (`You send 0.001 SOL. Fee ~0.000005 SOL. No red flags.`), on 2026-10-22. Settlement tx: [`3z11L6EKjv1L2gDTdvQ6uJecn6CpnzNTksm8Pp2tosDGYLujZirKAJgsjJByKcoXpxQdoaCedSJiU1wWZWT2twXT`](https://solscan.io/tx/3z11L6EKjv1L2gDTdvQ6uJecn6CpnzNTksm8Pp2tosDGYLujZirKAJgsjJByKcoXpxQdoaCedSJiU1wWZWT2twXT). Self-test. An unsigned Jupiter v0 swap (SOL → BONK via Raydium, GoonFi and Whirlpool, 3 lookup tables, 39 accounts) was also previewed against mainnet with correct balance, rent and fee figures; the test suite includes a real Jupiter v0 fixture.
- **Verified mainnet paid call (Pre-Sign Brief):** `POST /api/tx-preview` with an unsigned SOL transfer (never signed or sent) and `intent: "send 0.001 SOL to 5bmk…"` paid $0.01 USDC and returned HTTP 200 with `verdict: "clear"` and `intent_match.matches: true` (high confidence), on 2026-10-22. Settlement tx: [`2dkaGLBxGeYu8Ps1s6YgScHdxLfGv5vNS73KEvoviasM3V1FZFXESLpHnkML1UfjpedU72LnCJbaKeNcksCwD3Gw`](https://solscan.io/tx/2dkaGLBxGeYu8Ps1s6YgScHdxLfGv5vNS73KEvoviasM3V1FZFXESLpHnkML1UfjpedU72LnCJbaKeNcksCwD3Gw). Self-test. Unpaid live checks: wrong recipient gives `caution` (`INTENT_RECIPIENT_NOT_PAID`); Jupiter SOL→USDC with `swap 0.002 SOL for USDC` gives `clear`; Jupiter SOL→NVDAx with `context.ticker: "NVDAx"` gives `clear` (known xStocks mint); the same transaction claimed as `AAPLx` gives `avoid`.
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
