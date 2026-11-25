/**
 * Everything a merchant picks in Settings instead of typing it: what is
 * stored, what the merchant reads, and what the assistant is told.
 *
 * The settings pages draw their lists from here and the server checks what
 * is saved against the same lists, so a choice can never be offered that the
 * server would refuse, and a new choice is added in one place.
 *
 * Nothing here touches Shopify, the database or an LLM.
 */
import { DEFAULT_GREETING } from "./assistant-defaults";
import type { SettingsField } from "./settings.server";

export const NOT_SET = "Not set";

// ---------------------------------------------------------------------------
// Store policies
// ---------------------------------------------------------------------------

/** Policy picks. The empty string always means "not set". */
export const POLICY_CHOICES = {
  returnWindow: ["", "none", "7", "14", "30", "60", "90"],
  returnShipping: ["", "customer", "free"],
  exchanges: ["", "yes", "no"],
  refundMethod: ["", "original", "credit", "either"],
  processingTime: ["", "same_day", "1_2", "3_5"],
  deliveryTime: ["", "2_4", "3_5", "5_8", "7_14"],
  shipsTo: ["", "domestic", "international"],
  shippingFee: ["", "free", "free_over", "flat", "calculated"],
  codAvailable: ["", "yes", "no"],
} as const;

export type PolicyField = keyof typeof POLICY_CHOICES;

/** What the merchant reads for each pick. Every choice must have a label. */
export const POLICY_LABELS: {
  [Field in PolicyField]: Record<(typeof POLICY_CHOICES)[Field][number], string>;
} = {
  returnWindow: {
    "": NOT_SET,
    none: "No returns",
    "7": "7 days",
    "14": "14 days",
    "30": "30 days",
    "60": "60 days",
    "90": "90 days",
  },
  returnShipping: { "": NOT_SET, customer: "The customer pays", free: "Free returns" },
  exchanges: { "": NOT_SET, yes: "Exchanges offered", no: "No exchanges" },
  refundMethod: {
    "": NOT_SET,
    original: "Original payment method",
    credit: "Store credit",
    either: "Customer chooses",
  },
  processingTime: {
    "": NOT_SET,
    same_day: "Same business day",
    "1_2": "1 to 2 business days",
    "3_5": "3 to 5 business days",
  },
  deliveryTime: {
    "": NOT_SET,
    "2_4": "2 to 4 business days",
    "3_5": "3 to 5 business days",
    "5_8": "5 to 8 business days",
    "7_14": "7 to 14 business days",
  },
  shipsTo: { "": NOT_SET, domestic: "My country only", international: "Internationally" },
  shippingFee: {
    "": NOT_SET,
    free: "Free on every order",
    free_over: "Free over an order amount",
    flat: "Flat rate per order",
    calculated: "Calculated at checkout",
  },
  codAvailable: { "": NOT_SET, yes: "Offered", no: "Not offered" },
};

/** The shipping picks that come with an amount: the threshold, or the rate. */
export const SHIPPING_FEES_WITH_AMOUNT: readonly string[] = ["free_over", "flat"];

/** What an item must be, or must not be, to be returned. Several can apply. */
export const RETURN_CONDITIONS = [
  "unused",
  "packaging",
  "tags",
  "receipt",
  "no_sale",
  "no_custom",
] as const;
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number];

export const RETURN_CONDITION_LABELS: Record<ReturnCondition, string> = {
  unused: "Unused and unworn",
  packaging: "In original packaging",
  tags: "Tags still attached",
  receipt: "Proof of purchase needed",
  no_sale: "Sale items can't be returned",
  no_custom: "Personalised items can't be returned",
};

const RETURN_CONDITION_SAYS: Record<ReturnCondition, string> = {
  unused: "Items must be unused and unworn.",
  packaging: "Items must be in their original packaging.",
  tags: "Tags must still be attached.",
  receipt: "Proof of purchase is needed.",
  no_sale: "Sale items cannot be returned.",
  no_custom: "Personalised or made-to-order items cannot be returned.",
};

/** The picked conditions as one line for the assistant, or nothing. */
export function describeReturnConditions(conditions: readonly ReturnCondition[]): string {
  const picked = RETURN_CONDITIONS.filter((condition) => conditions.includes(condition));
  return picked.length
    ? `Return conditions: ${picked.map((condition) => RETURN_CONDITION_SAYS[condition]).join(" ")}`
    : "";
}

