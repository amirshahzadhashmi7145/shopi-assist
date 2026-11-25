import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ChatError } from "../app/assistant/chat.server";
import { getEmailStatus, type EmailMessage } from "../app/assistant/email.server";
import { RateLimiter } from "../app/assistant/rate-limit";
import { saveSettings } from "../app/assistant/settings.server";
import {
  backInStockEmail,
  deleteStockAlertsForEmail,
  handleStockAlert,
  hasWaitingAlerts,
  notifyBackInStock,
  stockAlertSummary,
  stockAlertsOffered,
} from "../app/assistant/stock-alerts.server";
import { deleteShopData, purgeStockAlerts } from "../app/assistant/store.server";
import type { GraphqlFn } from "../app/assistant/types";
import { createTestDb } from "./helpers/db";

const SHOP_A = "shop-a.myshopify.com";
const SHOP_B = "shop-b.myshopify.com";

let db: PrismaClient;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});
afterAll(async () => {
  await cleanup();
});
beforeEach(async () => {
  await db.stockAlert.deleteMany();
  await db.shopSettings.deleteMany();
  await saveSettings(SHOP_A, { stockAlerts: true }, db);
});

/** A product with three versions: one in stock, two sold out. */
const product = (overrides: Record<string, unknown> = {}) => ({
  id: "gid://shopify/Product/500",
  title: "Ski Wax",
  availableForSale: true,
  variants: {
    nodes: [
      { id: "gid://shopify/ProductVariant/501", title: "Regular", availableForSale: true },
      { id: "gid://shopify/ProductVariant/502", title: "Special", availableForSale: false },
      { id: "gid://shopify/ProductVariant/503", title: "Sample", availableForSale: false },
    ],
  },
  ...overrides,
});
const storefront = (node: unknown = product()) => {
  const calls: unknown[] = [];
  const fn = (async (_query: string, variables?: Record<string, unknown>) => {
    calls.push(variables);
    if (node instanceof Error) throw node;
    return { node };
  }) as unknown as GraphqlFn & { calls: unknown[] };
  fn.calls = calls;
  return fn;
};
const ask = (
  body: Record<string, unknown>,
  options: { shop?: string; store?: ReturnType<typeof storefront>; rateLimiter?: RateLimiter; emailReady?: boolean } = {},
) =>
  handleStockAlert(
    { shop: options.shop ?? SHOP_A, body, ip: "203.0.113.7", storefront: options.store ?? storefront() },
    { db, rateLimiter: options.rateLimiter ?? new RateLimiter(), emailReady: () => options.emailReady ?? true },
  );
const refused = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ChatError);
  return error as ChatError;
};
const rows = () => db.stockAlert.findMany({ orderBy: { createdAt: "asc" } });

