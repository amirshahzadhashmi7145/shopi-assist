/**
 * Stamps the chat widget's Liquid block with a fingerprint of its JavaScript
 * and stylesheet.
 *
 *   npm run widget:stamp
 *
 * The block adds the fingerprint to both asset URLs, so a browser that has an
 * older copy cached fetches the new one as soon as the assets change. Without
 * it, a shopper can keep running last week's widget against this week's
 * server. A test fails when the stamp is out of date; run this to fix it.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "extensions/chat-widget");
const BLOCK = join(ROOT, "blocks/shopi-assist-chat.liquid");
const STAMP = /(assign shopi_assist_build = ')[a-f0-9]*(')/;

export function widgetFingerprint() {
  const hash = createHash("sha256");
  for (const file of ["assets/shopi-assist.js", "assets/shopi-assist.css"]) {
    hash.update(readFileSync(join(ROOT, file)));
  }
  return hash.digest("hex").slice(0, 12);
}

export function stampedFingerprint() {
  return STAMP.exec(readFileSync(BLOCK, "utf8"))?.[0].split("'")[1] ?? null;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const source = readFileSync(BLOCK, "utf8");
  if (!STAMP.test(source)) {
    console.error("No `assign shopi_assist_build = '...'` line found in the widget block.");
    process.exit(1);
  }
  const fingerprint = widgetFingerprint();
  const stamped = source.replace(STAMP, `$1${fingerprint}$2`);
  if (stamped === source) {
    console.log(`Widget stamp is up to date (${fingerprint}).`);
  } else {
    writeFileSync(BLOCK, stamped);
    console.log(`Widget stamped ${fingerprint}.`);
  }
}
