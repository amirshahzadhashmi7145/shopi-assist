// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { SECTIONS, type SectionKey } from "../app/assistant/setting-options";
import type { AssistantSettings, SettingsErrors } from "../app/assistant/settings.server";
import {
  NO_SHIPPING_RATES,
  shippingForPage,
  type ShippingRates,
} from "../app/assistant/shipping";
import { factsForPage, type StoreFacts } from "../app/assistant/store-facts";
import { SectionNav, SettingsFields } from "../app/components/settings/SettingsFields";
import { PreviewWindow, TryAsking } from "../app/components/settings/StorefrontPreview";
import { useSettingsDraft } from "../app/components/settings/useSettingsDraft";

// The settings pages are drawn with Shopify's web components, which a test
// page does not load: each <s-...> is a plain element here. That is enough to
// check what the page decides for itself: what is shown, what is hidden, and
// what would be saved.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The defaults, without the server module that holds them (it opens the database). */
const DEFAULTS: AssistantSettings = {
  enabled: true,
  instructions: "",
  orderLookupEnabled: false,
  orderLookupByNumber: false,
  retentionDays: 30,
  aboutStore: "shopify",
  businessDescription: "",
  returnPolicy: "",
  shippingInfo: "",
  faq: "",
  topics: {},
  assistantName: "Ava",
  greeting: "Hi there! 👋 Welcome! How can I help you today?",
  allowAddToCart: true,
  allowCheckout: true,
  allowReturns: false,
  allowChatOrders: false,
  allowOrderCancel: false,
  allowAddressChange: false,
  allowOrderEdit: false,
  recogniseCustomers: false,
  chatRatings: true,
  orderFirstName: "optional",
  orderCompany: "hidden",
  orderAddress2: "optional",
  orderPaymentName: "",
  orderPaymentNote: "",
  returnWindow: "",
  returnConditions: [],
  returnShipping: "",
  exchanges: "",
  refundMethod: "",
  processingTime: "",
  deliveryTime: "",
  shipsTo: "",
  shippingFee: "",
  shippingAmount: "",
  codAvailable: "",
};

const FACTS: StoreFacts = {
  syncedAt: "2026-11-26T10:00:00.000Z",
  shopName: "Alpine Outfitters",
  description: "Small-batch snowboards, built in Canada.",
  currencyCode: "CAD",
  contactEmail: "hello@alpine.example",
  shipsTo: ["US", "CA"],
  cards: ["VISA"],
  wallets: [],
  policies: { refund: true, shipping: false, privacy: true, terms: false },
  products: 42,
  giftCards: false,
};

/** A store on shipping zones whose rates could not be read: Shopify still lists its countries. */
const ZONES_UNREAD: ShippingRates = { ...NO_SHIPPING_RATES, state: "no_access", model: "profiles" };

/** The store's shipping settings as Shopify returns them: two zones with rates. */
const LIVE_RATES: ShippingRates = {
  state: "live",
  model: "profiles",
  otherProfiles: false,
  truncated: false,
  zones: [
    {
      name: "North America",
      countries: ["CA", "US"],
      restOfWorld: false,
      rates: [
        {
          name: "Standard",
          price: { amount: "10.0", currencyCode: "CAD" },
          conditions: ["orders up to 99.99 CAD"],
        },
        {
          name: "Free shipping",
          price: { amount: "0.0", currencyCode: "CAD" },
          conditions: ["orders of 100.00 CAD or more"],
        },
      ],
    },
    {
      name: "Everywhere else",
      countries: [],
      restOfWorld: true,
      rates: [{ name: "DHL Express", price: null, carrier: "DHL", conditions: [] }],
    },
  ],
};

const ALL = SECTIONS.map((section) => section.key);

/**
 * What a control was given to start from. React keeps an element's props on
 * the element itself, which is where Shopify's components read a starting
 * value (`defaultValue`, `defaultChecked`) from; nothing is written to the
 * markup for those.
 */