describe("asking for a back-in-stock alert", () => {
  it("records who is waiting for which version, with the store's own names for them", async () => {
    const store = storefront();
    expect(
      await ask({ productId: "500", variantId: "502", email: " Ada@Example.com ", productTitle: "Free stuff" }, { store }),
    ).toEqual({ ok: true, status: "subscribed" });

    expect(store.calls).toEqual([{ id: "gid://shopify/Product/500" }]);
    const [alert] = await rows();
    expect(alert).toMatchObject({
      shop: SHOP_A,
      productId: "500",
      variantId: "502",
      // From Shopify, not from the request; the address in lower case.
      productTitle: "Ski Wax",
      variantTitle: "Special",
      email: "ada@example.com",
      notifiedAt: null,
      attempts: 0,
    });
  });

  it("takes a whole product that is sold out, and says so when there is nothing to wait for", async () => {
    const soldOut = product({
      availableForSale: false,
      variants: { nodes: [{ id: "gid://shopify/ProductVariant/601", title: "Default Title", availableForSale: false }] },
    });
    expect(await ask({ productId: "500", email: "ada@example.com" }, { store: storefront(soldOut) })).toEqual({
      ok: true,
      status: "subscribed",
    });
    // Any version will do, and Shopify's placeholder name is not a version.
    expect((await rows())[0]).toMatchObject({ variantId: "", variantTitle: "" });

    // In stock already: nothing is kept, the shopper is told.
    await db.stockAlert.deleteMany();
    expect(await ask({ productId: "500", email: "ada@example.com" })).toEqual({ ok: true, status: "in_stock" });
    expect(await ask({ productId: "500", variantId: "501", email: "ada@example.com" })).toEqual({
      ok: true,
      status: "in_stock",
    });
    expect(await rows()).toHaveLength(0);
  });

  it("keeps one request per person and product, and starts the wait again when asked again", async () => {
    await ask({ productId: "500", variantId: "502", email: "ada@example.com" });
    await db.stockAlert.updateMany({ data: { notifiedAt: new Date(), attempts: 2 } });

    await ask({ productId: "500", variantId: "502", email: "ADA@example.com" });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ notifiedAt: null, attempts: 0 });

    // Another version, or another person, is another request.
    await ask({ productId: "500", variantId: "503", email: "ada@example.com" });
    await ask({ productId: "500", variantId: "502", email: "grace@example.com" });
    expect(await rows()).toHaveLength(3);
  });

  it("refuses what is not a request, without keeping anything", async () => {
    for (const [body, status, message] of [
      [{ productId: "500", variantId: "502", email: "not-an-email" }, 400, "Enter a valid email address."],
      [{ productId: "500", variantId: "502" }, 400, "Enter a valid email address."],
      [{ productId: "abc", email: "ada@example.com" }, 400, "That alert could not be set up."],
      [{ productId: "500", variantId: "5x", email: "ada@example.com" }, 400, "That alert could not be set up."],
      // A version that is not this product's.
      [{ productId: "500", variantId: "999", email: "ada@example.com" }, 404, "That product could not be found."],
    ] as const) {
      const error = await refused(ask(body));
      expect([error.status, error.message]).toEqual([status, message]);
    }
    expect((await refused(ask({ productId: "500", email: "ada@example.com" }, { store: storefront(null) }))).status).toBe(404);
    expect(
      (await refused(ask({ productId: "500", email: "ada@example.com" }, { store: storefront(new Error("offline")) }))).status,
    ).toBe(502);
    expect(await rows()).toHaveLength(0);
  });

  it("is off until the merchant switches it on, and takes no address it could not write to", async () => {
    expect((await refused(ask({ productId: "500", variantId: "502", email: "ada@example.com" }, { shop: SHOP_B }))).code).toBe(
      "disabled",
    );
    // Switched on, but the app has no email service: asking is refused too.
    expect(
      (await refused(ask({ productId: "500", variantId: "502", email: "ada@example.com" }, { emailReady: false }))).code,
    ).toBe("disabled");
    expect(await rows()).toHaveLength(0);

    const deps = (emailReady: boolean) => ({ db, emailReady: () => emailReady });
    expect(await stockAlertsOffered(SHOP_A, deps(true))).toBe(true);
    expect(await stockAlertsOffered(SHOP_A, deps(false))).toBe(false);
    expect(await stockAlertsOffered(SHOP_B, deps(true))).toBe(false);
    await saveSettings(SHOP_A, { enabled: false }, db);
    expect(await stockAlertsOffered(SHOP_A, deps(true))).toBe(false);
  });

  it("cannot be used to fill someone's inbox or the table", async () => {
    const rateLimiter = new RateLimiter();
    for (let request = 0; request < 10; request += 1) {
      await ask({ productId: "500", variantId: "502", email: `person${request}@example.com` }, { rateLimiter });
    }
    const error = await refused(ask({ productId: "500", variantId: "502", email: "one.more@example.com" }, { rateLimiter }));
    expect([error.code, error.status]).toEqual(["rate_limited", 429]);
    expect(await rows()).toHaveLength(10);
  });
});

