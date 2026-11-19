/**
 * Local smoke test for the storefront chat endpoint. No Shopify account, dev
 * store or LLM key needed.
 *
 *   npm run build && npm run smoke
 *
 * It starts the built app with throwaway credentials and the mock LLM, then
 * sends requests signed exactly the way Shopify's app proxy signs them. This
 * checks the real HTTP path: signature verification, session lookup, the chat
 * pipeline and the database. It does NOT prove anything about a live store.
 *
 * A fake shop row is added to the local dev database and removed afterwards.
 */
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";

const PORT = Number(process.env.SMOKE_PORT || 3987);
const BASE = `http://127.0.0.1:${PORT}`;
// Throwaway values that exist only for this run. Not real credentials.
const SECRET = "smoke-test-shared-secret";
const SHOP = "shopi-assist-smoke-test.myshopify.com";
const OTHER_SHOP = "shopi-assist-not-installed.myshopify.com";

if (!existsSync("build/server/index.js")) {
  console.error("No build found. Run `npm run build` first.");
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
      SHOPIFY_API_KEY: "smoke-test-client-id",
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

  const orderBody = { step: "quote", items: [{ variantId: "1", quantity: 1 }] };
  const unsignedOrder = await post(new URLSearchParams({ shop: SHOP }).toString(), orderBody, "order");
  check("unsigned order request -> 400", unsignedOrder.status === 400, `(got ${unsignedOrder.status})`);

  const forgedOrder = await post(signedQuery(proxyParams(SHOP), "wrong-secret"), orderBody, "order");
  check("order request signed with the wrong secret -> 400", forgedOrder.status === 400, `(got ${forgedOrder.status})`);

  const orderOff = await post(signedQuery(proxyParams(SHOP)), orderBody, "order");
  check(
    "signed order request while chat orders are off -> refused as disabled, readable through the proxy",
    orderOff.status === 200 && orderOff.json?.ok === false && orderOff.json?.error?.code === "disabled" && orderOff.json?.error?.status === 403,
    `(got ${orderOff.status} ${JSON.stringify(orderOff.json)})`,
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

  if (failures && process.env.SMOKE_VERBOSE) console.log(`\n--- server log ---\n${serverLog}`);
} catch (error) {
  failures += 1;
  console.error("Smoke test crashed:", error instanceof Error ? error.message : error);
} finally {
  await cleanup();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll smoke checks passed");
process.exit(failures ? 1 : 0);