function given(element: Element): Record<string, unknown> {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"));
  return key ? (element as unknown as Record<string, Record<string, unknown>>)[key] : {};
}
const TYPED = "s-text-field, s-text-area, s-number-field";

function Page({
  settings,
  facts,
  shipping = NO_SHIPPING_RATES,
  show,
  active,
  errors = {},
}: {
  settings: AssistantSettings;
  facts: StoreFacts;
  /** The shipping rates as read from Shopify. Not readable unless a test says so. */
  shipping?: ShippingRates;
  show: readonly SectionKey[];
  active?: SectionKey;
  errors?: SettingsErrors;
}) {
  const draft = useSettingsDraft(settings);
  return (
    <form onInput={draft.handleInput} onReset={draft.reset}>
      <SettingsFields
        show={show}
        active={active}
        settings={settings}
        facts={factsForPage(facts)}
        shipping={shippingForPage(shipping)}
        errors={errors}
        shop="alpine.myshopify.com"
        draft={draft}
      />
      <output data-dirty={String(draft.dirty)}>{JSON.stringify(draft.draft)}</output>
    </form>
  );
}

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function open(props: Partial<Parameters<typeof Page>[0]> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(<Page settings={DEFAULTS} facts={FACTS} show={ALL} {...props} />),
  );

  const find = (selector: string) => host.querySelector<HTMLElement>(selector);
  const field = (name: string) => {
    const element = find(`[name="${name}"]`);
    if (!element) throw new Error(`no control named ${name}`);
    return element;
  };
  /** Not inside anything that is hidden. */
  const shown = (element: Element) => element.closest("[hidden]") === null;
  /** What a web component does when the merchant uses it: update itself, then report. */
  const report = (element: Element, state: Record<string, unknown>) =>
    act(() => {
      Object.assign(element, state);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });

  return {
    host,
    find,
    field,
    shown,
    isShown: (name: string) => shown(field(name)),
    toggle: (name: string, checked: boolean) => report(field(name), { checked }),
    pick: (name: string, value: string) => report(field(name), { value }),
    choose: (name: string, value: string) => report(field(name), { values: [value] }),
    type: (name: string, value: string) => report(field(name), { value }),
    tick: (name: string, value: string, checked: boolean) =>
      report(host.querySelector(`[name="${name}"][value="${value}"]`)!, { checked, value }),
    press: (label: string) =>
      act(() => {
        const button = [...host.querySelectorAll("s-button")].find(
          (candidate) => candidate.textContent?.trim() === label,
        );
        if (!button) throw new Error(`no button "${label}"`);
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }),
    typedOnShow: () =>
      [...host.querySelectorAll(TYPED)].filter(shown).map((element) => element.getAttribute("name")),
    saved: (name: string) => (field(name) as HTMLInputElement).value,
    draft: () => JSON.parse(find("output")!.textContent!) as AssistantSettings,
    dirty: () => find("output")!.dataset.dirty === "true",
  };
}

describe("Settings without typing", () => {
  it("asks a new store to type nothing: the only text box on show is the assistant's name, already filled in", () => {
    const page = open();
    expect(page.typedOnShow()).toEqual(["assistantName"]);
    expect(given(page.field("assistantName")).defaultValue).toBe("Ava");
    // Features are switches, policies and answers are lists.
    expect(page.host.querySelectorAll("s-switch[name]").length).toBe(12);
    expect(page.host.querySelectorAll("s-select").length).toBeGreaterThan(15);
    expect(page.dirty()).toBe(false);
  });

  it("shows the setup tour's steps as switches and lists only", () => {
    const abilities = open({ show: ["shopping", "orders"] });
    expect(abilities.typedOnShow()).toEqual([]);
    expect(abilities.find('[name="assistantName"]')).toBeNull();
    expect(abilities.find('[name="topics"]')).toBeNull();

    act(() => root?.unmount());
    document.body.replaceChildren();
    const policies = open({ show: ["policies"] });
    expect(policies.typedOnShow()).toEqual([]);
    expect(policies.find('[name="allowAddToCart"]')).toBeNull();
  });

  it("shows one part at a time and keeps the others on the page, so one save covers them all", () => {
    const page = open({ active: "policies" });
    const parts = [...page.host.querySelectorAll<HTMLElement>("[data-section]")];
    expect(parts.map((part) => [part.dataset.section, part.hidden])).toEqual([
      ["assistant", true],
      ["shopping", true],
      ["orders", true],
      ["policies", false],
      ["knowledge", true],
    ]);
    // Out of sight, still in the form.
    expect(page.field("assistantName").closest("form")).not.toBeNull();
    expect(page.field("topics").closest("form")).not.toBeNull();
  });
});