// ---------------------------------------------------------------------------
// Common questions
// ---------------------------------------------------------------------------

/** Marks an answer the merchant wrote, as opposed to one picked from the list. */
export const CUSTOM_PREFIX = "custom:";
export const MAX_CUSTOM_ANSWER = 300;

interface TopicOption {
  value: string;
  /** What the merchant picks. */
  label: string;
  /** What the assistant is told. */
  says: string;
}

interface Topic {
  key: string;
  label: string;
  /** The kind of question it answers, shown to the merchant as a hint. */
  asks: string;
  options: readonly TopicOption[];
}

/**
 * Questions shoppers ask most that a store's catalog and policy pages do not
 * answer. Each has a few ready answers; the merchant picks one, writes their
 * own, or leaves it unset, in which case the assistant says it is not sure.
 */
export const TOPICS = [
  {
    key: "sizing",
    label: "Sizing and fit",
    asks: "What size should I get?",
    options: [
      {
        value: "true",
        label: "True to size",
        says: "Sizing: items fit true to size, so shoppers should order their usual size.",
      },
      {
        value: "small",
        label: "Runs small: size up",
        says: "Sizing: items run small. Suggest ordering one size up.",
      },
      {
        value: "large",
        label: "Runs large: size down",
        says: "Sizing: items run large. Suggest ordering one size down.",
      },
      {
        value: "chart",
        label: "Size chart on each product page",
        says: "Sizing: each product page has a size chart. Point shoppers to it for the right size.",
      },
    ],
  },
  {
    key: "warranty",
    label: "Warranty",
    asks: "Is there a warranty?",
    options: [
      { value: "none", label: "No warranty", says: "Warranty: products are sold without a warranty." },
      { value: "30d", label: "30 days", says: "Warranty: products have a 30-day warranty." },
      { value: "90d", label: "90 days", says: "Warranty: products have a 90-day warranty." },
      { value: "6m", label: "6 months", says: "Warranty: products have a 6-month warranty." },
      { value: "1y", label: "1 year", says: "Warranty: products have a 1-year warranty." },
      { value: "2y", label: "2 years", says: "Warranty: products have a 2-year warranty." },
      { value: "lifetime", label: "Lifetime", says: "Warranty: products have a lifetime warranty." },
      {
        value: "manufacturer",
        label: "Manufacturer's warranty",
        says: "Warranty: products are covered by their manufacturer's warranty, whose length depends on the product.",
      },
    ],
  },
  {
    key: "care",
    label: "Product care",
    asks: "How do I look after it?",
    options: [
      {
        value: "page",
        label: "Care instructions are on each product page",
        says: "Product care: care instructions are on each product's page. Give them only when the product's own details include them.",
      },
      {
        value: "included",
        label: "Care instructions come with the product",
        says: "Product care: care instructions come with the product, on its label or in the box.",
      },
    ],
  },
  {
    key: "compatibility",
    label: "Compatibility",
    asks: "Will this work with what I have?",
    options: [
      {
        value: "page",
        label: "Listed on each product page",
        says: "Compatibility: what a product works with is listed on its own page. Confirm compatibility only when the product's own details say so.",
      },
      {
        value: "ask",
        label: "Ask us before ordering",
        says: "Compatibility: shoppers who are unsure whether a product fits their setup should contact the store before ordering.",
      },
    ],
  },
  {
    key: "discounts",
    label: "Discount codes",
    asks: "Do you have a discount code?",
    options: [
      {
        value: "checkout",
        label: "Codes are entered at checkout",
        says: "Discounts: a shopper who has a discount code enters it at checkout. You cannot give out or invent codes.",
      },
      {
        value: "newsletter",
        label: "Offers go to newsletter subscribers",
        says: "Discounts: offers and codes are sent to newsletter subscribers. You cannot give out or invent codes.",
      },
      {
        value: "none",
        label: "We don't offer discount codes",
        says: "Discounts: the store does not offer discount codes. Sale prices are shown on the products themselves.",
      },
    ],
  },
  {
    key: "hours",
    label: "Support hours",
    asks: "When can I reach a person?",
    options: [
      {
        value: "weekdays_9_5",
        label: "Monday to Friday, 9am to 5pm",
        says: "Support hours: the store's team answers Monday to Friday, 9am to 5pm, store time.",
      },
      {
        value: "weekdays_9_6",
        label: "Monday to Friday, 9am to 6pm",
        says: "Support hours: the store's team answers Monday to Friday, 9am to 6pm, store time.",
      },
      {
        value: "mon_sat_9_6",
        label: "Monday to Saturday, 9am to 6pm",
        says: "Support hours: the store's team answers Monday to Saturday, 9am to 6pm, store time.",
      },
      {
        value: "everyday_9_5",
        label: "Every day, 9am to 5pm",
        says: "Support hours: the store's team answers every day, 9am to 5pm, store time.",
      },
      {
        value: "everyday_9_9",
        label: "Every day, 9am to 9pm",
        says: "Support hours: the store's team answers every day, 9am to 9pm, store time.",
      },
    ],
  },
  {
    key: "contact",
    label: "Contacting the store",
    asks: "How do I contact you?",
    options: [
      {
        value: "email",
        label: "By email, at my store's contact address",
        // The address itself comes from Shopify: see describeTopics.
        says: "Contact: shoppers can email the store.",
      },
      {
        value: "page",
        label: "Through the contact page",
        says: "Contact: shoppers can reach the store through the contact page on its website.",
      },
    ],
  },
] as const satisfies readonly Topic[];

