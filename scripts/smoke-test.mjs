/**
 * Local smoke test for the built app. No Shopify account, dev store or LLM
 * key needed.
 *
 *   npm run smoke
 *
 * It builds the app, starts it with throwaway credentials and the mock LLM,
 * and checks two things over real HTTP:
 *
 *  - The storefront chat endpoint, with requests signed exactly the way
 *    Shopify's app proxy signs them: signature verification, session lookup,
 *    the chat pipeline and the database.
 *  - That the admin's forms can be posted at all. A deployed app is reached
 *    over HTTPS while the server behind the proxy is spoken to over HTTP, and
 *    React Router refuses a form post whose origin it does not recognise
 *    (see react-router.config.ts). An upgrade of React Router once broke
 *    every form in the admin this way with nothing here to notice.
 *
 * It does NOT prove anything about a live store.
 *
 * The app is built by this script, not beforehand, because the build has to
 * know the address the app is served at, and here that is a made-up one.
 * `build/` is left holding that build: run `npm run build` again before
 * using it for anything else.
 *
 * A fake shop row is added to the local dev database and removed afterwards.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";

import { PrismaClient } from "@prisma/client";

const PORT = Number(process.env.SMOKE_PORT || 3987);
const BASE = `http://127.0.0.1:${PORT}`;
// The address shoppers and merchants would reach the app at. It resolves
// nowhere (.test never does): requests go to BASE and only name this host,
// the way a proxy in front of the app passes them on.
const APP_HOST = "shopi-assist-smoke.test";
// Throwaway values that exist only for this run. Not real credentials.
const API_KEY = "smoke-test-client-id";
const SECRET = "smoke-test-shared-secret";
const SHOP = "shopi-assist-smoke-test.myshopify.com";
const OTHER_SHOP = "shopi-assist-not-installed.myshopify.com";

console.log(`Building the app as it would be served at https://${APP_HOST}`);
const built = spawnSync(process.execPath, ["node_modules/@react-router/dev/bin.js", "build"], {
  env: { ...process.env, NODE_ENV: "production", SHOPIFY_APP_URL: `https://${APP_HOST}` },
  stdio: ["ignore", "ignore", "inherit"],
});
if (built.status !== 0) {
  console.error("The build failed. Run `npm run build` to see why.");
  process.exit(1);
}

const db = new PrismaClient();
let server;
let failures = 0;

/** Signs query parameters the way Shopify's app proxy does. */
function signedQuery(params, secret = SECRET) {
  const message = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("");
  const signature = createHmac("sha256", secret).update(message).digest("hex");
  return new URLSearchParams({ ...params, signature }).toString();
}

function proxyParams(shop, extra = {}) {
  return {
    shop,
    path_prefix: "/apps/shopi-assist",
    timestamp: String(Math.floor(Date.now() / 1000)),
    logged_in_customer_id: "",
    ...extra,
  };
}

