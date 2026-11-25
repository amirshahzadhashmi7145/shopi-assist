import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import config, { appHosts, applicationUrls, hostsOf } from "../react-router.config";

describe("where the admin's forms may be posted from", () => {
  it("is the host of the app's own address, each host once", () => {
    expect(hostsOf(["https://shopi-assist.example.com"])).toEqual(["shopi-assist.example.com"]);
    // The path and the protocol do not matter; the port does.
    expect(
      hostsOf([
        "https://app.example.com/some/path?x=1",
        "http://app.example.com",
        "https://app.example.com:8443",
        "https://random-words.trycloudflare.com",
      ]),
    ).toEqual(["app.example.com", "app.example.com:8443", "random-words.trycloudflare.com"]);
  });

  it("leaves out what is not an address of the app", () => {
    // Unset, empty, a bind address, a host with no protocol, another kind of address.
    expect(hostsOf([undefined, "", "0.0.0.0", "localhost", "app.example.com", "ftp://app.example.com"])).toEqual([]);
    // Shopify's placeholder for an app with no address yet is not this app.
    expect(hostsOf(["https://shopify.dev/apps/default-app-home"])).toEqual([]);
    // Never a pattern: a list of exact hosts cannot let another site in.
    expect(hostsOf(["https://app.example.com", "https://*.trycloudflare.com", "https://**"])).toEqual([
      "app.example.com",
    ]);
  });

  it("reads the address a deployed app has written down for Shopify", () => {
    const toml = [
      'client_id = "abc"',
      'application_url = "https://shopi-assist.example.com"',
      "",
      "[auth]",
      'redirect_urls = [ "https://elsewhere.example.com/api/auth" ]',
      '# application_url = "https://commented-out.example.com"',
      '  application_url   =   "https://indented.example.com/app"  ',
    ].join("\n");
    expect(applicationUrls(toml)).toEqual([
      "https://shopi-assist.example.com",
      "https://indented.example.com/app",
    ]);
    expect(applicationUrls("")).toEqual([]);
    expect(applicationUrls('other_url = "https://not-this.example.com"')).toEqual([]);
  });

  it("gives React Router exactly the app's hosts", () => {
    expect(config.allowedActionOrigins).toBe(appHosts);
    // This checkout has no address of its own yet: its configuration holds
    // Shopify's placeholder, and the dev server gets its tunnel's address
    // from SHOPIFY_APP_URL when it starts. With neither, nothing is listed.
    const placeholder = applicationUrls(readFileSync("shopify.app.toml", "utf8"));
    expect(hostsOf([process.env.SHOPIFY_APP_URL, process.env.HOST, ...placeholder])).toEqual(appHosts);
  });
});
