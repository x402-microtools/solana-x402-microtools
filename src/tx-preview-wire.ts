/** Minimal Solana wire-format parser (legacy + v0) without @solana/web3.js. Pure, no network. */
import { base58 } from "@scure/base";
export const MAX_WIRE_BYTES = 1232; // PACKET_DATA_SIZE
export class BadTransaction extends Error { constructor(message: string) { super(message); this.name = "BadTransaction"; } }
export type Ix = { programIndex: number; accounts: number[]; data: Uint8Array };
export type Lookup = { table: string; writable: number[]; readonly: number[] };
export interface ParsedTx {
  version: "legacy" | 0;
  bytes: Uint8Array;
  signatureCount: number;
  signed: boolean[];
  header: { required: number; readonlySigned: number; readonlyUnsigned: number };
  staticKeys: string[];
  /** Static-key writability per the message header (before runtime demotion of programs / reserved ids). */
  staticWritable: boolean[];
  signers: string[];
  recentBlockhash: string;
  instructions: Ix[];
  lookups: Lookup[];
  lookupWritableCount: number;
  lookupReadonlyCount: number;
  feePayer: string;
}
class Reader {
  offset = 0;
  constructor(readonly buf: Uint8Array) {}
  u8(): number { if (this.offset >= this.buf.length) throw new BadTransaction("Truncated transaction"); return this.buf[this.offset++]; }
  bytes(n: number): Uint8Array {
    if (n < 0 || n > this.buf.length - this.offset) throw new BadTransaction("Truncated transaction");
    const b = this.buf.subarray(this.offset, this.offset + n); this.offset += n; return b;
  }
  /** compact-u16 (shortvec): max 3 bytes, value <= 0xffff, no non-canonical encodings. */
  short(): number {
    let n = 0;
    for (let i = 0; i < 3; i++) {
      const b = this.u8();
      n |= (b & 0x7f) << (7 * i);
      if (!(b & 0x80)) {
        if (i > 0 && b === 0) throw new BadTransaction("Non-canonical compact length");
        if (n > 0xffff) throw new BadTransaction("Compact length overflow");
        return n;
      }
    }
    throw new BadTransaction("Invalid compact length");
  }
}
const key = (b: Uint8Array) => base58.encode(b);
export function parseTransaction(buf: Uint8Array): ParsedTx {
  if (buf.length > MAX_WIRE_BYTES) throw new BadTransaction(`Transaction exceeds ${MAX_WIRE_BYTES} bytes`);
  const r = new Reader(buf);
  const signatureCount = r.short();
  if (signatureCount < 1 || signatureCount > 19) throw new BadTransaction("Invalid signature count"); // 19*64 > packet anyway
  const signed: boolean[] = [];
  for (let i = 0; i < signatureCount; i++) signed.push(r.bytes(64).some((x) => x !== 0)); // all-zero = unsigned placeholder
  // Message. A versioned message starts with a prefix byte (top bit set, low 7 bits = version) BEFORE the header;
  // a legacy message starts directly with the header, whose first byte (num_required_signatures) is < 128.
  let version: "legacy" | 0 = "legacy";
  let first = r.u8();
  if (first & 0x80) {
    const v = first & 0x7f;
    if (v !== 0) throw new BadTransaction(`Unsupported transaction version ${v}`);
    version = 0;
    first = r.u8();
  }
  const header = { required: first, readonlySigned: r.u8(), readonlyUnsigned: r.u8() };
  if (header.required !== signatureCount) throw new BadTransaction("Signature count does not match the message header");
  if (header.readonlySigned >= header.required) throw new BadTransaction("Fee payer must be a writable signer");
  const nStatic = r.short();
  if (nStatic < 1 || header.required + header.readonlyUnsigned > nStatic) throw new BadTransaction("Invalid account key counts");
  const staticKeys: string[] = [];
  for (let i = 0; i < nStatic; i++) staticKeys.push(key(r.bytes(32)));
  if (new Set(staticKeys).size !== staticKeys.length) throw new BadTransaction("Duplicate account keys");
  const staticWritable = staticKeys.map((_, i) => i < header.required
    ? i < header.required - header.readonlySigned
    : i < nStatic - header.readonlyUnsigned);
  const recentBlockhash = key(r.bytes(32));
  const nIx = r.short();
  const raw: Ix[] = [];
  for (let i = 0; i < nIx; i++) {
    const programIndex = r.u8();
    const nAcc = r.short();
    const accounts = Array.from(r.bytes(nAcc));
    const data = r.bytes(r.short());
    raw.push({ programIndex, accounts, data });
  }
  const lookups: Lookup[] = [];
  if (version === 0) {
    const nLookups = r.short();
    for (let i = 0; i < nLookups; i++) {
      const table = key(r.bytes(32));
      const writable = Array.from(r.bytes(r.short()));
      const readonly = Array.from(r.bytes(r.short()));
      if (writable.length + readonly.length === 0) throw new BadTransaction("Empty address table lookup");
      lookups.push({ table, writable, readonly });
    }
  }
  if (r.offset !== buf.length) throw new BadTransaction("Trailing bytes after transaction message");
  const lookupWritableCount = lookups.reduce((n, l) => n + l.writable.length, 0);
  const lookupReadonlyCount = lookups.reduce((n, l) => n + l.readonly.length, 0);
  const total = nStatic + lookupWritableCount + lookupReadonlyCount;
  if (total > 256) throw new BadTransaction("Too many account keys");
  for (const ix of raw) {
    // Program ids must be static keys (they cannot be loaded from lookup tables) and cannot be the fee payer.
    if (ix.programIndex === 0 || ix.programIndex >= nStatic) throw new BadTransaction("Invalid program id index");
    if (ix.accounts.some((a) => a >= total)) throw new BadTransaction("Instruction account index out of range");
  }
  return {
    version, bytes: buf, signatureCount, signed, header, staticKeys, staticWritable,
    signers: staticKeys.slice(0, header.required), recentBlockhash, instructions: raw, lookups,
    lookupWritableCount, lookupReadonlyCount, feePayer: staticKeys[0]
  };
}
/**
 * Full account list in runtime order: static keys, then ALL lookup-table writable keys (table by table), then ALL
 * lookup-table readonly keys. `loaded` comes from simulateTransaction's loadedAddresses.
 */
