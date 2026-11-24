/**
 * The "what should the assistant know" form fields, shared by the setup tour
 * and the Settings page so the two can never drift apart. Each group is a set
 * of named, uncontrolled fields meant to sit inside a native <form>.
 */
import type {
  AssistantSettings,
  SettingsErrors,
  SettingsField,
} from "../assistant/settings.server";

interface FieldGroupProps {
  settings: AssistantSettings;
  errors?: SettingsErrors;
}

const errorProp = (message: string | undefined) => (message ? { error: message } : {});

/** Which settings each group edits. The server reads exactly these. */
export const FIELD_GROUPS = {
  abilities: [
    "allowAddToCart",
    "allowCheckout",
    "allowChatOrders",
    "orderLookupEnabled",
    "orderLookupByNumber",
    "allowReturns",
  ],
  quickPolicies: ["returnWindow", "returnShipping", "processingTime", "deliveryTime", "shipsTo"],
  personality: ["assistantName", "greeting", "tone"],
  // Optional free text, shown only on the Settings page.
  business: ["businessDescription"],
  policies: ["returnPolicy", "shippingInfo"],
  questions: ["faq"],
} as const satisfies Record<string, readonly SettingsField[]>;

const checked = (on: boolean) => (on ? { defaultChecked: true } : {});

/** Step 1 of setup: what the assistant may do. All checkboxes, no typing. */
export function AbilityFields({ settings }: FieldGroupProps) {
  return (
    <s-stack direction="block" gap="base">
      <s-checkbox
        label="Answer product questions and recommend products"
        details="Always on. Uses your live catalog, best sellers and published policies."
        defaultChecked
        disabled
      />
      <s-checkbox
        name="allowAddToCart"
        label="Add items to the cart"
        details="Shoppers can say 'add the small one to my cart', and product cards get an Add to cart button."
        {...checked(settings.allowAddToCart)}
      />
      <s-checkbox
        name="allowCheckout"
        label="Help shoppers place an order"
        details="A shopper says what they want to buy. The assistant puts it in their cart and shows an order summary with a Go to checkout button. Delivery details and payment always happen on your normal Shopify checkout. With 'Add items to the cart' off, it only shows the summary of what is already in the cart."
        {...checked(settings.allowCheckout)}
      />
      <s-checkbox
        name="allowChatOrders"
        label="Take pay-on-delivery orders in the chat"
        details="The order summary gets an 'Order here, pay on delivery' button. The shopper fills in a short form (name, phone, delivery address) and the order appears in your Shopify admin as unpaid, tagged shopi-assist. Tick this only if you offer cash on delivery, and check these orders before you ship them. Needs 'Help shoppers place an order'."
        {...checked(settings.allowChatOrders)}
      />
      <s-checkbox
        name="orderLookupEnabled"
        label="Check order status"
        details="The shopper gives their order number and checkout email, and gets payment status, delivery status and tracking."
        {...checked(settings.orderLookupEnabled)}
      />
      <s-checkbox
        name="orderLookupByNumber"
        label="Let shoppers check status with the order number alone"
        details="Without the email, the assistant shares only the basics: order date, payment status and delivery status. Order numbers are easy to guess, so anyone could see those basics for any order. Tracking numbers, tracking links and return requests still need the checkout email. Needs 'Check order status'."
        {...checked(settings.orderLookupByNumber)}
      />
      <s-checkbox
        name="allowReturns"
        label="Take return requests"
        details="The shopper gives their order number, checkout email and a reason. The request appears in your Shopify admin for you to approve or decline. Nothing is refunded automatically."
        {...checked(settings.allowReturns)}
      />
    </s-stack>
  );
}

const NOT_SET = "Not set (use my policy pages)";

