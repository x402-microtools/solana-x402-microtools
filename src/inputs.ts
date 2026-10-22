export const PAIRS = ["SOL-USDC", "RAY-USDC", "all"] as const;
export type Pair = (typeof PAIRS)[number];
export const CITIES = {
  london: [51.5074, -0.1278], cardiff: [51.4816, -3.1791], edinburgh: [55.9533, -3.1883],
  new_york: [40.7128, -74.006], san_francisco: [37.7749, -122.4194],
  los_angeles: [34.0522, -118.2437], toronto: [43.6532, -79.3832],
  paris: [48.8566, 2.3522], berlin: [52.52, 13.405], rome: [41.9028, 12.4964],
  madrid: [40.4168, -3.7038], amsterdam: [52.3676, 4.9041],
  tokyo: [35.6762, 139.6503], singapore: [1.3521, 103.8198],
  sydney: [-33.8688, 151.2093], dubai: [25.2048, 55.2708],
  mumbai: [19.076, 72.8777], sao_paulo: [-23.5505, -46.6333],
  cape_town: [-33.9249, 18.4241]
} as const;
export class InputError extends Error {
  constructor(message: string) { super(message); this.name = "InputError"; }
}
function single(q: URLSearchParams, name: string): string | null {
  const all = q.getAll(name);
  if (all.length > 1) throw new InputError(`Duplicate parameter: ${name}`);
  return all[0] ?? null;
}
function only(q: URLSearchParams, names: readonly string[]) {
  for (const key of q.keys()) if (!names.includes(key)) throw new InputError(`Unknown parameter: ${key}`);
}
/** Reject all IP-literal destinations, private/special hostnames and redirects. DNS-rebinding remains a deployment risk. */
export function validateTarget(raw: string | null): URL {
  if (!raw || raw.length > 1600) throw new InputError("url is required (maximum 1600 characters)");
  let u: URL;
  try { u = new URL(raw); } catch { throw new InputError("Invalid absolute URL"); }
  if (u.protocol !== "https:") throw new InputError("Only HTTPS destinations are allowed");
  if (u.username || u.password || u.port || u.hash) {
    throw new InputError("Userinfo, custom port and fragment are prohibited");
  }
  for (const name of u.searchParams.keys()) {
    if (/(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|authorization|signature|bearer|email|session|credential)/i.test(name)) {
      throw new InputError("Target URL query must not contain credentials or personal identifiers");
    }
  }
  const h = u.hostname.toLowerCase();
  if (!h || h.length > 253 || !h.includes(".") || h.endsWith(".") || h.startsWith(".")) throw new InputError("Public DNS hostname required");
  if (h.startsWith("[") || /^\d+(?:\.\d+){0,3}$/.test(h) || /^0x[\da-f]+$/i.test(h)) throw new InputError("IP literal is prohibited");
  if (h.split(".").some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) throw new InputError("Invalid DNS hostname");
  const banned = ["localhost", "local", "internal", "localhost.localdomain", "home.arpa", "test", "invalid", "example", "onion"];
  if (banned.some((x) => h === x || h.endsWith(`.${x}`))) throw new InputError("Private or reserved hostname prohibited");
  if (["metadata.google.internal", "metadata.aws.internal"].includes(h)) throw new InputError("Metadata endpoint prohibited");
  return u;
}
export function parsePreflight(q: URLSearchParams): { target: URL } {
  only(q, ["url"]);
  return { target: validateTarget(single(q, "url")) };
}
export function parseCrypto(q: URLSearchParams): { pair: Pair } {
  only(q, ["pair"]);
  const pair = single(q, "pair") ?? "SOL-USDC";
  if (!PAIRS.includes(pair as Pair)) throw new InputError(`pair must be one of ${PAIRS.join(", ")}`);
  return { pair: pair as Pair };
}
export function parseWeather(q: URLSearchParams): { lat: number; lon: number; city: string | null } {
  only(q, ["city", "lat", "lon"]);
  const cityRaw = single(q, "city"), latRaw = single(q, "lat"), lonRaw = single(q, "lon");
  if (cityRaw !== null) {
    if (latRaw !== null || lonRaw !== null) throw new InputError("Provide either city or lat and lon, not both");
    const city = cityRaw.trim().toLowerCase().replace(/[ -]+/g, "_");
    if (!Object.prototype.hasOwnProperty.call(CITIES, city)) throw new InputError("Unsupported city; use lat/lon or a city in the manifest");
    const coordinates = CITIES[city as keyof typeof CITIES];
    return { lat: coordinates[0], lon: coordinates[1], city };
  }
  if (latRaw === null || lonRaw === null || latRaw.trim() === "" || lonRaw.trim() === "") {
    throw new InputError("Provide both lat and lon, or supported city");
  }
  for (const raw of [latRaw, lonRaw]) if (!/^-?\d{1,3}(?:\.\d{1,6})?$/.test(raw)) throw new InputError("Invalid coordinate format (up to six decimals)");
  const lat = Number(latRaw), lon = Number(lonRaw);
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new InputError("Coordinates out of range");
  return { lat, lon, city: null };
}
