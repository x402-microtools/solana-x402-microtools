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
MAX_ATOMIC = int(os.environ.get("MAX_ATOMIC", "3000"))  # 3000 = $0.003

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
        print(r.status_code, r.headers.get("PAYMENT-RESPONSE") is not None)
        print(r.text[:1500])

asyncio.run(main())
