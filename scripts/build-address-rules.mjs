/**
 * Builds app/assistant/address-rules.json from Shopify's open-source address
 * data (https://github.com/Shopify/worldwide, MIT licensed; see
 * THIRD_PARTY_NOTICES.md). It is the data Shopify's own checkout is built on:
 * for each country, which address fields there are and in what order, what
 * they are called, whether a postal code is needed and what one looks like.
 *
 *   git clone --depth 1 https://github.com/Shopify/worldwide /some/folder
 *   node scripts/build-address-rules.mjs /some/folder [commit]
 *
 * Run it again to pick up Shopify's changes. Only English labels are taken,
 * because the address form is in English.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

const source = process.argv[2];
const commit = process.argv[3] ?? "unknown";
if (!source || !existsSync(join(source, "data/regions"))) {
  console.error("Usage: node scripts/build-address-rules.mjs <path to a Shopify/worldwide checkout> [commit]");
  process.exit(1);
}
const REGIONS = join(source, "data/regions");
const OUTPUT = join(process.cwd(), "app/assistant/address-rules.json");

/** The data's field names, as the address form calls them. */
const FIELDS = {
  first_name: "firstName",
  last_name: "lastName",
  company: "company",
  address1: "address1",
  address2: "address2",
  city: "city",
  province: "province",
  zip: "zip",
  phone: "phone",
};

const readYaml = (path) => parse(readFileSync(path, "utf8"));

/** Labels and messages for one country (or the defaults), English only. */
function wording(code) {
  const path = join(REGIONS, code, "en.yml");
  if (!existsSync(path)) return {};
  const addresses = readYaml(path)?.en?.worldwide?.[code]?.addresses ?? {};
  const found = {};
  for (const [theirs, ours] of Object.entries(FIELDS)) {
    const entry = addresses[theirs];
    if (!entry) continue;
    const words = {};
    if (entry.label?.default) words.label = entry.label.default;
    if (entry.label?.optional) words.optional = entry.label.optional;
    if (entry.errors?.blank_instructional) words.blank = entry.errors.blank_instructional;
    if (ours === "zip" && entry.errors?.invalid_for_country_instructional) {
      words.invalid = entry.errors.invalid_for_country_instructional;
    }
    if (Object.keys(words).length) found[ours] = words;
  }
  return found;
}

const formats = [];
const countries = {};
// Every country calling code ("1", "44", "92"), for telling a number written
// with its country code from one written without.
const callingCodes = new Set();
let droppedPatterns = 0;

for (const file of readdirSync(REGIONS).sort()) {
  const match = /^([A-Z]{2})\.yml$/.exec(file);
  if (!match) continue;
  const code = match[1];
  const region = readYaml(join(REGIONS, file));
  const edit = region?.format?.edit;
  if (typeof edit !== "string") continue;
  if (/^[1-9]\d{0,2}$/.test(String(region.phone_number_prefix ?? ""))) {
    callingCodes.add(String(region.phone_number_prefix));
  }

  let format = formats.indexOf(edit);
  if (format < 0) format = formats.push(edit) - 1;
  const country = { name: String(region.name ?? code), format };

  if (edit.includes("{zip}")) {
    let pattern = typeof region.zip_regex === "string" ? region.zip_regex : null;
    if (pattern) {
      try {
        // The data is written for Ruby. Keep a pattern only if it means the same here.
        if (/\\[AzZh]|\(\?[a-z-]+[:)]|[*+?}]\+/.test(pattern)) throw new Error("ruby only");
        new RegExp(pattern, "i");
      } catch {
        pattern = null;
        droppedPatterns += 1;
      }
    }
    // As the data's own code decides it: a stated requirement wins, and
    // without one a postal code is needed where its shape is known.
    const stated = region.zip_requirement;
    country.zip = {
      required: stated ? stated === "required" : Boolean(region.zip_regex),
      ...(pattern ? { pattern } : {}),
      ...(region.zip_example ? { example: String(region.zip_example) } : {}),
    };
  }
  if (edit.includes("{province}")) {
    const hasZones = Array.isArray(region.zones) && region.zones.length > 0;
    country.provinceRequired = hasZones && region.province_optional !== true;
  }
  const words = wording(code);
  if (Object.keys(words).length) country.words = words;
  countries[code] = country;
}

const rules = {
  source: `https://github.com/Shopify/worldwide data/regions at ${commit}`,
  formats,
  words: wording("_default"),
  callingCodes: [...callingCodes].sort((a, b) => Number(a) - Number(b)),
  countries,
};
writeFileSync(OUTPUT, `${JSON.stringify(rules)}\n`);
console.log(
  `Wrote ${Object.keys(countries).length} countries, ${formats.length} layouts` +
    (droppedPatterns ? `, ${droppedPatterns} postal code patterns left out` : "") +
    ` to ${OUTPUT}`,
);