/** Step 2 of setup: policies picked from dropdowns. */
export function QuickPolicyFields({ settings, errors = {} }: FieldGroupProps) {
  return (
    <s-stack direction="block" gap="base">
      <s-select
        name="returnWindow"
        label="How long do customers have to return an item?"
        value={settings.returnWindow}
        {...errorProp(errors.returnWindow)}
      >
        <s-option value="">{NOT_SET}</s-option>
        <s-option value="none">We don&apos;t accept returns</s-option>
        <s-option value="7">7 days</s-option>
        <s-option value="14">14 days</s-option>
        <s-option value="30">30 days</s-option>
        <s-option value="60">60 days</s-option>
        <s-option value="90">90 days</s-option>
      </s-select>
      <s-select
        name="returnShipping"
        label="Who pays for return shipping?"
        value={settings.returnShipping}
        {...errorProp(errors.returnShipping)}
      >
        <s-option value="">{NOT_SET}</s-option>
        <s-option value="customer">The customer</s-option>
        <s-option value="free">We do (free returns)</s-option>
      </s-select>
      <s-select
        name="processingTime"
        label="How quickly do orders ship?"
        value={settings.processingTime}
        {...errorProp(errors.processingTime)}
      >
        <s-option value="">{NOT_SET}</s-option>
        <s-option value="same_day">Same business day</s-option>
        <s-option value="1_2">Within 1 to 2 business days</s-option>
        <s-option value="3_5">Within 3 to 5 business days</s-option>
      </s-select>
      <s-select
        name="deliveryTime"
        label="How long does delivery usually take?"
        value={settings.deliveryTime}
        {...errorProp(errors.deliveryTime)}
      >
        <s-option value="">{NOT_SET}</s-option>
        <s-option value="2_4">2 to 4 business days</s-option>
        <s-option value="3_5">3 to 5 business days</s-option>
        <s-option value="5_8">5 to 8 business days</s-option>
        <s-option value="7_14">7 to 14 business days</s-option>
      </s-select>
      <s-select
        name="shipsTo"
        label="Where do you ship?"
        value={settings.shipsTo}
        {...errorProp(errors.shipsTo)}
      >
        <s-option value="">{NOT_SET}</s-option>
        <s-option value="domestic">Within my country only</s-option>
        <s-option value="international">Internationally</s-option>
      </s-select>
    </s-stack>
  );
}


export function BusinessFields({ settings, errors = {} }: FieldGroupProps) {
  return (
    <s-text-area
      name="businessDescription"
      label="What does your business sell, and who is it for?"
      details="A few sentences is enough. Example: 'We make small-batch snowboards for beginners and intermediates. Everything is built in Canada and ships within 2 days.'"
      rows={5}
      maxLength={1500}
      defaultValue={settings.businessDescription}
      {...errorProp(errors.businessDescription)}
    />
  );
}

export function PolicyFields({ settings, errors = {} }: FieldGroupProps) {
  return (
    <s-stack direction="block" gap="base">
      <s-text-area
        name="returnPolicy"
        label="Returns and exchanges"
        details="The short version shoppers need. Example: '30 days to return unused items for a full refund. Return shipping is free on orders over $50. Sale items are final.'"
        rows={4}
        maxLength={1500}
        defaultValue={settings.returnPolicy}
        {...errorProp(errors.returnPolicy)}
      />
      <s-text-area
        name="shippingInfo"
        label="Shipping and delivery"
        details="Where you ship, how long it takes and what it costs. Example: 'We ship to the US and Canada. Orders placed before 2pm ship the same day. Delivery takes 3 to 5 business days. Free over $75.'"
        rows={4}
        maxLength={1500}
        defaultValue={settings.shippingInfo}
        {...errorProp(errors.shippingInfo)}
      />
    </s-stack>
  );
}

export function QuestionFields({ settings, errors = {} }: FieldGroupProps) {
  return (
    <s-text-area
      name="faq"
      label="Other questions shoppers often ask"
      details="Write them as question and answer, one per line. Example: 'Do you offer gift wrapping? Yes, free at checkout.' Sizing, warranties, store hours and how to contact you all work well here."
      rows={7}
      maxLength={3000}
      defaultValue={settings.faq}
      {...errorProp(errors.faq)}
    />
  );
}

export function PersonalityFields({ settings, errors = {} }: FieldGroupProps) {
  return (
    <s-stack direction="block" gap="base">
      <s-text-field
        name="assistantName"
        label="Assistant name"
        details="Shown at the top of the chat window. Leave empty to use 'Shopping assistant'."
        placeholder="For example: Ava"
        maxLength={40}
        autocomplete="off"
        defaultValue={settings.assistantName}
        {...errorProp(errors.assistantName)}
      />
      <s-text-area
        name="greeting"
        label="Welcome message"
        details="The first thing shoppers see when they open the chat. Leave empty for the default greeting."
        placeholder="Hi! Ask me about products, best sellers, shipping or returns."
        rows={2}
        maxLength={300}
        defaultValue={settings.greeting}
        {...errorProp(errors.greeting)}
      />
      <s-select
        name="tone"
        label="Tone of voice"
        value={settings.tone}
        {...errorProp(errors.tone)}
      >
        <s-option value="friendly">Friendly: warm and brief</s-option>
        <s-option value="professional">Professional: polite and precise</s-option>
        <s-option value="playful">Playful: upbeat and light</s-option>
      </s-select>
    </s-stack>
  );
}
