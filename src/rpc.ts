/** Shared Solana JSON-RPC helper with an ordered fallback list (secret PRIMARY_RPC_URL first, then SOLANA_RPC_URL). */
export class RpcError extends Error {
  constructor(public readonly status: 400 | 429 | 502 | 504, message: string, public readonly rpcCode?: number) {
    super(message); this.name = "RpcError";
  }
}
type RpcResponse<T> = { jsonrpc: string; id: number; result?: T; error?: { code?: number; message?: string } };
export interface RpcOptions<T> {
  timeoutMs?: number;
  /** JSON-RPC error codes that mean the CLIENT's input is bad (returned as 400, no fallback). */
  clientErrorCodes?: number[];
  /** Reject a structurally incomplete result so the next endpoint is tried. */
  accept?: (result: T) => boolean;
}
/**
 * rpcUrl may be a comma-separated list; endpoints are tried in order and the next one is used on
 * network errors, timeouts, HTTP 403/429/5xx or JSON-RPC errors (some public RPCs block Cloudflare Workers
 * or restrict getTokenLargestAccounts).
 */
export async function rpc<T>(rpcUrl: string, method: string, params: unknown[], opts: RpcOptions<T> | number = {}): Promise<T> {
  const o: RpcOptions<T> = typeof opts === "number" ? { timeoutMs: opts } : opts;
  const urls = (rpcUrl ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  if (!urls.length || urls.some((u) => !u.startsWith("https://"))) throw new RpcError(502, "Solana RPC is not configured");
  let last: RpcError = new RpcError(502, "Solana RPC unavailable");
  for (const url of urls) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 4500)
      });
    } catch { last = new RpcError(504, "Solana RPC connection failed or timed out"); continue; }
    if (!res.ok) { last = new RpcError(res.status === 429 ? 429 : 502, res.status === 429 ? "Solana RPC rate limited" : "Solana RPC returned an HTTP error"); continue; }
    let json: RpcResponse<T>;
    try { json = await res.json() as RpcResponse<T>; }
    catch { last = new RpcError(502, "Solana RPC returned invalid JSON"); continue; }
    if (json?.error && typeof json.error.code === "number" && o.clientErrorCodes?.includes(json.error.code)) {
      throw new RpcError(400, `Solana RPC rejected the input: ${String(json.error.message ?? "invalid params").slice(0, 200)}`, json.error.code);
    }
    if (json?.error || json?.result === undefined || json?.result === null) { last = new RpcError(502, "Solana RPC returned an error"); continue; }
    if (o.accept && !o.accept(json.result)) { last = new RpcError(502, "Solana RPC returned an incomplete result"); continue; }
    return json.result;
  }
  throw last;
}
