import { z } from "zod";
import { base58 } from "@scure/base";
import { rpc, RpcError } from "./rpc";
import { BadTransaction, decodeTransaction, toBase64, type ParsedTx } from "./tx-preview-wire";
import { analyze, type SimValue } from "./tx-preview-analysis";
export const MAX_BODY_BYTES = 8192;
export class TxPreviewError extends Error {
  constructor(public readonly status: 400 | 413 | 415 | 502 | 504, message: string) { super(message); this.name = "TxPreviewError"; }
}
const pubkey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).refine((s) => { try { return base58.decode(s).length === 32; } catch { return false; } }, "must be a 32-byte base58 public key");
export const txPreviewBodySchema = z.object({
  transaction: z.string().min(1).max(2200),
  wallet: pubkey.optional(),
  encoding: z.enum(["base64", "base58"]).optional()
}).strict();
export type TxPreviewInput = { tx: ParsedTx; wallet?: string; encoding: "base64" | "base58" };
/** Free pre-payment validation: content type, size, JSON shape and full wire-format parse. Never touches the network. */
export function parseTxPreviewBody(contentType: string | undefined, raw: string): TxPreviewInput {
  if (!/^application\/json\b/i.test(contentType ?? "")) throw new TxPreviewError(415, "Content-Type must be application/json");
  if (raw.length > MAX_BODY_BYTES) throw new TxPreviewError(413, `Body must be at most ${MAX_BODY_BYTES} bytes`);
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new TxPreviewError(400, "Body must be valid JSON"); }
  const parsed = txPreviewBodySchema.safeParse(json);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new TxPreviewError(400, `Invalid body: ${i.path.join(".") || "(root)"} ${i.message}`);
  }
  try {
    const { tx, encoding } = decodeTransaction(parsed.data.transaction.trim(), parsed.data.encoding);
    return { tx, wallet: parsed.data.wallet, encoding };
  } catch (e) {
    throw new TxPreviewError(400, `Invalid transaction: ${e instanceof BadTransaction ? e.message : "malformed"}`);
  }
}
type SimResult = { context?: { slot?: number }; value?: SimValue };
/** Runs only after x402 verification. Settlement happens only if the handler returns 2xx. */
export async function previewTransaction(rpcUrl: string, input: TxPreviewInput) {
  let result: SimResult;
  try {
    result = await rpc<SimResult>(rpcUrl, "simulateTransaction", [toBase64(input.tx.bytes), {
      encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true, commitment: "confirmed"
    }], {
      timeoutMs: 9000,
      clientErrorCodes: [-32602], // "failed to deserialize" / invalid params: the client's transaction is bad
      // Need a real simulation result; a successful sim without balance arrays means an old/limited RPC, try the next one.
      accept: (r) => !!r?.value && typeof r.value === "object" && "err" in r.value && (r.value.err !== null || Array.isArray(r.value.preBalances))
    });
  } catch (e) {
    if (e instanceof RpcError) throw new TxPreviewError(e.status === 400 ? 400 : e.status === 504 ? 504 : 502, e.message);
    throw e;
  }
  const out = analyze(input.tx, result.value!, input.wallet);
  return {
    ...out,
    slot: typeof result.context?.slot === "number" ? result.context.slot : null,
    input_encoding: input.encoding,
    source: "solana-mainnet-rpc simulateTransaction (sigVerify=false, replaceRecentBlockhash=true)",
    fetched_at: new Date().toISOString(),
    disclaimer: "Simulation only: on-chain state can change before you sign, and unknown programs can behave differently later. Red flags are heuristics, not a security audit. Not financial advice."
  };
}
const flag = { type: "object", required: ["id", "severity", "message"], properties: { id: { type: "string" }, severity: { type: "string", enum: ["critical", "warning", "info"] }, message: { type: "string" }, instruction: { type: "string" } } };
export const txPreviewInputJsonSchema = {
  type: "object", additionalProperties: false, required: ["transaction"],
  properties: {
    transaction: { type: "string", maxLength: 2200, description: "Serialized Solana transaction (legacy or v0), signed or UNSIGNED (all-zero signature slots), max 1232 bytes, base64 or base58" },
    wallet: { type: "string", description: "Optional: your wallet address, to highlight its balance changes (defaults to the fee payer)" },
    encoding: { type: "string", enum: ["base64", "base58"], description: "Optional; auto-detected if omitted" }
  }
} as const;
export const txPreviewOutputJsonSchema = {
  type: "object", required: ["success", "summary", "sol_changes", "token_changes", "programs", "red_flags", "fee_estimate_lamports", "source", "fetched_at", "disclaimer"],
  properties: {
    success: { type: "boolean" }, error: { type: ["string", "null"] }, summary: { type: "string" },
    wallet: { type: "string" }, fee_payer: { type: "string" }, version: { type: ["string", "integer"] },
    sol_changes: { type: "array", items: { type: "object", properties: { account: { type: "string" }, delta_lamports: { type: "string" }, delta_sol: { type: "string" }, is_wallet: { type: "boolean" } } } },
    token_changes: { type: "array", items: { type: "object", properties: { owner: { type: "string" }, mint: { type: "string" }, symbol: { type: ["string", "null"] }, decimals: { type: "integer" }, before: { type: "string" }, after: { type: "string" }, delta: { type: "string" } } } },
    programs: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: ["string", "null"] }, known: { type: "boolean" }, top_level: { type: "boolean" } } } },
    red_flags: { type: "array", items: flag },
    units_consumed: { type: ["integer", "null"] }, fee_estimate_lamports: { type: "string" }, fee_estimate_method: { type: "string" },
    logs: { type: "array", items: { type: "string" } }, slot: { type: ["integer", "null"] },
    source: { type: "string" }, fetched_at: { type: "string", format: "date-time" }, disclaimer: { type: "string" }
  }
} as const;
