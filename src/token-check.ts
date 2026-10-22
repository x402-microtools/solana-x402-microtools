import { base58 } from "@scure/base";
import { tokenCheckOutputSchema, tokenCheckQuerySchema, type TokenCheckOutput } from "./token-check-schemas";
import { scoreTokenRisk } from "./token-check-scoring";
const CLASSIC_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** spl-token-2022 ExtensionType (repr u16), verified against solana-program/token-2022 interface/src/extension/mod.rs. */
const EXT = { transfer_fee_config: 1, non_transferable: 9, permanent_delegate: 12, transfer_hook: 14, pausable: 26 } as const;
const EXT_NAMES: Record<number, string> = { 1: "TransferFeeConfig", 3: "MintCloseAuthority", 4: "ConfidentialTransferMint", 6: "DefaultAccountState",
  9: "NonTransferable", 10: "InterestBearingConfig", 12: "PermanentDelegate", 14: "TransferHook", 16: "ConfidentialTransferFeeConfig",
  18: "MetadataPointer", 19: "TokenMetadata", 20: "GroupPointer", 21: "TokenGroup", 22: "GroupMemberPointer", 23: "TokenGroupMember",
  24: "ConfidentialMintBurn", 25: "ScaledUiAmount", 26: "Pausable", 28: "PermissionedBurn" };
function nonZero(bytes: Uint8Array, start: number, len = 32): boolean {
  if (start + len > bytes.length) return true; // malformed/short data: treat as risky rather than silently clean
  for (let i = start; i < start + len; i++) if (bytes[i] !== 0) return true;
  return false;
}
const COMMITMENT = "confirmed";
export class TokenCheckError extends Error {
  constructor(public readonly status: 400 | 429 | 502 | 504, message: string) {
    super(message); this.name = "TokenCheckError";
  }
}
export function parseTokenCheckQuery(query: URLSearchParams): { mint: string } {
  const input = Object.fromEntries(query);
  if (query.getAll("mint").length !== 1 || [...query.keys()].length !== 1) {
    throw new TokenCheckError(400, "Exactly one mint query parameter is required");
  }
  const parsed = tokenCheckQuerySchema.safeParse(input);
  if (!parsed.success) throw new TokenCheckError(400, "mint must be a canonical base58-encoded 32-byte Solana public key");
  return parsed.data;
}
type RpcResponse<T> = { jsonrpc: string; id: number; result?: T; error?: { code?: number; message?: string } };
/**
 * rpcUrl may be a comma-separated list; endpoints are tried in order and the next one is used on
 * network errors, timeouts, HTTP 403/429/5xx or JSON-RPC errors (some public RPCs block Cloudflare Workers
 * or restrict getTokenLargestAccounts).
 */
async function rpc<T>(rpcUrl: string, method: string, params: unknown[], timeoutMs = 4500): Promise<T> {
  const urls = (rpcUrl ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  if (!urls.length || urls.some((u) => !u.startsWith("https://"))) throw new TokenCheckError(502, "Solana RPC is not configured");
  let last: TokenCheckError = new TokenCheckError(502, "Solana RPC unavailable");
  for (const url of urls) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch { last = new TokenCheckError(504, "Solana RPC connection failed or timed out"); continue; }
    if (!res.ok) { last = new TokenCheckError(res.status === 429 ? 429 : 502, res.status === 429 ? "Solana RPC rate limited" : "Solana RPC returned an HTTP error"); continue; }
    let json: RpcResponse<T>;
    try { json = await res.json() as RpcResponse<T>; }
    catch { last = new TokenCheckError(502, "Solana RPC returned invalid JSON"); continue; }
    if (json?.error || json?.result === undefined || json?.result === null) { last = new TokenCheckError(502, "Solana RPC returned an error"); continue; }
    return json.result;
  }
  throw last;
}
function publicKey(bytes: Uint8Array): string { return base58.encode(bytes); }
function authority(bytes: Uint8Array, optionOffset: number, keyOffset: number): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const present = view.getUint32(optionOffset, true);
  if (present !== 0 && present !== 1) throw new TokenCheckError(502, "Mint has malformed authority option");
  return present === 1 ? publicKey(bytes.slice(keyOffset, keyOffset + 32)) : null;
}
export interface MintSnapshot {
  mint: string;
  slot: number;
  token_program: "spl-token" | "token-2022";
  supply: bigint;
  decimals: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  risky_extensions: { transfer_fee: boolean; permanent_delegate: boolean; transfer_hook: boolean; non_transferable: boolean; pausable: boolean };
  extensions_present: string[];
}
/**
 * An extension only counts as risky if it is effective or can be switched on by an authority:
 * - TransferFeeConfig: config authority set, or older/newer fee > 0 bps (layout: auth 32, withdraw auth 32, withheld u64, 2x {epoch u64, max u64, bps u16})
 * - PermanentDelegate: delegate key non-null
 * - TransferHook: authority or program_id non-null (authority 32, program_id 32)
 * - Pausable: authority non-null or paused (authority 32, paused u8)
 * - NonTransferable: always (no data)
 */
