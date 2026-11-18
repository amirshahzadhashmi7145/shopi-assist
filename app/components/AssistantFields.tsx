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

/** Which settings each group edits. The server reads exactly these. */
export const FIELD_GROUPS = {
  business: ["businessDescription"],
  policies: ["returnPolicy", "shippingInfo"],
  questions: ["faq"],
  personality: ["assistantName", "greeting", "tone"],
} as const satisfies Record<string, readonly SettingsField[]>;

const errorProp = (message: string | undefined) => (message ? { error: message } : {});

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
