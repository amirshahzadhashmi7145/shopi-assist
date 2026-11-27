/**
 * React Router's settings for this app. One thing is set: where the admin's
 * forms may be posted from.
 *
 * React Router turns away a form post (saving Settings, a setup step, a
 * message in the preview chat) whose `Origin` is not the address the server
 * believes it is running at, answering "400 Bad Request". Since React Router
 * 7.18.3 that comparison includes the protocol. A Shopify app is always
 * reached over HTTPS, through a tunnel in development and a proxy or load
 * balancer in production, while the server behind it is spoken to over plain
 * HTTP and has no way to know. So the browser says `https://the-app` and the
 * server thinks `http://the-app`, and without the list below every form in
 * the admin is refused. (Shopify's own app template avoids this by staying
 * on React Router 7.18.2; this app takes the newer releases and says where
 * it lives instead.)
 *
 * The list is the app's own address and nothing else:
 *
 *   - `SHOPIFY_APP_URL`, which `shopify app dev` sets to the tunnel's
 *     address each time it starts, and which a host can set for a build;
 *   - `application_url` in `shopify.app.toml` (and any `shopify.app.*.toml`),
 *     which is where a deployed app's address is written down for Shopify
 *     anyway. Until it holds the real address (a new app has Shopify's
 *     placeholder there, which does not count), a production build has to be
 *     given `SHOPIFY_APP_URL`: the Dockerfile takes it as a build argument.
 *
 * It is read when the dev server starts and when the app is built, and is
 * fixed in the build from then on.
 *
 * This is an extra guard, not what protects these forms. Every admin request
 * is authenticated by a Shopify session token sent in a header, never by a
 * cookie, so a page on another site has nothing to ride on. `npm run smoke`
 * posts a form the way a browser behind HTTPS does, and one from another
 * site, to keep both true.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Config } from "@react-router/dev/config";

/** What Shopify puts in a new app's configuration until it has an address of its own. */
const PLACEHOLDER_HOSTS = new Set(["shopify.dev"]);

/**
 * The hosts in a list of addresses, each once: "https://app.example.com/x"
 * gives "app.example.com". Anything that is not a web address is left out,
 * and so is Shopify's placeholder. So is a host with a `*` in it: React
 * Router would read that as a pattern, and this list is exact hosts only.
 */
export function hostsOf(addresses: ReadonlyArray<string | undefined>): string[] {
  const hosts = new Set<string>();
  for (const address of addresses) {
    if (!address) continue;
    try {
      const url = new URL(address);
      if (!/^https?:$/.test(url.protocol) || PLACEHOLDER_HOSTS.has(url.hostname)) continue;
      if (url.hostname.includes("*")) continue;
      hosts.add(url.host);
    } catch {
      // Not an address (a bind address such as "0.0.0.0", for one).
    }
  }
  return [...hosts];
}

/** Every `application_url` in the text of a Shopify app configuration file. */
export function applicationUrls(toml: string): string[] {
  return [...toml.matchAll(/^[ \t]*application_url[ \t]*=[ \t]*"([^"\n]+)"/gm)].map(
    (match) => match[1],
  );
}

/** The addresses written in the app's Shopify configuration files, next to this file. */
function configuredAddresses(): string[] {
  let root = process.cwd();
  try {
    root = dirname(fileURLToPath(import.meta.url));
  } catch {
    // Loaded some way that has no file address: the working directory is the project.
  }
  try {
    return readdirSync(root)
      .filter((file) => /^shopify\.app(\.[\w-]+)?\.toml$/.test(file))
      .flatMap((file) => applicationUrls(readFileSync(join(root, file), "utf8")));
  } catch {
    return [];
  }
}

/** The hosts this app is reached at: the only places its admin forms are posted from. */
export const appHosts = hostsOf([
  process.env.SHOPIFY_APP_URL,
  process.env.HOST,
  ...configuredAddresses(),
]);

if (!appHosts.length && process.env.NODE_ENV === "production") {
  console.warn(
    "\n[shopi-assist] This build does not know the app's address, so behind HTTPS its admin forms " +
      'will be refused with "400 Bad Request". Set application_url in shopify.app.toml to the ' +
      "app's address, or build with SHOPIFY_APP_URL set to it.\n",
  );
}

export default {
  allowedActionOrigins: appHosts,
} satisfies Config;