function riskyExtensions(bytes: Uint8Array, ext: Map<number, { start: number; length: number }>): MintSnapshot["risky_extensions"] {
  const fee = ext.get(EXT.transfer_fee_config);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bps = (at: number) => (fee && fee.length >= 108 ? view.getUint16(fee.start + at, true) : 0);
  const pd = ext.get(EXT.permanent_delegate), hook = ext.get(EXT.transfer_hook), pause = ext.get(EXT.pausable);
  return {
    transfer_fee: !!fee && (fee.length < 108 || nonZero(bytes, fee.start) || bps(88) > 0 || bps(106) > 0),
    permanent_delegate: !!pd && nonZero(bytes, pd.start),
    transfer_hook: !!hook && (nonZero(bytes, hook.start) || nonZero(bytes, hook.start + 32)),
    non_transferable: ext.has(EXT.non_transferable),
    pausable: !!pause && (nonZero(bytes, pause.start) || (pause.start + 32 < bytes.length && bytes[pause.start + 32] !== 0))
  };
}
export function parseMintBytes(mint: string, slot: number, owner: string, bytes: Uint8Array): MintSnapshot {
  if (bytes.length < 82) throw new TokenCheckError(400, "Address is not an initialized SPL token mint");
  const token2022 = owner === TOKEN_2022_PROGRAM;
  if (owner !== CLASSIC_PROGRAM && !token2022) throw new TokenCheckError(400, "Address is not owned by an SPL token program");
  if (!token2022 && bytes.length === 165) throw new TokenCheckError(400, "Address is an SPL token account, not a mint");
  if (!token2022 && bytes.length !== 82) throw new TokenCheckError(400, "Legacy token mint has invalid account size");
  if (bytes[45] !== 1) throw new TokenCheckError(400, "Token mint is not initialized");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const supply = view.getBigUint64(36, true);
  const mintAuthority = authority(bytes, 0, 4);
  const freezeAuthority = authority(bytes, 46, 50);
  const extensions = new Map<number, { start: number; length: number }>();
  if (token2022 && bytes.length > 82) {
    // AccountType byte at offset 165: 1 = Mint, 2 = Account. Token accounts are a client error (400), not an RPC fault.
    if (bytes.length < 166 || bytes[165] !== 1) {
      throw new TokenCheckError(400, "Address is a Token-2022 account, not a mint");
    }
    let offset = 166;
    while (offset < bytes.length) {
      if (bytes.length - offset < 4) {
        if (bytes.length - offset === 1 && bytes[offset] === 0) break;
        throw new TokenCheckError(502, "Truncated Token-2022 extension header");
      }
      const kind = view.getUint16(offset, true);
      const length = view.getUint16(offset + 2, true);
      if (kind === 0) break;
      offset += 4;
      if (offset + length > bytes.length || extensions.has(kind)) {
        throw new TokenCheckError(502, "Malformed Token-2022 extension data");
      }
      extensions.set(kind, { start: offset, length });
      offset += length;
    }
  }
  return {
    mint, slot, token_program: token2022 ? "token-2022" : "spl-token", supply, decimals: bytes[44],
    mintAuthority, freezeAuthority,
    risky_extensions: riskyExtensions(bytes, extensions),
    extensions_present: [...extensions.keys()].sort((a, b) => a - b).map((k) => EXT_NAMES[k] ?? `Unknown(${k})`)
  };
}
/** Called after inbound rate limiting but BEFORE the x402 middleware; invalid/non-mint addresses are free 400s. */
export async function readMintSnapshot(rpcUrl: string, mint: string): Promise<MintSnapshot> {
  const response = await rpc<{ context?: { slot?: number }; value?: { owner?: string; data?: [string, string] } | null }>(
    rpcUrl, "getAccountInfo", [mint, { encoding: "base64", commitment: COMMITMENT }]
  );
  if (!response?.value) throw new TokenCheckError(400, "Mint account does not exist");
  const { owner, data } = response.value;
  if (typeof owner !== "string" || (owner !== CLASSIC_PROGRAM && owner !== TOKEN_2022_PROGRAM)) {
    throw new TokenCheckError(400, "Address is not owned by an SPL token program");
  }
  if (!Array.isArray(data) || data[1] !== "base64" || typeof data[0] !== "string" || data[0].length > 65536) {
    throw new TokenCheckError(502, "RPC did not return valid mint account data");
  }
  const slot = response.context?.slot;
  if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0) throw new TokenCheckError(502, "Mint RPC context slot missing");
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(data[0]), c => c.charCodeAt(0)); }
  catch { throw new TokenCheckError(502, "Malformed mint account base64"); }
  return parseMintBytes(mint, slot as number, owner, bytes);
}
function formatSupply(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const digits = raw.toString().padStart(decimals + 1, "0");
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`.replace(/\.?0+$/, "") || "0";
}
/** Run only after the x402 settlement middleware; no external providers besides public Solana JSON-RPC. */
async function largestAccounts(rpcUrl: string, snapshot: MintSnapshot): Promise<{ slot: number; count: number; top10: bigint } | null> {
  const response = await rpc<{ context?: { slot?: number }; value?: Array<{ amount?: string }> }>(
    rpcUrl, "getTokenLargestAccounts", [snapshot.mint, { commitment: COMMITMENT }], 9000
  );
  const slot = response?.context?.slot;
  if (typeof slot !== "number" || !Number.isSafeInteger(slot) || !Array.isArray(response.value) || response.value.length > 20) return null;
  const largest = response.value.slice(0, 10);
  if (largest.some(x => !x || typeof x.amount !== "string" || !/^\d+$/.test(x.amount))) return null;
  const top10 = largest.reduce((sum, account) => sum + BigInt(account.amount!), 0n);
  if (top10 > snapshot.supply) return null; // inconsistent snapshots across slots
  return { slot, count: largest.length, top10 };
}
/**
 * Runs only after x402 payment verification. Settlement happens only if this returns 2xx.
 * Holder concentration is best-effort: the public Solana RPC heavily rate-limits getTokenLargestAccounts, so if it
 * fails the result still reports authorities/extensions with concentration_status "unavailable" (no concentration flag).
 */
export async function analyzeToken(rpcUrl: string, snapshot: MintSnapshot): Promise<TokenCheckOutput> {
  let conc: Awaited<ReturnType<typeof largestAccounts>> = null;
  if (snapshot.supply !== 0n) {
    try { conc = await largestAccounts(rpcUrl, snapshot); } catch { conc = null; }
  }
  const concentration_status = snapshot.supply === 0n ? "zero_supply" : conc ? "ok" : "unavailable";
  const top10 = conc?.top10 ?? 0n;
  const slot = conc?.slot ?? null;
  // Exact threshold decisions: truncate to 4 decimal places rather than rounding a 79.9999% share to 80%.
  const share = !conc || snapshot.supply === 0n ? null : Number((top10 * 1_000_000n) / snapshot.supply) / 10_000;
  const ext = snapshot.risky_extensions;
  const scoring = scoreTokenRisk({
    mint_authority_active: snapshot.mintAuthority !== null,
    freeze_authority_active: snapshot.freezeAuthority !== null,
    supply_zero: snapshot.supply === 0n,
    top_10_token_accounts_share_pct: share,
    ...ext
  });
  return tokenCheckOutputSchema.parse({
    mint: snapshot.mint, token_program: snapshot.token_program, is_token_2022: snapshot.token_program === "token-2022",
    mint_authority: { revoked: snapshot.mintAuthority === null, address: snapshot.mintAuthority },
    freeze_authority: { revoked: snapshot.freezeAuthority === null, address: snapshot.freezeAuthority },
    supply_raw: snapshot.supply.toString(), supply_ui: formatSupply(snapshot.supply, snapshot.decimals),
    decimals: snapshot.decimals,
    top_10_token_accounts_share_pct: share,
    top_10_token_accounts_balance_raw: conc ? top10.toString() : null, top_10_token_accounts_count: conc?.count ?? null,
    concentration_status,
    risky_extensions: ext, extensions_present: snapshot.extensions_present, ...scoring,
    risk_scoring_rule: "0 points = low; 1-2 points = medium; 3+ points = high",
    mint_slot: snapshot.slot, largest_accounts_slot: slot, checked_at: new Date().toISOString(),
    limitations: "Heuristic, not an audit or trading recommendation. Top 10 are token accounts, not distinct wallet owners; custodial, exchange and program vault accounts can dominate. RPC calls can reference different slots. No liquidity, holder identities, metadata or hook-program behaviour checked. Concentration is best-effort and may be unavailable when the public RPC rate-limits."
  });
}