describe("a feature's own options appear only once it is on", () => {
  it("order status brings its two options with it", () => {
    const page = open();
    expect(page.isShown("orderLookupByNumber")).toBe(false);
    expect(page.isShown("recogniseCustomers")).toBe(false);

    page.toggle("orderLookupEnabled", true);
    expect(page.isShown("orderLookupByNumber")).toBe(true);
    expect(page.isShown("recogniseCustomers")).toBe(true);
    expect(page.draft().orderLookupEnabled).toBe(true);
    expect(page.dirty()).toBe(true);

    page.toggle("orderLookupEnabled", false);
    expect(page.isShown("orderLookupByNumber")).toBe(false);
    expect(page.dirty()).toBe(false);
  });

  it("cash on delivery needs checkout help, and shows its order form only when on", () => {
    const page = open();
    expect(page.isShown("allowChatOrders")).toBe(true);
    expect(page.isShown("orderFirstName")).toBe(false);

    page.toggle("allowChatOrders", true);
    expect(page.isShown("orderFirstName")).toBe(true);
    expect(page.isShown("ui.paymentNameMode")).toBe(true);
    // Its text boxes wait for "Custom".
    expect(page.typedOnShow()).toEqual(["assistantName"]);

    // Without checkout help there is nothing to order with: the whole group goes.
    page.toggle("allowCheckout", false);
    expect(page.isShown("allowChatOrders")).toBe(false);
    expect(page.isShown("orderFirstName")).toBe(false);
    // Hidden, not removed: what was picked is still saved with the form.
    expect(page.field("orderFirstName").closest("form")).not.toBeNull();
  });

  it("warns about protected customer data only while something reads orders", () => {
    const page = open();
    const banner = () => page.find('[data-section="orders"] s-banner')!;
    expect(page.shown(banner())).toBe(false);
    page.toggle("allowReturns", true);
    expect(page.shown(banner())).toBe(true);
  });

  it("no returns means nothing more to ask about returns", () => {
    const page = open();
    expect(page.isShown("returnShipping")).toBe(true);
    page.pick("returnWindow", "none");
    for (const name of ["returnShipping", "refundMethod", "returnConditions"]) {
      expect(page.isShown(name)).toBe(false);
    }
    // Exchanges can still be offered.
    expect(page.isShown("exchanges")).toBe(true);
  });

  it("takes an amount only for the shipping picks that have one, in the store's currency", () => {
    const page = open();
    expect(page.isShown("shippingAmount")).toBe(false);

    page.pick("shippingFee", "free_over");
    expect(page.isShown("shippingAmount")).toBe(true);
    expect(page.field("shippingAmount").getAttribute("label")).toBe("Free on orders over");
    expect(page.field("shippingAmount").getAttribute("suffix")).toBe("CAD");

    page.pick("shippingFee", "flat");
    expect(page.field("shippingAmount").getAttribute("label")).toBe("Flat rate");
    page.pick("shippingFee", "calculated");
    expect(page.isShown("shippingAmount")).toBe(false);
  });
});