describe("telling shoppers a product is back", () => {
  const availability = (available: string[], overrides: Record<string, unknown> = {}) => ({
    product: {
      title: "Ski Wax <Pro>",
      handle: "ski-wax",
      status: "ACTIVE",
      onlineStoreUrl: "https://shop-a.example/products/ski-wax",
      variants: {
        nodes: ["501", "502", "503"].map((id) => ({
          id: `gid://shopify/ProductVariant/${id}`,
          availableForSale: available.includes(id),
        })),
      },
      ...overrides,
    },
    shop: { name: "Alpine & Co", contactEmail: "hello@shop-a.example", primaryDomain: { url: "https://shop-a.example" } },
  });
  const admin = (data: unknown) => {
    let calls = 0;
    const fn = (async () => {
      calls += 1;
      if (data instanceof Error) throw data;
      return data;
    }) as unknown as GraphqlFn & { count: () => number };
    fn.count = () => calls;
    return fn;
  };
  const waiting = (email: string, variantId = "", shop = SHOP_A, productId = "500") =>
    db.stockAlert.create({
      data: { shop, email, productId, variantId, productTitle: "Ski Wax", variantTitle: variantId ? `V${variantId}` : "" },
    });
  const notify = (
    data: unknown,
    options: { sendEmail?: (message: EmailMessage) => Promise<void>; shop?: string; emailReady?: boolean } = {},
  ) => {
    const sent: EmailMessage[] = [];
    const client = admin(data);
    const result = notifyBackInStock(
      { shop: options.shop ?? SHOP_A, productId: "500", admin: client },
      {
        db,
        emailReady: () => options.emailReady ?? true,
        sendEmail:
          options.sendEmail ??
          (async (message) => {
            sent.push(message);
          }),
      },
    );
    return { result, sent, client };
  };

  it("emails each shopper whose version is back, once, and leaves the others waiting", async () => {
    await waiting("special@example.com", "502");
    await waiting("sample@example.com", "503");
    await waiting("any@example.com");
    await waiting("other-shop@example.com", "502", SHOP_B);
    await waiting("other-product@example.com", "", SHOP_A, "777");

    const first = notify(availability(["501", "502"]));
    expect(await first.result).toBe(2);
    expect(first.sent.map((message) => message.to).sort()).toEqual(["any@example.com", "special@example.com"]);

    const special = first.sent.find((message) => message.to === "special@example.com")!;
    expect(special).toMatchObject({
      subject: "Back in stock: Ski Wax <Pro> (V502)",
      // From the store by name, with replies going to the store.
      fromName: "Alpine & Co",
      replyTo: "hello@shop-a.example",
    });
    expect(special.text).toContain("https://shop-a.example/products/ski-wax");
    expect(special.text).toContain("This is the only email you will get about it.");
    // Nothing from the store's data becomes markup in the email.
    expect(special.html).toContain("Ski Wax &#60;Pro&#62; (V502)");
    expect(special.html).toContain("Alpine &#38; Co");
    expect(special.html).not.toContain("<Pro>");

    // Told once: the same change arriving again sends nothing more.
    const again = notify(availability(["501", "502"]));
    expect(await again.result).toBe(0);
    expect(again.sent).toHaveLength(0);

    // The other version comes back later: only its shopper is told.
    const later = notify(availability(["501", "502", "503"]));
    expect(await later.result).toBe(1);
    expect(later.sent.map((message) => message.to)).toEqual(["sample@example.com"]);

    // Another shop's and another product's requests were never touched.
    expect(await db.stockAlert.count({ where: { notifiedAt: null } })).toBe(2);
  });

  it("asks Shopify nothing when nobody is waiting, and sends nothing while it is still sold out or not on sale", async () => {
    const idle = notify(availability(["502"]));
    expect(await idle.result).toBe(0);
    expect(idle.client.count()).toBe(0);
    expect(await hasWaitingAlerts(db, SHOP_A, "500")).toBe(false);

    await waiting("special@example.com", "502");
    expect(await hasWaitingAlerts(db, SHOP_A, "500")).toBe(true);
    expect(await hasWaitingAlerts(db, SHOP_B, "500")).toBe(false);

    expect(await notify(availability([])).result).toBe(0);
    expect(await notify(availability(["501"])).result).toBe(0);
    expect(await notify(availability(["502"], { status: "DRAFT" })).result).toBe(0);
    expect(await notify({ product: null, shop: { name: "x", contactEmail: null, primaryDomain: null } }).result).toBe(0);
    // No email service: nothing is claimed as sent.
    expect(await notify(availability(["502"]), { emailReady: false }).result).toBe(0);
    expect((await rows())[0].notifiedAt).toBeNull();
  });

  it("keeps a shopper waiting when the email could not be sent, and gives up after a few tries", async () => {
    await waiting("special@example.com", "502");
    const failing = async () => {
      throw new Error("mail server down");
    };

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(await notify(availability(["502"]), { sendEmail: failing }).result).toBe(0);
      expect((await rows())[0]).toMatchObject({ notifiedAt: null, attempts: attempt });
    }
    // Four failures: left alone, and no longer counted as waiting to be told.
    const after = notify(availability(["502"]));
    expect(await after.result).toBe(0);
    expect(after.client.count()).toBe(0);
  });

  it("links to the product on the store's own domain when Shopify gives no storefront address", async () => {
    await waiting("any@example.com");
    const { result, sent } = notify(availability(["501"], { onlineStoreUrl: null }));
    expect(await result).toBe(1);
    expect(sent[0].text).toContain("https://shop-a.example/products/ski-wax");
    expect(sent[0].subject).toBe("Back in stock: Ski Wax <Pro>");
  });
});

