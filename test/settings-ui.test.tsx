// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { SECTIONS, type SectionKey } from "../app/assistant/setting-options";
import type { AssistantSettings, SettingsErrors } from "../app/assistant/settings.server";
import { factsForPage, type StoreFacts } from "../app/assistant/store-facts";
import { SectionNav, SettingsFields } from "../app/components/settings/SettingsFields";
import { PreviewWindow } from "../app/components/settings/StorefrontPreview";
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
  show,
  active,
  errors = {},
}: {
  settings: AssistantSettings;
  facts: StoreFacts;
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
    const page = open();
    expect(page.isShown("shipsTo")).toBe(false);
    expect(page.host.textContent).toContain("Delivers to 2 countries: Canada and United States.");
    expect(page.host.textContent).toContain("Synced from Shopify");
  });

  it("asks instead when Shopify could not be reached, and says so", () => {
    const page = open({ facts: { syncedAt: null } });
    expect(page.isShown("shipsTo")).toBe(true);
    expect(page.host.textContent).toContain("Couldn't check");
    expect(page.host.textContent).not.toContain("Synced from Shopify");
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
          suggestions={["What are your best sellers?", "Where is my order?"]}
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

  it("shows the name, the welcome and the questions the settings allow", () => {
    const { host, sent } = preview();
    expect(host.textContent).toContain("Mia");
    expect(host.textContent).toContain("Hello from Alpine!");
    const chips = [...host.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
      button.textContent?.includes("?"),
    );
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "What are your best sellers?",
      "Where is my order?",
    ]);
    act(() => chips[1].click());
    expect(sent).toEqual(["Where is my order?"]);
    // Nothing to rate before the assistant has answered.
    expect(host.textContent).not.toContain("How is this chat going?");
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