describe("a text box appears only for Custom, or when asked for", () => {
  it("the welcome message is a preset until the merchant writes their own", () => {
    const page = open();
    expect(page.isShown("ui.greetingText")).toBe(false);
    expect(page.saved("greeting")).toBe(DEFAULTS.greeting);

    page.choose("ui.greetingMode", "1");
    expect(page.saved("greeting")).toBe("Hello! Looking for something, or need help with an order?");
    expect(page.isShown("ui.greetingText")).toBe(false);

    page.choose("ui.greetingMode", "custom");
    expect(page.isShown("ui.greetingText")).toBe(true);
    page.type("ui.greetingText", "Hello from Alpine!");
    expect(page.saved("greeting")).toBe("Hello from Alpine!");
  });

  it("a store that already wrote its own welcome sees it selected and editable", () => {
    const page = open({ settings: { ...DEFAULTS, greeting: "Hey, welcome to Alpine!" } });
    expect(page.isShown("ui.greetingText")).toBe(true);
    expect(given(page.field("ui.greetingText")).defaultValue).toBe("Hey, welcome to Alpine!");
    expect(page.saved("greeting")).toBe("Hey, welcome to Alpine!");
    expect(page.dirty()).toBe(false);
  });

  it("a common question is answered from a list, with Custom for the merchant's own words", () => {
    const page = open();
    expect(page.saved("topics")).toBe("{}");

    page.pick("ui.topic.sizing", "small");
    expect(JSON.parse(page.saved("topics"))).toEqual({ sizing: "small" });
    expect(page.isShown("ui.topicText.sizing")).toBe(false);

    page.pick("ui.topic.hours", "custom");
    expect(page.isShown("ui.topicText.hours")).toBe(true);
    // Custom with nothing written is not an answer yet.
    expect(JSON.parse(page.saved("topics"))).toEqual({ sizing: "small" });
    page.type("ui.topicText.hours", "Weekdays 10 to 4");
    expect(JSON.parse(page.saved("topics"))).toEqual({
      sizing: "small",
      hours: "custom:Weekdays 10 to 4",
    });
  });

  it("the store's contact address is shown only once email is the picked answer", () => {
    const page = open();
    const address = () =>
      [...page.host.querySelectorAll("s-text")].find(
        (element) => element.textContent === "hello@alpine.example",
      )!;
    expect(page.shown(address())).toBe(false);
    page.pick("ui.topic.contact", "email");
    expect(page.shown(address())).toBe(true);
  });

  it("a note in the merchant's own words is offered as a button, and opens by itself where one exists", () => {
    const page = open();
    expect(page.isShown("returnPolicy")).toBe(false);
    expect(page.isShown("faq")).toBe(false);
    page.press("Add your own questions and answers");
    expect(page.isShown("faq")).toBe(true);
    expect(page.isShown("instructions")).toBe(false);

    act(() => root?.unmount());
    document.body.replaceChildren();
    const written = open({ settings: { ...DEFAULTS, returnPolicy: "Waxed boards are exchange only." } });
    expect(written.isShown("returnPolicy")).toBe(true);
    expect(given(written.field("returnPolicy")).defaultValue).toBe("Waxed boards are exchange only.");
    expect(written.isShown("shippingInfo")).toBe(false);
  });

  it("the business is described from Shopify unless the merchant writes their own", () => {
    const page = open();
    expect(page.isShown("businessDescription")).toBe(false);
    expect(page.host.textContent).toContain("Small-batch snowboards, built in Canada.");
    page.choose("aboutStore", "custom");
    expect(page.isShown("businessDescription")).toBe(true);
    page.choose("aboutStore", "none");
    expect(page.isShown("businessDescription")).toBe(false);
  });

  it("tick boxes for return eligibility each add or remove one condition", () => {
    const page = open({ settings: { ...DEFAULTS, returnConditions: ["tags"] } });
    const boxes = [...page.host.querySelectorAll('s-checkbox[name="returnConditions"]')];
    expect(boxes.map((box) => [box.getAttribute("value"), given(box).defaultChecked === true])).toEqual([
      ["unused", false],
      ["packaging", false],
      ["tags", true],
      ["receipt", false],
      ["no_sale", false],
      ["no_custom", false],
    ]);
    page.tick("returnConditions", "unused", true);
    page.tick("returnConditions", "tags", false);
    expect(page.draft().returnConditions).toEqual(["unused"]);
  });
});