async function post(query, body, path = "chat") {
  const response = await fetch(`${BASE}/proxy/${path}?${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.50" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON bodies (for example an empty 400) are fine.
  }
  return { status: response.status, json };
}

/**
 * A form posted to an admin page the way a browser behind an HTTPS proxy
 * sends it: to the server over plain HTTP, naming the app's public host, with
 * the page it was posted from as `Origin`. No session token is sent, so the
 * furthest it can get is Shopify's sign-in check.
 */
function adminPost(path, origin) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: PORT,
        path,
        method: "POST",
        headers: {
          Host: APP_HOST,
          Origin: origin,
          "X-Forwarded-Proto": "https",
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode, body }));
      },
    );
    request.on("error", reject);
    request.end("message=hello");
  });
}

/**
 * Whether React Router turned a post away as coming from another site: it
 * answers 400, and in a production build says no more than that.
 */
const refusedAsCrossSite = (answer) => answer.status === 400;

/**
 * Whether a post got as far as Shopify's sign-in check, which answers one
 * that carries no session token with the page that fetches one. That page
 * names the app's client id.
 */
const reachedSignIn = (answer) => answer.status !== 400 && answer.body.includes(API_KEY);

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(`${BASE}/proxy/chat`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("Server did not start in time");
}

async function cleanup() {
  if (server) server.kill("SIGTERM");
  await db.conversation.deleteMany({ where: { shop: { in: [SHOP, OTHER_SHOP] } } });
  await db.shopSettings.deleteMany({ where: { shop: { in: [SHOP, OTHER_SHOP] } } });
  await db.session.deleteMany({ where: { shop: SHOP } });
  await db.$disconnect();
}

try {
  // An "installed" shop is one with an offline session in the database.
  await db.session.upsert({
    where: { id: `offline_${SHOP}` },
    create: {
      id: `offline_${SHOP}`,
      shop: SHOP,
      state: "smoke",
      isOnline: false,
      scope: "read_products",
      accessToken: "smoke-test-not-a-real-token",
    },
    update: {},
  });

  server = spawn("node", ["node_modules/@react-router/serve/bin.js", "build/server/index.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "production",
      SHOPIFY_API_KEY: API_KEY,
      SHOPIFY_API_SECRET: SECRET,
      SHOPIFY_APP_URL: BASE,
      SCOPES: "read_products",
      LLM_PROVIDER: "mock",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (chunk) => (serverLog += chunk));
  server.stderr.on("data", (chunk) => (serverLog += chunk));

  await waitForServer();
  console.log(`Server up on ${BASE} (mock LLM)\n`);
  const message = { message: "hello", visitorId: "smoke-visitor-0001" };

  console.log("Requests that must be rejected");
  const unsigned = await post(new URLSearchParams({ shop: SHOP }).toString(), message);
  check("unsigned request -> 400", unsigned.status === 400, `(got ${unsigned.status})`);

  const forged = await post(signedQuery(proxyParams(SHOP), "wrong-secret"), message);
  check("signature made with the wrong secret -> 400", forged.status === 400, `(got ${forged.status})`);

  const signedThenEdited = new URLSearchParams(signedQuery(proxyParams(OTHER_SHOP)));
  signedThenEdited.set("shop", SHOP);
  const tampered = await post(signedThenEdited.toString(), message);
  check("shop swapped after signing -> 400", tampered.status === 400, `(got ${tampered.status})`);

  const stale = await post(
    signedQuery(proxyParams(SHOP, { timestamp: String(Math.floor(Date.now() / 1000) - 3600) })),
    message,
  );
  check("signed request with an hour-old timestamp -> 400", stale.status === 400, `(got ${stale.status})`);

  const crossSite = await fetch(`${BASE}/proxy/chat?${signedQuery(proxyParams(SHOP))}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(message),
  });
  check("signed but sent as text/plain (cross-site form of the request) -> 415", crossSite.status === 415, `(got ${crossSite.status})`);

  const notInstalled = await post(signedQuery(proxyParams(OTHER_SHOP)), message);
  check(
    "validly signed but app not installed -> 404 not_installed",
    notInstalled.status === 404 && notInstalled.json?.error?.code === "not_installed",
    `(got ${notInstalled.status})`,
  );

  // What the widget used to send to place a pay-on-delivery order in the chat.
  const orderBody = { step: "place", items: [{ variantId: "1", quantity: 1 }] };
  const unsignedOrder = await post(new URLSearchParams({ shop: SHOP }).toString(), orderBody, "order");
  check("unsigned order request -> 400", unsignedOrder.status === 400, `(got ${unsignedOrder.status})`);

  const forgedOrder = await post(signedQuery(proxyParams(SHOP), "wrong-secret"), orderBody, "order");
  check("order request signed with the wrong secret -> 400", forgedOrder.status === 400, `(got ${forgedOrder.status})`);

  const orderOff = await post(signedQuery(proxyParams(SHOP)), orderBody, "order");
  check(
    "signed request to place an order in the chat -> refused: orders are placed at the checkout",
    orderOff.status === 200 &&
      orderOff.json?.ok === false &&
      orderOff.json?.error?.code === "disabled" &&
      orderOff.json?.error?.status === 403 &&
      /checkout/.test(orderOff.json?.error?.message ?? ""),
    `(got ${orderOff.status} ${JSON.stringify(orderOff.json)})`,
  );
  const placed = await db.conversationOrder.count({ where: { shop: SHOP } });
  check("no order was recorded for it", placed === 0, `(got ${placed})`);

  const addressForm = await fetch(`${BASE}/proxy/order?${signedQuery(proxyParams(SHOP))}`);
  const addressFormJson = await addressForm.json().catch(() => null);
  check(
    "address form asked for while address changes are off -> refused as disabled",
    addressFormJson?.ok === false && addressFormJson?.error?.code === "disabled",
    `(got ${addressForm.status} ${JSON.stringify(addressFormJson)})`,
  );

  console.log("\nRequests that must work");
  const statusResponse = await fetch(`${BASE}/proxy/chat?${signedQuery(proxyParams(SHOP))}`);
  const status = await statusResponse.json();
  check("status check -> ok, enabled, ready", status.ok && status.enabled && status.ready, JSON.stringify(status));

  const first = await post(signedQuery(proxyParams(SHOP)), message);
  check("signed chat message -> 200 with a reply", first.status === 200 && /mock model/.test(first.json?.reply ?? ""), `(got ${first.status} ${JSON.stringify(first.json)})`);
  check("reply has a conversation id", typeof first.json?.conversationId === "string");

  const second = await post(signedQuery(proxyParams(SHOP, { logged_in_customer_id: "4242" })), {
    ...message,
    message: "second message",
    conversationId: first.json?.conversationId,
  });
  check("follow-up continues the same conversation", second.json?.conversationId === first.json?.conversationId);

  const stored = await db.conversation.findFirst({
    where: { id: first.json?.conversationId ?? "", shop: SHOP },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  check("both exchanges were stored for the right shop", stored?.messages.length === 4, `(got ${stored?.messages.length})`);
  check("signed customer id was recorded", stored?.customerId === "4242", `(got ${stored?.customerId})`);

  const withEmail = await post(signedQuery(proxyParams(SHOP)), {
    ...message,
    message: "my email is smoke.tester@example.com",
    conversationId: first.json?.conversationId,
  });
  const masked = await db.message.findMany({
    where: { conversationId: withEmail.json?.conversationId ?? "", role: "user" },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  check(
    "email address is masked in the stored transcript",
    masked[0]?.content === "my email is [email removed]",
    `(got ${JSON.stringify(masked[0]?.content)})`,
  );

  const bad = await post(signedQuery(proxyParams(SHOP)), { message: "", visitorId: "smoke-visitor-0001" });
  check(
    "empty message -> invalid_request, readable through the proxy",
    bad.status === 200 && bad.json?.error?.code === "invalid_request" && bad.json?.error?.status === 400,
    `(got ${bad.status} ${JSON.stringify(bad.json)})`,
  );

  console.log("\nForms in the admin, posted as a browser behind HTTPS posts them");
  for (const [page, path] of [
    ["Settings", "/app/settings.data"],
    ["the preview chat", "/app/preview.data"],
    ["a setup step", "/app/setup.data"],
  ]) {
    const own = await adminPost(path, `https://${APP_HOST}`);
    check(
      `${page}, from the app's own address -> reaches the sign-in check, not refused as cross-site`,
      reachedSignIn(own),
      `(got ${own.status} ${own.body.replace(/\s+/g, " ").slice(0, 80)})`,
    );
  }
  const elsewhere = await adminPost("/app/settings.data", "https://another-site.test");
  check("Settings, from another site -> 400", refusedAsCrossSite(elsewhere), `(got ${elsewhere.status})`);

  if (failures && process.env.SMOKE_VERBOSE) console.log(`\n--- server log ---\n${serverLog}`);
} catch (error) {
  failures += 1;
  console.error("Smoke test crashed:", error instanceof Error ? error.message : error);
} finally {
  await cleanup();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll smoke checks passed");
process.exit(failures ? 1 : 0);