describe("what is kept, and for how long", () => {
  it("forgets a person on request, sent alerts after a month and stale ones after half a year", async () => {
    const now = new Date("2026-11-25T12:00:00Z");
    const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const alert = (email: string, extra: Record<string, unknown> = {}, shop = SHOP_A) =>
      db.stockAlert.create({
        data: { shop, email, productId: "500", variantId: "", productTitle: "Ski Wax", ...extra },
      });
    await alert("fresh@example.com");
    await alert("told-recently@example.com", { notifiedAt: daysAgo(5) });
    await alert("told-long-ago@example.com", { notifiedAt: daysAgo(31), createdAt: daysAgo(60) });
    await alert("waiting-too-long@example.com", { createdAt: daysAgo(181) });
    await alert("ada@example.com");
    await alert("ada@example.com", {}, SHOP_B);

    expect(await purgeStockAlerts(db, now)).toBe(2);
    expect((await rows()).map((row) => row.email).sort()).toEqual([
      "ada@example.com",
      "ada@example.com",
      "fresh@example.com",
      "told-recently@example.com",
    ]);

    // For the merchant: who is waiting for what, in their own shop.
    expect(await stockAlertSummary(db, SHOP_A, now)).toEqual({
      waiting: 2,
      sent: 1,
      products: [{ title: "Ski Wax", waiting: 2 }],
    });

    // Shopify's request to erase a customer: by their address, in that shop only.
    expect(await deleteStockAlertsForEmail(db, SHOP_A, " ADA@example.com ")).toBe(1);
    expect(await db.stockAlert.count({ where: { email: "ada@example.com" } })).toBe(1);

    // Uninstalled: everything of the shop goes.
    await deleteShopData(db, SHOP_A);
    expect(await db.stockAlert.count({ where: { shop: SHOP_A } })).toBe(0);
    expect(await db.stockAlert.count({ where: { shop: SHOP_B } })).toBe(1);
  });
});

describe("email", () => {
  it("is ready only with a server and a sender address", () => {
    expect(getEmailStatus({})).toEqual({ ready: false, problem: "SMTP_HOST is not set" });
    expect(getEmailStatus({ SMTP_HOST: "smtp.example.com" })).toEqual({
      ready: false,
      problem: "EMAIL_FROM is not set to an email address",
    });
    expect(getEmailStatus({ SMTP_HOST: "smtp.example.com", EMAIL_FROM: "Alerts <alerts@example.com>" }).ready).toBe(false);
    expect(getEmailStatus({ SMTP_HOST: "smtp.example.com", EMAIL_FROM: "alerts@example.com" })).toEqual({
      ready: true,
      problem: null,
    });
  });

  it("says what is back, where to get it, and why the email was sent", () => {
    const email = backInStockEmail({
      shopName: "Alpine Co",
      productTitle: "Ski Wax",
      variantTitle: "",
      url: "https://shop.example/products/ski-wax?a=1&b=2",
    });
    expect(email.subject).toBe("Back in stock: Ski Wax");
    expect(email.text).toContain("Ski Wax is back in stock at Alpine Co.");
    expect(email.text).toContain("You asked Alpine Co to tell you when this was back in stock.");
    expect(email.html).toContain('href="https://shop.example/products/ski-wax?a=1&#38;b=2"');
  });
});
