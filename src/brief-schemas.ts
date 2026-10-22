// Additive request fields (validated in the FREE pre-payment check) and JSON Schemas (adapted from ChatGPT Part 5).
import { z } from "zod";
import { base58 } from "@scure/base";
const pubkey = z.string().min(32).max(44).refine((v) => { try { return base58.decode(v).length === 32; } catch { return false; } }, "must be a 32-byte base58 public key");
export const briefRequestFields = {
  intent: z.string().trim().min(1).max(200).optional(),
  context: z.object({
    type: z.enum(["memecoin", "tokenized_equity"]).optional(),
    ticker: z.string().trim().max(12).regex(/^[A-Za-z][A-Za-z0-9.]{0,11}$/).optional(),
    mint: pubkey.optional()
  }).strict().optional()
};
export const briefInputJsonSchema = {
  intent: { type: "string", maxLength: 200, description: "Optional plain intent, checked against the simulated effects. Supported: 'send <amt> <SOL|symbol|mint> to <address>', 'swap|sell <amt> <asset> for <asset>', 'buy <amt> <asset> for <asset>', 'approve ...', 'close ...'. Other wording: not checked, no penalty." },
  context: { type: "object", additionalProperties: false, properties: {
    type: { type: "string", enum: ["memecoin", "tokenized_equity"] },
    ticker: { type: "string", maxLength: 12, description: "Claimed ticker, e.g. NVDAx" },
    mint: { type: "string", description: "Claimed mint address" }
  }, description: "Optional claims about the asset; tokenized-equity claims are checked against an allowlist of verified xStocks mints" }
} as const;
export const briefOutputJsonSchema = {
  schema_version: { type: "string", const: "1.0" },
  verdict: { type: "string", enum: ["clear", "caution", "avoid"], description: "clear does NOT authorise signing" },
  reasons: { type: "array", items: { type: "string" } },
  intent_match: { type: "object", properties: { checked: { type: "boolean" }, matches: { type: "boolean" }, mismatches: { type: "array", items: { type: "string" } }, confidence: { type: "string", enum: ["high", "medium", "low"] } } },
  priority_fee: { type: ["object", "null"], description: "getRecentPrioritizationFees summary in micro-lamports per compute unit; null if unavailable" },
  tokenized_equity: { type: "object", properties: { checked_mints: { type: "array" }, claimed_mint: { type: ["string", "null"] }, counterfeit_risk: { type: "boolean" }, reason: { type: ["string", "null"] } } },
  brief_hash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" }
} as const;
