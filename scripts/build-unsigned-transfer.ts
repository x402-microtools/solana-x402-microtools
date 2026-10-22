// Builds a genuine UNSIGNED mainnet SOL transfer (never signed, never sent) and prints base64 wire bytes.
import { address, appendTransactionMessageInstruction, compileTransaction, createSolanaRpc, createTransactionMessage,
  getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from "@solana/kit";
import { AccountRole } from "@solana/kit";
const from = address(process.env.FROM ?? "Aqgp4nKbk3WV1e7fLHepkcdwLLz3j8DwHqLTLHVEa6GK");
const to = address(process.env.TO ?? "5bmkKzfXpgMb3GgBw6UVWTQiv2q7LNAFvs9w6yAaVDoR");
const lamports = BigInt(process.env.LAMPORTS ?? "1000000");
const rpc = createSolanaRpc(process.env.RPC ?? "https://solana-rpc.publicnode.com");
const { value: bh } = await rpc.getLatestBlockhash().send();
const msg = pipe(createTransactionMessage({ version: (process.env.LEGACY ? "legacy" : 0) as 0 }), (m) => setTransactionMessageFeePayer(from, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
  (m) => appendTransactionMessageInstruction({ programAddress: address("11111111111111111111111111111111"), accounts: [{ address: from, role: AccountRole.WRITABLE_SIGNER }, { address: to, role: AccountRole.WRITABLE }], data: transferData(lamports) }, m));
console.log(getBase64EncodedWireTransaction(compileTransaction(msg)));
function transferData(n: bigint) { const b = new Uint8Array(12); const v = new DataView(b.buffer); v.setUint32(0, 2, true); v.setBigUint64(4, n, true); return b; }
