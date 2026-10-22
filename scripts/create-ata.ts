import { readFileSync } from "node:fs";
import { address, appendTransactionMessageInstruction, createKeyPairSignerFromBytes, createSolanaRpc, createSolanaRpcSubscriptions, createTransactionMessage, getSignatureFromTransaction, pipe, sendAndConfirmTransactionFactory, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
// Usage: PAYER_KEYPAIR_FILE=./payer.json OWNER=<receiving wallet> npx tsx scripts/create-ata.ts
const OWNER = address(process.env.OWNER ?? "Aqgp4nKbk3WV1e7fLHepkcdwLLz3j8DwHqLTLHVEa6GK");
const MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const rpc = createSolanaRpc("https://api.mainnet-beta.solana.com");
const subs = createSolanaRpcSubscriptions("wss://api.mainnet-beta.solana.com");
const payer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(process.env.PAYER_KEYPAIR_FILE ?? "./payer.json", "utf8"))));
const [ata] = await findAssociatedTokenPda({ owner: OWNER, mint: MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
console.log("payer", payer.address, "ATA", ata);
const existing = await rpc.getAccountInfo(ata, { encoding: "base64" }).send();
if (existing.value) { console.log("ATA already exists"); process.exit(0); }
const ix = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: OWNER, mint: MINT });
const { value: bh } = await rpc.getLatestBlockhash().send();
const msg = pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m), (m) => appendTransactionMessageInstruction(ix, m));
const tx = await signTransactionMessageWithSigners(msg);
const sig = getSignatureFromTransaction(tx);
console.log("signature", sig);
await sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: subs })(tx as Parameters<ReturnType<typeof sendAndConfirmTransactionFactory>>[0], { commitment: "confirmed" });
console.log("confirmed");
