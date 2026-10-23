import { base58 } from "@scure/base";
import { z } from "zod";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const mintAddressSchema = z.string().min(32).max(44).regex(BASE58).refine((value) => {
  try {
    const decoded = base58.decode(value);
    return decoded.length === 32 && base58.encode(decoded) === value;
  } catch { return false; }
}, "mint must be a canonical base58-encoded 32-byte Solana public key");
export const tokenCheckQuerySchema = z.object({ mint: mintAddressSchema }).strict();
export type TokenCheckQuery = z.infer<typeof tokenCheckQuerySchema>;
export const riskFlagIdSchema = z.enum([
  "mint_authority_active", "freeze_authority_active", "zero_supply",
  "top_10_accounts_at_least_50_percent", "top_10_accounts_at_least_80_percent",
  "transfer_fee", "permanent_delegate", "transfer_hook", "non_transferable", "pausable"
]);
export const riskFlagSchema = z.object({
  id: riskFlagIdSchema,
  points: z.number().int().min(1),
  rule: z.string().min(1),
  reason: z.string().min(1)
}).strict();
export const tokenCheckOutputSchema = z.object({
  mint: mintAddressSchema,
  token_program: z.enum(["spl-token", "token-2022"]),
  is_token_2022: z.boolean(),
  mint_authority: z.object({ revoked: z.boolean(), address: mintAddressSchema.nullable() }).strict(),
  freeze_authority: z.object({ revoked: z.boolean(), address: mintAddressSchema.nullable() }).strict(),
  supply_raw: z.string().regex(/^\d+$/),
  supply_ui: z.string().regex(/^\d+(?:\.\d+)?$/),
  decimals: z.number().int().min(0).max(255),
  top_10_token_accounts_share_pct: z.number().min(0).max(100).nullable(),
  top_10_token_accounts_balance_raw: z.string().regex(/^\d+$/).nullable(),
  top_10_token_accounts_count: z.number().int().min(0).max(10).nullable(),
  concentration_status: z.enum(["ok", "zero_supply", "unavailable"]),
  risky_extensions: z.object({
    transfer_fee: z.boolean(), permanent_delegate: z.boolean(),
    transfer_hook: z.boolean(), non_transferable: z.boolean(), pausable: z.boolean()
  }).strict(),
  extensions_present: z.array(z.string()),
  risk_flags: z.array(riskFlagSchema),
  risk_points: z.number().int().nonnegative(),
  risk_score: z.enum(["low", "medium", "high"]),
  risk_scoring_rule: z.literal("0 points = low; 1-2 points = medium; 3+ points = high"),
  mint_slot: z.number().int().nonnegative(),
  largest_accounts_slot: z.number().int().nonnegative().nullable(),
  checked_at: z.string().datetime(),
  limitations: z.string().min(1)
}).strict();
export type TokenCheckOutput = z.infer<typeof tokenCheckOutputSchema>;
// JSON Schema counterparts for the existing OpenAPI and Bazaar discovery registry.
const address = { type: "string", pattern: "^[1-9A-HJ-NP-Za-km-z]{32,44}$", description: "Canonical 32-byte Solana public key in base58" };
const nullableAddress = { type: ["string", "null"], pattern: "^[1-9A-HJ-NP-Za-km-z]{32,44}$", description: "Canonical 32-byte Solana public key in base58" };
const authority = { type: "object", additionalProperties: false, required: ["revoked", "address"], properties: {
  revoked: { type: "boolean" }, address: nullableAddress
} };
const u64String = { type: "string", pattern: "^[0-9]+$" };
export const tokenCheckInputJsonSchema = {
  type: "object", additionalProperties: false, required: ["mint"],
  properties: { mint: address }
};
export const tokenCheckOutputJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["mint", "token_program", "is_token_2022", "mint_authority", "freeze_authority",
    "supply_raw", "supply_ui", "decimals", "top_10_token_accounts_share_pct", "top_10_token_accounts_balance_raw",
    "top_10_token_accounts_count", "concentration_status", "risky_extensions", "extensions_present", "risk_flags", "risk_points", "risk_score",
    "risk_scoring_rule", "mint_slot", "largest_accounts_slot", "checked_at", "limitations"],
  properties: {
    mint: address,
    token_program: { type: "string", enum: ["spl-token", "token-2022"] },
    is_token_2022: { type: "boolean" },
    mint_authority: authority, freeze_authority: authority,
    supply_raw: u64String, supply_ui: { type: "string", pattern: "^[0-9]+(\\.[0-9]+)?$" },
    decimals: { type: "integer", minimum: 0, maximum: 255 },
    top_10_token_accounts_share_pct: { type: ["number", "null"], minimum: 0, maximum: 100 },
    top_10_token_accounts_balance_raw: { type: ["string", "null"], pattern: "^[0-9]+$" },
    top_10_token_accounts_count: { type: ["integer", "null"], minimum: 0, maximum: 10 },
    concentration_status: { type: "string", enum: ["ok", "zero_supply", "unavailable"] },
    risky_extensions: { type: "object", additionalProperties: false, required: ["transfer_fee", "permanent_delegate", "transfer_hook", "non_transferable", "pausable"],
      properties: { transfer_fee: { type: "boolean" }, permanent_delegate: { type: "boolean" }, transfer_hook: { type: "boolean" }, non_transferable: { type: "boolean" }, pausable: { type: "boolean" } } },
    extensions_present: { type: "array", items: { type: "string" } },
    risk_flags: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["id", "points", "rule", "reason"], properties: {
        id: { type: "string", enum: riskFlagIdSchema.options }, points: { type: "integer", minimum: 1 },
        rule: { type: "string" }, reason: { type: "string" }
      } } },
    risk_points: { type: "integer", minimum: 0 },
    risk_score: { type: "string", enum: ["low", "medium", "high"] },
    risk_scoring_rule: { type: "string", const: "0 points = low; 1-2 points = medium; 3+ points = high" },
    mint_slot: { type: "integer", minimum: 0 }, largest_accounts_slot: { type: ["integer", "null"], minimum: 0 },
    checked_at: { type: "string", format: "date-time" }, limitations: { type: "string" }
  }
};
