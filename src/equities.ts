// Tokenized-equity mint allowlist (adapted from ChatGPT Pre-Sign Brief Part 3). No RPC at request time.
// Each entry was verified on 2026-10-22: (1) listed on https://solana.com/news/case-study-xstocks, (2) on-chain a
// Token-2022 mint with 8 decimals whose own tokenMetadata extension carries the symbol, update authority
// 5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq and a URI on xstocks-metadata.backed.fi, (3) the issuer metadata JSON
// returns the same symbol. Ticker/name claims are NEVER proof of identity; only the mint address is.
// Issuer controls (permanent delegate, pausable, default-frozen accounts, transfer hook) are normal for these mints
// and are not treated as counterfeit evidence.
export const XSTOCKS_ISSUER = "Backed Finance (xStocks)";
export const XSTOCKS_SOURCE = "https://solana.com/news/case-study-xstocks";
export const XSTOCKS_UPDATE_AUTHORITY = "5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq";
const verified = [
  ["NVDAx", "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"],
  ["TSLAx", "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"],
  ["AAPLx", "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp"],
  ["SPYx", "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W"],
  ["MSFTx", "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX"],
  ["AMZNx", "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg"]
] as const;
export interface VerifiedEquityMint { mint: string; ticker: string; issuer: string; source_url: string; metadata_url: string }
export const VERIFIED_EQUITY_MINTS: readonly VerifiedEquityMint[] = Object.freeze(verified.map(([ticker, mint]) => Object.freeze({
  ticker, mint, issuer: XSTOCKS_ISSUER, source_url: XSTOCKS_SOURCE,
  metadata_url: `https://xstocks-metadata.backed.fi/tokens/Solana/${ticker}/metadata.json`
})));
const BY_MINT = new Map(VERIFIED_EQUITY_MINTS.map((e) => [e.mint, e]));
export const getVerifiedEquity = (mint: string) => BY_MINT.get(mint) ?? null;
export function isStockLikeSymbol(symbol: unknown): boolean {
  return typeof symbol === "string" && /^[A-Z][A-Z0-9.]{0,8}(?:x|on)$/.test(symbol.trim());
}
function tickerBase(v: string): string {
  const l = v.toLowerCase();
  if (l.endsWith("on") && v.length > 2) return v.slice(0, -2).toUpperCase();
  if (l.endsWith("x") && v.length > 1) return v.slice(0, -1).toUpperCase();
  return v.toUpperCase();
}
export const tickerCompatible = (claim: string, e: VerifiedEquityMint) => tickerBase(claim) === tickerBase(e.ticker);
export interface EquityContext { type?: "memecoin" | "tokenized_equity"; ticker?: string; mint?: string }
export interface TokenizedEquityResult {
  checked_mints: Array<{ mint: string; known: boolean; ticker: string | null; issuer: string | null; source_url: string | null }>;
  claimed_mint: string | null;
  counterfeit_risk: boolean;
  reason: string | null;
}
/**
 * `counterfeit_risk` = an equity identity is CLAIMED (context) but cannot be tied to an allowlisted mint. Not proof of fraud.
 * Fixes vs draft: a ticker with type "memecoin" is not an equity claim; with several mints and no context.mint the single
 * allowlisted (or single non-trusted) mint is used, so USDC -> NVDAx is not flagged just for having two mints.
 */
export function checkTokenizedEquity(walletMints: readonly string[], trustedMints: ReadonlySet<string>, context?: EquityContext): TokenizedEquityResult {
  const mints = [...new Set(walletMints)];
  const claim = !!context && (context.type === "tokenized_equity" || (context.type === undefined && isStockLikeSymbol(context.ticker)));
  type Checked = TokenizedEquityResult["checked_mints"][number];
  const checked: Checked[] = mints.flatMap((m): Checked[] => {
    const r = getVerifiedEquity(m);
    if (r) return [{ mint: m, known: true, ticker: r.ticker, issuer: r.issuer, source_url: r.source_url }];
    if (claim && context?.mint === m) return [{ mint: m, known: false, ticker: context.ticker ?? null, issuer: null, source_url: null }];
    return [];
  });
  if (!claim) return { checked_mints: checked, claimed_mint: null, counterfeit_risk: false, reason: null };
  let claimed: string | null = null;
  if (context!.mint) {
    if (!mints.includes(context!.mint)) return { checked_mints: checked, claimed_mint: context!.mint, counterfeit_risk: true, reason: "Claimed mint does not appear in your balance changes" };
    claimed = context!.mint;
  } else {
    const known = mints.filter((m) => getVerifiedEquity(m));
    const untrusted = mints.filter((m) => !trustedMints.has(m) && !getVerifiedEquity(m));
    if (known.length === 1 && untrusted.length === 0) claimed = known[0];
    else if (known.length === 0 && untrusted.length === 1) claimed = untrusted[0];
    else if (known.length === 1 && context!.ticker && tickerCompatible(context!.ticker, getVerifiedEquity(known[0])!)) claimed = known[0];
  }
  if (!claimed) return { checked_mints: checked, claimed_mint: null, counterfeit_risk: true, reason: "Could not tie the claimed stock to exactly one allowlisted mint" };
  const rec = getVerifiedEquity(claimed);
  if (!rec) {
    if (!checked.some((c) => c.mint === claimed)) checked.push({ mint: claimed, known: false, ticker: context!.ticker ?? null, issuer: null, source_url: null });
    return { checked_mints: checked, claimed_mint: claimed, counterfeit_risk: true, reason: "Stock-like token is not an allowlisted issuer mint" };
  }
  if (context!.ticker && !tickerCompatible(context!.ticker, rec)) return { checked_mints: checked, claimed_mint: claimed, counterfeit_risk: true, reason: `Mint is ${rec.ticker}, not ${context!.ticker}` };
  return { checked_mints: checked, claimed_mint: claimed, counterfeit_risk: false, reason: null };
}