describe("what Shopify already knows is shown, not asked", () => {
  it("does not ask where the store ships when Shopify has said", () => {
    const page = open({ shipping: ZONES_UNREAD });
    expect(page.isShown("shipsTo")).toBe(false);
    expect(page.host.textContent).toContain("Delivers to 2 countries: Canada and United States.");
    expect(page.host.textContent).toContain("Synced from Shopify");
  });

  it("does not show Shopify's list of shipping zones for a store that no longer ships by them", () => {
    // On a store that has moved its shipping to markets that list is left
    // behind: it would name countries the store's real settings do not.
    for (const shipping of [
      { ...NO_SHIPPING_RATES, state: "no_access" as const, model: "markets" as const },
      // Not known which the store is on: not trusted either.
      NO_SHIPPING_RATES,
    ]) {
      const page = open({ shipping });
      expect(page.host.textContent).not.toContain("Delivers to");
      expect(page.isShown("shipsTo")).toBe(true);
      expect(page.field("shipsTo").getAttribute("label")).toBe("Shipping regions");
      act(() => root?.unmount());
      document.body.replaceChildren();
    }
  });

  it("asks instead when Shopify could not be reached, and says so", () => {
    const page = open({ facts: { syncedAt: null } });
    expect(page.isShown("shipsTo")).toBe(true);
    expect(page.host.textContent).toContain("Couldn't check");
    expect(page.host.textContent).not.toContain("Synced from Shopify");
  });

  it("asks as well when Shopify lists no shipping countries at all", () => {
    const page = open({ facts: { ...FACTS, shipsTo: [] }, shipping: ZONES_UNREAD });
    expect(page.isShown("shipsTo")).toBe(true);
    expect(page.host.textContent).toContain("No shipping zones found in Shopify.");
    expect(page.field("shipsTo").getAttribute("label")).toBe("Where you ship, until then");
  });

  it("points to Shopify for what the store has not set up there", () => {
    const page = open();
    const links = [...page.host.querySelectorAll("s-link")].filter(page.shown);
    // The shipping policy is not published; the refund policy is.
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://alpine.myshopify.com/admin/settings/legal",
    ]);
    expect(links[0].getAttribute("target")).toBe("_top");
  });

  it("shows the store's real shipping rates, live, and asks nothing about shipping cost or area", () => {
    const page = open({ shipping: LIVE_RATES });
    const text = page.host.textContent ?? "";
    expect(text).toContain("Live from Shopify");
    expect(text).toContain("Canada, United States");
    expect(text).toContain("Standard: 10.00 CAD (orders up to 99.99 CAD)");
    expect(text).toContain("Free shipping: free (orders of 100.00 CAD or more)");
    expect(text).toContain("Rest of the world");
    expect(text).toContain("DHL Express: calculated at checkout by DHL");
    expect(text).toContain("Delivers to 2 named countries (Canada and United States) and the rest of the world.");

    // Shopify has answered, so the merchant's own picks for these are not shown...
    for (const name of ["shippingFee", "shippingAmount", "shipsTo"]) {
      expect(page.isShown(name)).toBe(false);
      // ...but stay in the form, so nothing saved earlier is lost.
      expect(page.field(name).closest("form")).not.toBeNull();
    }
    // What Shopify cannot tell is still picked.
    expect(page.isShown("processingTime")).toBe(true);
    expect(page.isShown("deliveryTime")).toBe(true);
  });

  it("keeps a typed shipping note within reach while the store's settings are read live, and says it is a backup", () => {
    const written = { ...DEFAULTS, shippingInfo: "We ship to Canada and Mexico too." };
    const live = open({ settings: written, shipping: LIVE_RATES });
    // A note that has fallen behind is the assistant's answer if Shopify
    // cannot be read, so it must be there to change or clear.
    expect(live.isShown("shippingInfo")).toBe(true);
    expect(given(live.field("shippingInfo")).defaultValue).toBe("We ship to Canada and Mexico too.");
    expect(live.field("shippingInfo").getAttribute("label")).toBe("Your note on shipping (backup only)");
    expect(live.field("shippingInfo").getAttribute("details")).toContain(
      "Not used while your shipping settings are read live from Shopify",
    );

    act(() => root?.unmount());
    document.body.replaceChildren();
    const fallback = open({ settings: written });
    expect(fallback.isShown("shippingInfo")).toBe(true);
    expect(fallback.field("shippingInfo").getAttribute("label")).toBe("Your note on shipping");

    // With no note written, it is a button, not a text box.
    act(() => root?.unmount());
    document.body.replaceChildren();
    const none = open({ shipping: LIVE_RATES });
    expect(none.isShown("shippingInfo")).toBe(false);
    expect(none.host.textContent).toContain("Add a note for when Shopify can't be read");
    none.press("Add a note for when Shopify can't be read");
    expect(none.isShown("shippingInfo")).toBe(true);
  });

  it("shows a store's markets with what each charges, and asks for a delivery time only where a rate has none", () => {
    const rate = (name: string, amount: string, delivery?: string) => ({
      name,
      price: { amount, currencyCode: "USD" },
      conditions: [],
      ...(delivery ? { delivery } : {}),
    });
    const united = {
      name: "United States",
      countries: ["US"],
      restOfWorld: false,
      rates: [
        { ...rate("Standard", "8.0", "3 to 5 business days"), freeFrom: { amount: "70.0", currencyCode: "USD" } },
        rate("Express", "15.0", "1 to 2 business days"),
      ],
    };
    const canada = { name: "Canada", countries: ["CA"], restOfWorld: false, rates: [rate("International Shipping", "30.0")] };
    const onMarkets = (zones: ShippingRates["zones"]): ShippingRates => ({
      state: "live",
      model: "markets",
      otherProfiles: false,
      truncated: false,
      zones,
    });

    const page = open({ shipping: onMarkets([canada, united]) });
    const text = page.host.textContent ?? "";
    expect(text).toContain("Read from your markets in Shopify each time a shopper asks");
    expect(text).toContain("International Shipping: 30.00 USD");
    expect(text).toContain("Standard: 8.00 USD, free on orders of 70.00 USD or more (3 to 5 business days)");
    expect(text).toContain("Delivers to 2 countries: Canada and United States.");
    // Canada's rate has no delivery time in Shopify, so the pick is still offered, for that.
    expect(page.isShown("deliveryTime")).toBe(true);
    expect(page.field("deliveryTime").getAttribute("details")).toBe(
      "Used for rates that have no delivery time set in Shopify.",
    );

    act(() => root?.unmount());
    document.body.replaceChildren();
    // Every rate says how long it takes: nothing to ask, and the earlier pick is kept.
    const timed = open({ shipping: onMarkets([united]) });
    expect(timed.isShown("deliveryTime")).toBe(false);
    expect(timed.field("deliveryTime").closest("form")).not.toBeNull();
    expect(timed.host.textContent).toContain("Delivers to United States.");

    act(() => root?.unmount());
    document.body.replaceChildren();
    // With markets that were not read, the ones read cannot speak for all: still asked.
    const cut = open({ shipping: { ...onMarkets([united]), truncated: true } });
    expect(cut.isShown("deliveryTime")).toBe(true);
  });

  it("says so when Shopify has more zones than were read, instead of giving a count that is too low", () => {
    const page = open({ shipping: { ...LIVE_RATES, truncated: true } });
    const text = page.host.textContent ?? "";
    expect(text).toContain("Your store has more zones in Shopify than are listed here.");
    expect(text).toContain("Delivers to at least 2 named countries");
  });

  it("shows the store's own processing time in place of the pick, where Shopify has one", () => {
    const page = open({ shipping: { ...LIVE_RATES, processingDays: 1 } });
    expect(page.host.textContent).toContain("Orders are handed to the carrier within 1 business day.");
    expect(page.isShown("processingTime")).toBe(false);
    expect(page.field("processingTime").closest("form")).not.toBeNull();
    // Delivery time is not something Shopify tells apps: still a pick.
    expect(page.isShown("deliveryTime")).toBe(true);
  });

  it("says a permission is waiting for approval, and uses the merchant's pick until it is given", () => {
    const page = open({ shipping: { ...NO_SHIPPING_RATES, state: "no_access" } });
    expect(page.host.textContent).toContain("Needs your approval");
    expect(page.host.textContent).toContain("once you approve the app's updated permission");
    expect(page.isShown("shippingFee")).toBe(true);
    page.pick("shippingFee", "flat");
    expect(page.isShown("shippingAmount")).toBe(true);
  });

  it("asks for a pick when the store has no shipping zones yet", () => {
    const page = open({
      facts: { ...FACTS, shipsTo: [] },
      shipping: { ...NO_SHIPPING_RATES, state: "live" },
    });
    expect(page.host.textContent).toContain("No shipping zones or rates are set up in Shopify yet.");
    expect(page.isShown("shippingFee")).toBe(true);
    expect(page.isShown("shipsTo")).toBe(true);
    // Shopify was read, so the page does not say it could not be: it says what the pick is for.
    expect(page.field("shipsTo").getAttribute("details")).toBe(
      "Shopify lists no country you deliver to yet. This pick is the assistant's answer only if Shopify can't be read.",
    );
    expect(page.host.textContent).toContain("Your picks below are its answer only if Shopify can't be read.");

    act(() => root?.unmount());
    document.body.replaceChildren();
    // The same on a store that keeps its shipping with its markets and has set none up.
    const markets = open({ shipping: { ...NO_SHIPPING_RATES, state: "live", model: "markets" } });
    expect(markets.field("shipsTo").getAttribute("details")).toContain("Shopify lists no country you deliver to yet.");
    expect(markets.host.textContent).not.toContain("couldn't be read for the countries");
  });

  it("takes cash on delivery as offered once the assistant takes those orders itself", () => {
    const page = open();
    expect(page.isShown("codAvailable")).toBe(true);
    page.toggle("allowChatOrders", true);
    expect(page.isShown("codAvailable")).toBe(false);
    expect(page.host.textContent).toContain("Offered. The assistant takes pay-on-delivery orders in the chat");
  });
});