export type TopicKey = (typeof TOPICS)[number]["key"];
/** Per topic: a listed answer's value, or "custom:" followed by the merchant's own words. */
export type TopicAnswers = Partial<Record<TopicKey, string>>;

export const TOPIC_KEYS = TOPICS.map((topic) => topic.key) as TopicKey[];

const isTopicKey = (key: string): key is TopicKey => (TOPIC_KEYS as string[]).includes(key);

/** A stored answer split into what the list shows and what was typed. */
export function readTopicAnswer(stored: string | undefined): { pick: string; text: string } {
  const value = stored ?? "";
  return value.startsWith(CUSTOM_PREFIX)
    ? { pick: "custom", text: value.slice(CUSTOM_PREFIX.length) }
    : { pick: value, text: "" };
}

/**
 * Keeps the answers that are real: a known topic with a listed answer, or the
 * merchant's own words. Anything else is dropped, so a stale or tampered
 * value never reaches the assistant.
 */
export function cleanTopicAnswers(input: unknown): TopicAnswers {
  const answers: TopicAnswers = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return answers;
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!isTopicKey(key) || typeof raw !== "string") continue;
    const topic = TOPICS.find((entry) => entry.key === key)!;
    if (raw.startsWith(CUSTOM_PREFIX)) {
      const text = raw.slice(CUSTOM_PREFIX.length).replace(/\s+/g, " ").trim();
      if (text) answers[key] = CUSTOM_PREFIX + text.slice(0, MAX_CUSTOM_ANSWER);
    } else if (topic.options.some((option) => option.value === raw)) {
      answers[key] = raw;
    }
  }
  return answers;
}

