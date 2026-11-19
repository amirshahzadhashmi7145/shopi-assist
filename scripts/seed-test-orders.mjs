/**
 * Creates a few dummy orders on a development store, so the assistant's order
 * features have something to work with: order status, return requests and the
 * merchant assistant's "recent orders".
 *
 *   npm run seed:test-orders                  two orders on the installed dev store
 *   npm run seed:test-orders -- --count 3
 *   npm run seed:test-orders -- --shop my-dev-store.myshopify.com
 *
 * The orders are unpaid, pay-on-delivery orders, made the same way the chat's
 * order form makes them, for made-up customers at example.com addresses. They
 * are tagged `shopi-assist-test`, so they are easy to find and cancel in the
 * Shopify admin.
 *
 * It refuses to run on anything but a Partner development store, and it uses
 * the app's stored access for that store; nothing is read from the terminal.
 */
import { PrismaClient } from "@prisma/client";

const API_VERSION = "2026-10";
const TEST_TAG = "shopi-assist-test";

/** Made-up people. The phone numbers are from a range reserved for fiction. */
const CUSTOMERS = [
  {
    firstName: "Test",
    lastName: "Buyer",
    email: "test.buyer@example.com",
    phone: "+12025550143",
    address1: "742 Evergreen Terrace",
    city: "Springfield",
    provinceCode: "IL",
    zip: "62704",
  },
  {
    firstName: "Sam",
    lastName: "Sample",
    email: "sam.sample@example.com",
    phone: "+12025550178",
    address1: "350 Fifth Avenue",
    city: "New York",
    provinceCode: "NY",
    zip: "10118",
  },
  {
    firstName: "Dana",
    lastName: "Demo",
    email: "dana.demo@example.com",
    phone: "+12025550112",
    address1: "1600 Amphitheatre Parkway",
    city: "Mountain View",
    provinceCode: "CA",
    zip: "94043",
  },
];

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const fail = (message) => {
  console.error(`\n${message}`);
  process.exit(1);
};

const db = new PrismaClient();
const wanted = option("shop");
const sessions = await db.session.findMany({
  where: { isOnline: false, ...(wanted ? { shop: wanted } : {}) },
});
await db.$disconnect();

if (!sessions.length) {
  fail(
    wanted
      ? `The app is not installed on ${wanted} in this database.`
      : "The app is not installed on any store yet. Run `npm run dev` and install it first.",
  );
}
if (sessions.length > 1) {
  fail(`Several stores are installed. Pick one with --shop:\n  ${sessions.map((s) => s.shop).join("\n  ")}`);
}
const { shop, accessToken } = sessions[0];
const count = Math.max(1, Math.min(CUSTOMERS.length, Number(option("count")) || 2));

async function admin(query, variables) {
  const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.errors) {
    const reason = body?.errors?.[0]?.message ?? `HTTP ${response.status}`;
    fail(
      `Shopify refused a request: ${reason}` +
        (/not approved to access/i.test(reason)
          ? "\nGive the app protected customer data access first: Dev Dashboard > your app > Settings > Access requests."
          : ""),
    );
  }
  return body.data;
}

const store = await admin(`{ shop { name plan { partnerDevelopment } } }`);
if (!store.shop.plan.partnerDevelopment) {
  fail(`${shop} is not a development store. Dummy orders are only ever created on development stores.`);
}
console.log(`Creating ${count} dummy order(s) on ${store.shop.name} (${shop})\n`);

const catalog = await admin(`{
  products(first: 25, query: "status:active") {
    nodes { title variants(first: 5) { nodes { id availableForSale } } }
  }
}`);
const variants = catalog.products.nodes
  .map((product) => ({
    title: product.title,
    id: product.variants.nodes.find((variant) => variant.availableForSale)?.id,
  }))
  .filter((entry) => entry.id);
if (!variants.length) fail("No active product is in stock, so there is nothing to order.");

const terms = await admin(`{ paymentTermsTemplates(paymentTermsType: FULFILLMENT) { id } }`);
const termsId = terms.paymentTermsTemplates[0]?.id;
if (!termsId) fail("This store has no 'due on fulfillment' payment terms.");

const created = [];
for (let index = 0; index < count; index += 1) {
  const customer = CUSTOMERS[index];
  const item = variants[index % variants.length];
  const { email, ...address } = customer;
  const input = {
    lineItems: [{ variantId: item.id, quantity: 1 }],
    shippingAddress: { ...address, countryCode: "US" },
    email,
  };

  const priced = await admin(
    `mutation($input: DraftOrderInput!) {
      draftOrderCalculate(input: $input) {
        calculatedDraftOrder { availableShippingRates { handle title price { amount } } }
        userErrors { message }
      }
    }`,
    { input },
  );
  const rates = priced.draftOrderCalculate.calculatedDraftOrder?.availableShippingRates ?? [];
  if (!rates.length) {
    fail(
      "This store has no delivery rate for a United States address. Add a US shipping zone in Settings > Shipping and delivery, then run this again.",
    );
  }
  const rate = rates.reduce((best, next) => (Number(next.price.amount) < Number(best.price.amount) ? next : best));

  const draft = await admin(
    `mutation($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) { draftOrder { id } userErrors { message } }
    }`,
    {
      input: {
        ...input,
        shippingLine: { shippingRateHandle: rate.handle },
        // Payment terms are what make the order unpaid instead of paid.
        paymentTerms: { paymentTermsTemplateId: termsId },
        note: "Dummy order for testing Shopi Assist. Not a real order.",
        tags: ["shopi-assist", "pay-on-delivery", TEST_TAG],
      },
    },
  );
  const draftId = draft.draftOrderCreate.draftOrder?.id;
  if (!draftId) fail(`Could not create the order: ${draft.draftOrderCreate.userErrors[0]?.message}`);

  const completed = await admin(
    `mutation($id: ID!) {
      draftOrderComplete(id: $id) {
        draftOrder { order { name displayFinancialStatus displayFulfillmentStatus } }
        userErrors { message }
      }
    }`,
    { id: draftId },
  );
  const order = completed.draftOrderComplete.draftOrder?.order;
  if (!order) {
    await admin(`mutation($input: DraftOrderDeleteInput!) { draftOrderDelete(input: $input) { deletedId } }`, {
      input: { id: draftId },
    });
    fail(`Could not complete the order: ${completed.draftOrderComplete.userErrors[0]?.message}`);
  }
  created.push({ ...order, email, item: item.title });
  console.log(
    `  ${order.name}  ${email}  ${item.title}  payment: ${order.displayFinancialStatus}  delivery: ${order.displayFulfillmentStatus}`,
  );
}

console.log(`
Try them in the chat:
  "Where is my order ${created[0].name}? My email is ${created[0].email}"

To test a return request, first mark an order as fulfilled in the Shopify admin.
To clean up, filter orders by the tag "${TEST_TAG}" in the Shopify admin and cancel or delete them.`);