export function accountKeys(tx: ParsedTx, loaded?: { writable: string[]; readonly: string[] }): { keys: string[]; writable: boolean[] } {
  const w = loaded?.writable ?? [], ro = loaded?.readonly ?? [];
  return {
    keys: [...tx.staticKeys, ...w, ...ro],
    writable: [...tx.staticWritable, ...w.map(() => true), ...ro.map(() => false)]
  };
}
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
export function fromBase64(s: string): Uint8Array {
  if (!B64.test(s)) throw new BadTransaction("Invalid base64");
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
/** Decode + parse. With no explicit encoding, base64 is tried first, then base58; the first that parses wins. */
export function decodeTransaction(input: string, encoding?: "base64" | "base58"): { tx: ParsedTx; encoding: "base64" | "base58" } {
  const tries: Array<"base64" | "base58"> = encoding ? [encoding] : ["base64", "base58"];
  let lastErr: BadTransaction = new BadTransaction("Transaction is neither valid base64 nor base58");
  for (const enc of tries) {
    let bytes: Uint8Array;
    try {
      if (enc === "base64") bytes = fromBase64(input);
      else { if (!B58.test(input)) throw new BadTransaction("Invalid base58"); bytes = base58.decode(input); }
    } catch (e) { lastErr = e instanceof BadTransaction ? e : new BadTransaction(`Invalid ${enc}`); continue; }
    try { return { tx: parseTransaction(bytes), encoding: enc }; }
    catch (e) { lastErr = e instanceof BadTransaction ? e : new BadTransaction("Malformed transaction"); }
  }
  throw lastErr;
}