/** The chosen answers as plain lines for the assistant. Unset topics say nothing. */
export function describeTopics(answers: TopicAnswers, contactEmail?: string): string {
  const lines: string[] = [];
  for (const topic of TOPICS) {
    const { pick, text } = readTopicAnswer(answers[topic.key]);
    if (pick === "custom") {
      if (text) lines.push(`${topic.label}: ${text}`);
      continue;
    }
    const option = topic.options.find((entry) => entry.value === pick);
    if (!option) continue;
    lines.push(
      topic.key === "contact" && pick === "email"
        ? contactEmail
          ? `Contact: shoppers can email the store at ${contactEmail}.`
          : "Contact: shoppers can email the store; the address is on the store's website."
        : option.says,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The assistant itself
// ---------------------------------------------------------------------------

/** Ready-made welcome messages. The first is the default. */
export const GREETING_PRESETS: readonly string[] = [
  DEFAULT_GREETING,
  "Hello! Looking for something, or need help with an order?",
  "Welcome! Ask me about products, shipping or returns.",
];

/** Where "About the business" comes from. */
export const ABOUT_STORE_CHOICES = ["shopify", "custom", "none"] as const;
export type AboutStore = (typeof ABOUT_STORE_CHOICES)[number];

/** How long transcripts are kept, to pick from. */
export const RETENTION_CHOICES: readonly number[] = [7, 30, 90, 180, 365];

export const retentionLabel = (days: number) =>
  days === 365 ? "1 year" : days === 1 ? "1 day" : `${days} days`;

// ---------------------------------------------------------------------------
// Pay-on-delivery orders
// ---------------------------------------------------------------------------

/**
 * What the pay-on-delivery order form asks for, as in Shopify's own checkout
 * settings. The first value of each is Shopify's default for a new store.
 */
export const ORDER_FORM_CHOICES = {
  orderFirstName: ["optional", "required"],
  orderCompany: ["hidden", "optional", "required"],
  orderAddress2: ["optional", "hidden", "required"],
} as const;

export type OrderFormField = keyof typeof ORDER_FORM_CHOICES;

export const ORDER_FORM_LABELS: {
  [Field in OrderFormField]: Record<(typeof ORDER_FORM_CHOICES)[Field][number], string>;
} = {
  orderFirstName: {
    optional: "Only require last name",
    required: "Require first and last name",
  },
  orderCompany: { hidden: "Don't include", optional: "Optional", required: "Required" },
  orderAddress2: { optional: "Optional", hidden: "Don't include", required: "Required" },
};

/** What the order form can call paying on delivery. Empty is Shopify's own name. */
export const PAYMENT_NAME_PRESETS: readonly string[] = ["Pay on delivery", "Cash on delivery"];

/** Ready-made notes shown under the payment method. */
export const PAYMENT_NOTE_PRESETS: readonly string[] = [
  "Please have the exact amount ready.",
  "Our courier will contact you before delivery.",
];

// ---------------------------------------------------------------------------
// The five parts of Settings
// ---------------------------------------------------------------------------

export const SECTIONS = [
  { key: "assistant", label: "Assistant" },
  { key: "shopping", label: "Shopping" },
  { key: "orders", label: "Orders" },
  { key: "policies", label: "Policies" },
  { key: "knowledge", label: "Knowledge" },
] as const;

export type SectionKey = (typeof SECTIONS)[number]["key"];

export const isSectionKey = (value: unknown): value is SectionKey =>
  SECTIONS.some((section) => section.key === value);

/**
 * Which settings each part shows, and so which ones a form for that part may
 * change. A page reads exactly these from what is submitted.
 */
export const SECTION_FIELDS = {
  assistant: ["enabled", "assistantName", "greeting", "chatRatings", "retentionDays"],
  shopping: [
    "allowAddToCart",
    "allowCheckout",
    "allowChatOrders",
    "orderFirstName",
    "orderCompany",
    "orderAddress2",
    "orderPaymentName",
    "orderPaymentNote",
  ],
  orders: [
    "orderLookupEnabled",
    "orderLookupByNumber",
    "recogniseCustomers",
    "allowOrderCancel",
    "allowAddressChange",
    "allowOrderEdit",
    "allowReturns",
  ],
  policies: [
    "returnWindow",
    "returnConditions",
    "returnShipping",
    "exchanges",
    "refundMethod",
    "returnPolicy",
    "processingTime",
    "deliveryTime",
    "shipsTo",
    "shippingFee",
    "shippingAmount",
    "shippingInfo",
    "codAvailable",
  ],
  knowledge: ["aboutStore", "businessDescription", "topics", "faq", "instructions"],
} as const satisfies Record<SectionKey, readonly SettingsField[]>;

/** The settings of several parts together, for a form that shows them all. */
export const fieldsOf = (sections: readonly SectionKey[]): SettingsField[] =>
  sections.flatMap((section) => [...SECTION_FIELDS[section]]);

/** The parts that hold a field the server refused, so the merchant is taken to it. */
export function sectionsWithErrors(errors: Partial<Record<SettingsField, string>>): SectionKey[] {
  return SECTIONS.map((section) => section.key).filter((key) =>
    (SECTION_FIELDS[key] as readonly SettingsField[]).some((field) => errors[field]),
  );
}
