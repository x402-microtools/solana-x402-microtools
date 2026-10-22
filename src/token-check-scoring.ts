import type { z } from "zod";
import type { riskFlagSchema } from "./token-check-schemas";
export type RiskFlag = z.infer<typeof riskFlagSchema>;
export interface RiskInputs {
  mint_authority_active: boolean;
  freeze_authority_active: boolean;
  supply_zero: boolean;
  top_10_token_accounts_share_pct: number | null;
  transfer_fee: boolean;
  permanent_delegate: boolean;
  transfer_hook: boolean;
  non_transferable: boolean;
  pausable: boolean;
}
export function scoreTokenRisk(input: RiskInputs): {
  risk_flags: RiskFlag[]; risk_points: number; risk_score: "low" | "medium" | "high";
} {
  const flags: RiskFlag[] = [];
  const add = (condition: boolean, id: RiskFlag["id"], points: number, rule: string, reason: string) => {
    if (condition) flags.push({ id, points, rule, reason });
  };
  add(input.mint_authority_active, "mint_authority_active", 2,
    "Mint authority is not revoked (+2).", "The authority can create additional tokens, changing supply.");
  add(input.freeze_authority_active, "freeze_authority_active", 2,
    "Freeze authority is not revoked (+2).", "The authority can freeze individual token accounts.");
  add(input.supply_zero, "zero_supply", 2,
    "Raw supply is zero (+2).", "Concentration is undefined for a mint with no tokens in circulation.");
  const share = input.top_10_token_accounts_share_pct;
  if (share !== null && (!Number.isFinite(share) || share < 0 || share > 100)) {
    throw new RangeError("Top-10 token-account percentage must be between 0 and 100");
  }
  // One concentration flag only: these thresholds are mutually exclusive.
  add(share !== null && share >= 80, "top_10_accounts_at_least_80_percent", 2,
    "Largest 10 token accounts hold >=80% of supply (+2).", "Token-account concentration is high; accounts are not deduplicated into owners.");
  add(share !== null && share >= 50 && share < 80, "top_10_accounts_at_least_50_percent", 1,
    "Largest 10 token accounts hold >=50% and <80% of supply (+1).", "Token-account concentration is elevated; accounts are not deduplicated into owners.");
  add(input.transfer_fee, "transfer_fee", 1,
    "Token-2022 transfer fee is non-zero or an authority can change it (+1).", "Transfers may withhold a fee now or after an authority update; inspect the configuration separately.");
  add(input.permanent_delegate, "permanent_delegate", 3,
    "Token-2022 permanent delegate is set (+3).", "A permanent delegate can transfer or burn holders' tokens.");
  add(input.transfer_hook, "transfer_hook", 2,
    "Token-2022 transfer hook program or hook authority is set (+2).", "A hook can impose programmable conditions on transfers.");
  add(input.non_transferable, "non_transferable", 3,
    "Token-2022 non-transferable extension is present (+3).", "Normal holder-to-holder token transfers are not permitted.");
  add(input.pausable, "pausable", 2,
    "Token-2022 pausable extension is active or controllable (+2).", "An authority can pause all transfers, mints and burns.");
  const points = flags.reduce((n, flag) => n + flag.points, 0);
  return { risk_flags: flags, risk_points: points, risk_score: points >= 3 ? "high" : points >= 1 ? "medium" : "low" };
}
