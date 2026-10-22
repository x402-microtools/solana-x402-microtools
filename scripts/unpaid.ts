export {};
const base = process.env.API_URL;
if (!base || !/^https?:\/\//.test(base)) throw Error("Set API_URL to your Worker origin");
const health = await fetch(new URL("/health", base));
console.log("Health:", health.status, await health.text());
if (!health.ok) process.exitCode = 1;
for (const path of ["/api/preflight?url=https%3A%2F%2Fx402.org", "/api/crypto?pair=SOL-USDC", "/api/weather?city=london"]) {
  const r = await fetch(new URL(path, base));
  console.log(path, r.status, "PAYMENT-REQUIRED:", r.headers.has("PAYMENT-REQUIRED"));
  if (r.status !== 402 || !r.headers.has("PAYMENT-REQUIRED")) process.exitCode = 1;
}
const invalid = await fetch(new URL("/api/preflight?url=http%3A%2F%2F127.0.0.1", base));
console.log("Rejected invalid target before charging:", invalid.status, await invalid.text());
if (invalid.status !== 400) process.exitCode = 1;
const head = await fetch(new URL("/api/weather?city=london", base), { method: "HEAD" });
console.log("HEAD blocked:", head.status);
if (head.status !== 405) process.exitCode = 1;
