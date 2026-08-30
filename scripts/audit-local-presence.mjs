import { readFile } from "node:fs/promises";
import {
  compareLocation,
  createCanonicalLocation,
  fetchGoogleBusinessProfileLocation,
  fetchGoogleBusinessProfileReviews,
  localBusinessJsonLd,
  planGoogleBusinessProfileSync,
} from "../packages/local-presence/src/index.ts";

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const specPath = arg("--spec");
if (!specPath) throw new Error("usage: node scripts/audit-local-presence.mjs --spec <canonical-location.json> [--account <id>] [--location <id>]");
const canonical = createCanonicalLocation(JSON.parse(await readFile(specPath, "utf8")));
const locationId = arg("--location");
const accountId = arg("--account");
if (!locationId) {
  process.stdout.write(`${JSON.stringify({ status: "UNAVAILABLE", reason: "GBP location id not supplied", canonicalDigest: canonical.canonicalDigest, jsonLd: localBusinessJsonLd(canonical) }, null, 2)}\n`);
  process.exitCode = 2;
} else {
  const live = await fetchGoogleBusinessProfileLocation(`locations/${locationId}`, process.env.GOOGLE_BUSINESS_PROFILE_ACCESS_TOKEN);
  if (live.status !== "PASS" || !live.value) {
    process.stdout.write(`${JSON.stringify({ ...live, canonicalDigest: canonical.canonicalDigest, jsonLd: localBusinessJsonLd(canonical) }, null, 2)}\n`);
    process.exitCode = live.status === "UNAVAILABLE" ? 2 : 1;
  } else {
    const comparison = compareLocation(canonical, live.value);
    const syncPlan = comparison.state === "DRIFT" ? planGoogleBusinessProfileSync(canonical, live.value) : undefined;
    const reviews = accountId ? await fetchGoogleBusinessProfileReviews(accountId, locationId, process.env.GOOGLE_BUSINESS_PROFILE_ACCESS_TOKEN) : { status: "UNAVAILABLE", reason: "GBP account id not supplied" };
    process.stdout.write(`${JSON.stringify({ status: comparison.state === "IN_SYNC" ? "PASS" : "DRIFT", comparison, syncPlan, reviews, jsonLd: localBusinessJsonLd(canonical) }, null, 2)}\n`);
    process.exitCode = comparison.state === "IN_SYNC" ? 0 : 2;
  }
}