describe("saving and discarding", () => {
  it("goes back to the saved settings when the form is reset", () => {
    const page = open();
    page.toggle("orderLookupEnabled", true);
    page.pick("ui.topic.sizing", "small");
    expect(page.dirty()).toBe(true);

    act(() => page.host.querySelector("form")!.dispatchEvent(new Event("reset", { bubbles: true })));
    expect(page.dirty()).toBe(false);
    expect(page.isShown("orderLookupByNumber")).toBe(false);
    expect(page.saved("topics")).toBe("{}");
  });

  it("shows the server's message on the field it refused, and marks that part", () => {
    const errors: SettingsErrors = { shippingAmount: "Enter an amount like 50 or 4.99." };
    const page = open({ errors });
    expect(page.field("shippingAmount").getAttribute("error")).toBe("Enter an amount like 50 or 4.99.");

    const host = document.createElement("div");
    document.body.appendChild(host);
    const nav = createRoot(host);
    const picked: SectionKey[] = [];
    act(() =>
      nav.render(<SectionNav active="assistant" errors={errors} onChange={(key) => picked.push(key)} />),
    );
    const buttons = [...host.querySelectorAll("s-button")];
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Assistant",
      "Shopping",
      "Orders",
      "Policies",
      "Knowledge",
    ]);
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false",
      "false",
      "false",
      "false",
    ]);
    expect(buttons.map((button) => button.getAttribute("icon"))).toEqual([
      "check",
      null,
      null,
      "alert-circle",
      null,
    ]);
    act(() => buttons[3].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(picked).toEqual(["policies"]);
    act(() => nav.unmount());
  });
});

