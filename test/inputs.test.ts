import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseCrypto, parsePreflight, parseWeather, validateTarget } from "../src/inputs";
test("preflight accepts public HTTPS URL", () => {
  assert.equal(validateTarget("https://www.example.org/x").hostname, "www.example.org");
  assert.equal(validateTarget("https://weather.example.org/api?city=Cardiff").searchParams.get("city"), "Cardiff");
  assert.equal(parsePreflight(new URLSearchParams("url=https%3A%2F%2Fx402.org")).target.protocol, "https:");
});
test("preflight rejects SSRF-prone targets and URL secrets", () => {
  for (const url of ["http://example.com", "https://127.0.0.1", "https://[::1]", "https://localhost", "https://a.internal", "https://host.local", "https://example.com:8443", "https://u:p@example.com", "https://example.com/?token=abc", "https://example.com/?api_key=abc", "https://metadata.google.internal", "https://0x7f000001"]) {
    assert.throws(() => validateTarget(url), url);
  }
});
test("crypto defaults, validates, rejects duplicates", () => {
  assert.equal(parseCrypto(new URLSearchParams()).pair, "SOL-USDC");
  assert.equal(parseCrypto(new URLSearchParams("pair=all")).pair, "all");
  assert.throws(() => parseCrypto(new URLSearchParams("pair=wat")));
  assert.throws(() => parseCrypto(new URLSearchParams("pair=all&pair=all")));
});
test("weather accepts city and bounds coordinates", () => {
  assert.deepEqual(parseWeather(new URLSearchParams("city=Cardiff")).city, "cardiff");
  assert.equal(parseWeather(new URLSearchParams("lat=51.5&lon=-0.1")).lat, 51.5);
  for (const q of ["city=unknown", "lat=100&lon=0", "lon=0", "lat=0&lon=0&city=london", "lat=NaN&lon=2", "lat=0&lon=2&unused=1"]) {
    assert.throws(() => parseWeather(new URLSearchParams(q)), q);
  }
});