describe("the storefront preview", () => {
  function preview(props: Partial<Parameters<typeof PreviewWindow>[0]> = {}) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const sent: string[] = [];
    act(() =>
      root!.render(
        <PreviewWindow
          name="Mia"
          greeting="Hello from Alpine!"
          entries={[]}
          pending={false}
          ratings
          blocked={null}
          onSend={(text) => sent.push(text)}
          onReset={() => {}}
          {...props}
        />,
      ),
    );
    return { host, sent };
  }

  it("shows the name and the welcome, and sends what is typed", () => {
    const { host, sent } = preview();
    expect(host.textContent).toContain("Mia");
    expect(host.textContent).toContain("Hello from Alpine!");
    // Nothing to rate before the assistant has answered.
    expect(host.textContent).not.toContain("How is this chat going?");

    const input = host.querySelector<HTMLInputElement>('input[name="message"]')!;
    input.value = "  Do you ship to Canada?  ";
    act(() => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(sent).toEqual(["  Do you ship to Canada?  "]);
    expect(input.value).toBe("");
  });

  it("offers questions to try under the chat, not inside it", () => {
    const { host } = preview();
    // The widget's own suggested questions are a theme setting: none are made up here.
    expect(host.querySelectorAll("[data-preview] button")).toHaveLength(2);

    const tryHost = document.createElement("div");
    document.body.appendChild(tryHost);
    const tryRoot = createRoot(tryHost);
    const asked: string[] = [];
    const render = (disabled: boolean) =>
      act(() =>
        tryRoot.render(
          <TryAsking
            questions={["What are your best sellers?", "Where is my order?"]}
            disabled={disabled}
            onAsk={(question) => asked.push(question)}
          />,
        ),
      );
    render(false);
    const buttons = () => [...tryHost.querySelectorAll("s-button")];
    expect(buttons().map((button) => button.textContent)).toEqual([
      "What are your best sellers?",
      "Where is my order?",
    ]);
    act(() => buttons()[1].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(asked).toEqual(["Where is my order?"]);

    render(true);
    expect(buttons().every((button) => button.hasAttribute("disabled"))).toBe(true);
    act(() => tryRoot.unmount());
  });

  it("shows replies as text, never as markup, with the product cards under them", () => {
    const { host } = preview({
      entries: [
        { id: 1, role: "user", text: "<b>hi</b>" },
        {
          id: 1.5,
          role: "assistant",
          text: "Try the **Trail Mug**. <img src=x onerror=alert(1)>",
          cards: [{ title: "Trail Mug", price: "18.0 USD" }],
        },
      ],
    });
    expect(host.querySelector("b")).toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("<b>hi</b>");
    expect(host.textContent).toContain("Trail Mug18.0 USD");
    expect(host.textContent).toContain("How is this chat going?");
  });

  it("sends nothing while changes are unsaved", () => {
    const { host, sent } = preview({ blocked: "Save your changes to chat with them." });
    const input = host.querySelector<HTMLInputElement>('input[name="message"]')!;
    expect(input.disabled).toBe(true);
    for (const button of host.querySelectorAll<HTMLButtonElement>("button")) {
      if (button.getAttribute("aria-label") !== "Start a new chat") expect(button.disabled).toBe(true);
    }
    act(() => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(sent).toEqual([]);
  });
});
