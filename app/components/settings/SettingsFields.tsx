/**
 * The five parts of Settings: Assistant, Shopping, Orders, Policies and
 * Knowledge. Shared by the Settings page (all five, one shown at a time) and
 * the setup tour (a few at a time), so the two can never drift apart.
 *
 * Built so a merchant can set the assistant up without writing anything:
 *  - features are switches, and a feature's own options appear only once it
 *    is on;
 *  - policies and common questions are picked from lists;
 *  - what Shopify already knows is read from Shopify and shown as synced;
 *  - a text box appears only where a name is needed, or after the merchant
 *    picks "Custom" or asks to add something in their own words.
 *
 * Everything sits inside the page's own <form>. Parts and options that are
 * out of sight stay on the page, so what they hold is still saved.
 */
import { DEFAULT_ASSISTANT_NAME } from "../../assistant/assistant-defaults";
import {
  GREETING_PRESETS,
  NOT_SET,
  PAYMENT_NAME_PRESETS,
  PAYMENT_NOTE_PRESETS,
  POLICY_CHOICES,
  POLICY_LABELS,
  RETENTION_CHOICES,
  RETURN_CONDITIONS,
  RETURN_CONDITION_LABELS,
  SECTIONS,
  SHIPPING_FEES_WITH_AMOUNT,
  TOPICS,
  retentionLabel,
  sectionsWithErrors,
  type PolicyField,
  type SectionKey,
} from "../../assistant/setting-options";
import type { AssistantSettings, SettingsErrors } from "../../assistant/settings.server";
import { paymentNames, type StoreFacts, type StoreFactsView } from "../../assistant/store-facts";
import {
  AddOwnWords,
  AlwaysOn,
  Columns,
  Pick,
  Reveal,
  SyncedLine,
  Toggle,
  errorProp,
  type SyncState,
} from "./controls";
import { initialDraft } from "./draft";
import type { SettingsDraft } from "./useSettingsDraft";

interface SectionProps {
  /** The saved settings: what every control starts from. */
  settings: AssistantSettings;
  /** What Shopify says about the store. */
  facts: StoreFactsView;
  errors: SettingsErrors;
  /** The shop's domain, for links into the Shopify admin. */
  shop: string;
  draft: SettingsDraft;
}

const CUSTOM = "custom";
const selected = (on: boolean) => (on ? { defaultSelected: true } : {});
const adminUrl = (shop: string, path: string) => `https://${shop}/admin/${path}`;

const policyOptions = (field: PolicyField) =>
  (POLICY_CHOICES[field] as readonly string[]).map(
    (value) => [value, (POLICY_LABELS[field] as Record<string, string>)[value]] as const,
  );

/** "A", "A and B", "A, B and 3 more". */
function listed(names: string[], show = 3): string {
  if (names.length <= 1) return names.join("");
  if (names.length <= show) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, show).join(", ")} and ${names.length - show} more`;
}

const productCount = (facts: StoreFacts) =>
  facts.products === undefined
    ? ""
    : `${facts.products.toLocaleString("en-US")}${facts.productsCapped ? "+" : ""} active ${facts.products === 1 ? "product" : "products"}`;

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------

function AssistantSection({ settings, errors, draft }: SectionProps) {
  const start = initialDraft(settings).ui;
  const { ui } = draft.state;
  const retention = RETENTION_CHOICES.includes(settings.retentionDays)
    ? RETENTION_CHOICES
    : // A period saved before this was a list stays until it is changed.
      [...RETENTION_CHOICES, settings.retentionDays].sort((a, b) => a - b);

  return (
    <>
      <s-section heading="Storefront chat">
        <Toggle
          name="enabled"
          label="Show the chat on my store"
          details="Switch off to pause. The chat bubble is hidden from shoppers until you switch it back on."
          on={settings.enabled}
        />
      </s-section>

      <s-section heading="Name and welcome">
        <s-stack direction="block" gap="base">
          <s-text-field
            name="assistantName"
            label="Assistant name"
            details={`Shown at the top of the chat, and what the assistant calls itself. Leave empty for ${DEFAULT_ASSISTANT_NAME}.`}
            placeholder={DEFAULT_ASSISTANT_NAME}
            maxLength={40}
            autocomplete="off"
            defaultValue={settings.assistantName}
            {...errorProp(errors.assistantName)}
          />
          <s-choice-list
            name="ui.greetingMode"
            label="Welcome message"
            details="The first thing shoppers see when they open the chat."
          >
            {GREETING_PRESETS.map((text, index) => (
              <s-choice key={text} value={String(index)} {...selected(start.greetingMode === String(index))}>
                {text}
              </s-choice>
            ))}
            <s-choice value={CUSTOM} {...selected(start.greetingMode === CUSTOM)}>
              Write my own
            </s-choice>
          </s-choice-list>
          <Reveal open={ui.greetingMode === CUSTOM}>
            <s-text-area
              name="ui.greetingText"
              label="Your welcome message"
              rows={2}
              maxLength={300}
              defaultValue={start.greetingText}
              {...errorProp(errors.greeting)}
            />
          </Reveal>
          <input type="hidden" name="greeting" value={draft.draft.greeting} />
          <s-stack direction="block" gap="small-500">
            <s-text type="strong">Tone of voice</s-text>
            <s-text color="subdued">
              Professional, polite and precise. The same for every store, so there is nothing to
              set.
            </s-text>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Ratings and privacy">
        <s-stack direction="block" gap="base">
          <Toggle
            name="chatRatings"
            label="Chat ratings"
            details="Shoppers rate a chat with a thumbs-up or thumbs-down. You see the ratings under Conversations."
            on={settings.chatRatings}
          />
          <Pick
            name="retentionDays"
            label="Keep chat transcripts for"
            details="Conversations with no activity for this long are deleted automatically."
            value={String(settings.retentionDays)}
            options={retention.map((days) => [String(days), retentionLabel(days)] as const)}
            error={errors.retentionDays}
          />
        </s-stack>
      </s-section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shopping
// ---------------------------------------------------------------------------

function ShoppingSection({ settings, facts, errors, draft }: SectionProps) {
  const start = initialDraft(settings).ui;
  const { values, ui } = draft.state;
  const count = productCount(facts);

  return (
    <s-section heading="Shopping">
      <s-stack direction="block" gap="base">
        <AlwaysOn
          label="Product questions and recommendations"
          details={`Always on. Answers from your Shopify catalog${count ? `: ${count}` : ""}, with prices, stock and images.`}
        />
        <Toggle
          name="allowAddToCart"
          label="Add to cart"
          details="Shoppers can ask to add an item, and product cards get an Add to cart button."
          on={settings.allowAddToCart}
        />
        <Toggle
          name="allowCheckout"
          label="Checkout help"
          details="Shows an order summary with a Go to checkout button. Payment always happens on your Shopify checkout."
          on={settings.allowCheckout}
        />
        <Reveal open={values.allowCheckout}>
          <s-stack direction="block" gap="base">
            <Toggle
              name="allowChatOrders"
              label="Cash on delivery orders in the chat"
              details="Adds an “Order here, pay on delivery” form. Orders arrive in Shopify unpaid, tagged shopi-assist: check them before you ship."
              on={settings.allowChatOrders}
            />
            <Reveal open={values.allowChatOrders} nested>
              <s-text color="subdued">
                Countries, address formats, shipping rates, prices and tax come from your store.
                These few are yours to set, because Shopify doesn&apos;t let apps read them.
              </s-text>
              <Columns>
                <Pick
                  name="orderFirstName"
                  label="Full name"
                  value={settings.orderFirstName}
                  options={[
                    ["optional", "Only require last name"],
                    ["required", "Require first and last name"],
                  ]}
                  error={errors.orderFirstName}
                />
                <Pick
                  name="orderCompany"
                  label="Company name"
                  value={settings.orderCompany}
                  options={[
                    ["hidden", "Don't include"],
                    ["optional", "Optional"],
                    ["required", "Required"],
                  ]}
                  error={errors.orderCompany}
                />
                <Pick
                  name="orderAddress2"
                  label="Address line 2"
                  value={settings.orderAddress2}
                  options={[
                    ["optional", "Optional"],
                    ["hidden", "Don't include"],
                    ["required", "Required"],
                  ]}
                  error={errors.orderAddress2}
                />
                <Pick
                  name="ui.paymentNameMode"
                  label="Payment method name"
                  value={start.paymentNameMode}
                  options={[
                    ["", "Cash on Delivery (COD)"],
                    ...PAYMENT_NAME_PRESETS.map((name, index) => [String(index), name] as const),
                    [CUSTOM, "Custom name"],
                  ]}
                />
              </Columns>
              <Reveal open={ui.paymentNameMode === CUSTOM}>
                <s-text-field
                  name="ui.paymentNameText"
                  label="Your payment method's name"
                  details="As it is named under Settings > Payments > Manual payment methods in Shopify."
                  maxLength={60}
                  defaultValue={start.paymentNameText}
                  {...errorProp(errors.orderPaymentName)}
                />
              </Reveal>
              <Pick
                name="ui.paymentNoteMode"
                label="Note under the payment method"
                value={start.paymentNoteMode}
                options={[
                  ["", "No note"],
                  ...PAYMENT_NOTE_PRESETS.map((note, index) => [String(index), note] as const),
                  [CUSTOM, "Custom note"],
                ]}
              />
              <Reveal open={ui.paymentNoteMode === CUSTOM}>
                <s-text-area
                  name="ui.paymentNoteText"
                  label="Your note"
                  rows={2}
                  maxLength={300}
                  defaultValue={start.paymentNoteText}
                  {...errorProp(errors.orderPaymentNote)}
                />
              </Reveal>
            </Reveal>
            <input type="hidden" name="orderPaymentName" value={draft.draft.orderPaymentName} />
            <input type="hidden" name="orderPaymentNote" value={draft.draft.orderPaymentNote} />
          </s-stack>
        </Reveal>
      </s-stack>
    </s-section>
  );
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

function OrdersSection({ settings, draft }: SectionProps) {
  const { values } = draft.state;
  const readsOrders =
    values.orderLookupEnabled ||
    values.allowOrderCancel ||
    values.allowAddressChange ||
    values.allowOrderEdit ||
    values.allowReturns;

  return (
    <s-section heading="Order management">
      <s-stack direction="block" gap="base">
        <Toggle
          name="orderLookupEnabled"
          label="Order status"
          details="Shoppers get payment, delivery and tracking status with their order number and checkout email or phone."
          on={settings.orderLookupEnabled}
        />
        <Reveal open={values.orderLookupEnabled} nested>
          <Toggle
            name="orderLookupByNumber"
            label="Allow the order number alone"
            details="Shares only the date, payment status and delivery status. Order numbers are easy to guess; tracking still needs proof."
            on={settings.orderLookupByNumber}
          />
          <Toggle
            name="recogniseCustomers"
            label="Recognise signed-in customers"
            details="Shoppers signed in to their account can ask about their own recent orders without an order number."
            on={settings.recogniseCustomers}
          />
        </Reveal>
        <Toggle
          name="allowOrderCancel"
          label="Cancellations"
          details="Before shipping only. Unpaid orders are cancelled and restocked; paid ones are tagged for you to handle. No refund is ever made."
          on={settings.allowOrderCancel}
        />
        <Toggle
          name="allowAddressChange"
          label="Delivery address changes"
          details="Before shipping, within the same country. The shopper fills in a form and the order is tagged for you."
          on={settings.allowAddressChange}
        />
        <Toggle
          name="allowOrderEdit"
          label="Edits to unpaid orders"
          details="Before shipping, while nothing is paid: shoppers add or remove items and change quantities. The order is tagged for you."
          on={settings.allowOrderEdit}
        />
        <Toggle
          name="allowReturns"
          label="Return requests"
          details="Shoppers pick the items and a reason. You approve or decline in Shopify; nothing is refunded automatically."
          on={settings.allowReturns}
        />
        <Reveal open={readsOrders}>
          <s-banner tone="info">
            Each of these needs proof the order is the shopper&apos;s, and reads order details
            that Shopify classes as protected customer data. On a live store, request that
            access for this app in your Shopify Dev Dashboard first.
          </s-banner>
        </Reveal>
      </s-stack>
    </s-section>
  );
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

function PolicyLine({
  name,
  published,
  shop,
}: {
  name: string;
  published: boolean | undefined;
  shop: string;
}) {
  if (published === undefined) {
    return (
      <SyncedLine
        label={name}
        value="Shopify couldn't be reached to check. Your picks below still apply."
        state="unknown"
      />
    );
  }
  if (published) {
    return (
      <SyncedLine
        label={name}
        value="Published in Shopify. The assistant reads it for anything you leave on Not set."
        state="synced"
      />
    );
  }
  return (
    <SyncedLine
      label={name}
      value="Not published in Shopify yet. The assistant answers from your picks below."
      state="missing"
    >
      <s-link href={adminUrl(shop, "settings/legal")} target="_top">
        Add it in Shopify
      </s-link>
    </SyncedLine>
  );
}

function PoliciesSection({ settings, facts, errors, shop, draft }: SectionProps) {
  const { values, ui } = draft.state;
  const noReturns = values.returnWindow === "none";
  const takesAmount = SHIPPING_FEES_WITH_AMOUNT.includes(values.shippingFee);
  const chatOrders = values.allowChatOrders && values.allowCheckout;

  const { countries } = facts;
  const { cards, wallets } = paymentNames(facts);
  const paysWith = [...cards, ...wallets];
  const paymentState: SyncState =
    facts.cards === undefined ? "unknown" : paysWith.length ? "synced" : "none";

  return (
    <>
      <s-section heading="Returns">
        <s-stack direction="block" gap="base">
          <PolicyLine name="Refund policy" published={facts.policies?.refund} shop={shop} />
          <Columns>
            <Pick
              name="returnWindow"
              label="Return window"
              value={settings.returnWindow}
              options={policyOptions("returnWindow")}
              error={errors.returnWindow}
            />
            <Pick
              name="exchanges"
              label="Exchanges"
              value={settings.exchanges}
              options={policyOptions("exchanges")}
              error={errors.exchanges}
            />
          </Columns>
          <Reveal open={!noReturns}>
            <s-stack direction="block" gap="base">
              <Columns>
                <Pick
                  name="returnShipping"
                  label="Return shipping"
                  value={settings.returnShipping}
                  options={policyOptions("returnShipping")}
                  error={errors.returnShipping}
                />
                <Pick
                  name="refundMethod"
                  label="Refund method"
                  value={settings.refundMethod}
                  options={policyOptions("refundMethod")}
                  error={errors.refundMethod}
                />
              </Columns>
              <s-stack direction="block" gap="small">
                <s-text>Return eligibility</s-text>
                <Columns tight>
                  {RETURN_CONDITIONS.map((condition) => (
                    <s-checkbox
                      key={condition}
                      name="returnConditions"
                      value={condition}
                      label={RETURN_CONDITION_LABELS[condition]}
                      {...(settings.returnConditions.includes(condition)
                        ? { defaultChecked: true }
                        : {})}
                    />
                  ))}
                </Columns>
                {errors.returnConditions && (
                  <s-text tone="critical">{errors.returnConditions}</s-text>
                )}
              </s-stack>
            </s-stack>
          </Reveal>
          <AddOwnWords
            open={ui.open.returnPolicy}
            label="Add a note in your own words"
            onOpen={() => draft.open("returnPolicy")}
          >
            <s-text-area
              name="returnPolicy"
              label="Your note on returns"
              details="Added to your picks above. Leave empty to remove it."
              rows={3}
              maxLength={1500}
              defaultValue={settings.returnPolicy}
              {...errorProp(errors.returnPolicy)}
            />
          </AddOwnWords>
        </s-stack>
      </s-section>

      <s-section heading="Shipping">
        <s-stack direction="block" gap="base">
          <PolicyLine name="Shipping policy" published={facts.policies?.shipping} shop={shop} />
          {facts.shipsTo !== undefined &&
            (countries.length ? (
              <SyncedLine
                label="Shipping regions"
                value={
                  countries.length === 1
                    ? `Delivers to ${countries[0]}.`
                    : `Delivers to ${countries.length} countries: ${listed(countries)}.`
                }
                state="synced"
              />
            ) : (
              <SyncedLine
                label="Shipping regions"
                value="No shipping zones found in Shopify."
                state="missing"
              >
                <s-link href={adminUrl(shop, "settings/shipping")} target="_top">
                  Set up shipping in Shopify
                </s-link>
              </SyncedLine>
            ))}
          {/* Asked only when Shopify could not be: its own list says it better. */}
          <Reveal open={facts.shipsTo === undefined}>
            <Pick
              name="shipsTo"
              label="Shipping regions"
              details="Shopify couldn't be asked which countries you deliver to, so pick here."
              value={settings.shipsTo}
              options={policyOptions("shipsTo")}
              error={errors.shipsTo}
            />
          </Reveal>
          <Columns>
            <Pick
              name="processingTime"
              label="Order processing time"
              value={settings.processingTime}
              options={policyOptions("processingTime")}
              error={errors.processingTime}
            />
            <Pick
              name="deliveryTime"
              label="Delivery time"
              value={settings.deliveryTime}
              options={policyOptions("deliveryTime")}
              error={errors.deliveryTime}
            />
            <Pick
              name="shippingFee"
              label="Shipping fees"
              value={settings.shippingFee}
              options={policyOptions("shippingFee")}
              error={errors.shippingFee}
            />
            <Reveal open={takesAmount}>
              <s-number-field
                name="shippingAmount"
                label={values.shippingFee === "flat" ? "Flat rate" : "Free on orders over"}
                min={0}
                step={0.01}
                {...(facts.currencyCode ? { suffix: facts.currencyCode } : {})}
                defaultValue={settings.shippingAmount}
                {...errorProp(errors.shippingAmount)}
              />
            </Reveal>
          </Columns>
          <AddOwnWords
            open={ui.open.shippingInfo}
            label="Add a note in your own words"
            onOpen={() => draft.open("shippingInfo")}
          >
            <s-text-area
              name="shippingInfo"
              label="Your note on shipping"
              details="Added to your picks above. Leave empty to remove it."
              rows={3}
              maxLength={1500}
              defaultValue={settings.shippingInfo}
              {...errorProp(errors.shippingInfo)}
            />
          </AddOwnWords>
        </s-stack>
      </s-section>

      <s-section heading="Payment">
        <s-stack direction="block" gap="base">
          <SyncedLine
            label="Online payments"
            value={
              paymentState === "unknown"
                ? "Shopify couldn't be reached to check."
                : paysWith.length
                  ? `Your checkout takes ${listed(paysWith, 4)}.`
                  : "Shopify reports no card brands or wallets for your checkout. A store on a test payment provider shows none."
            }
            state={paymentState}
          />
          <Reveal open={!chatOrders}>
            <Pick
              name="codAvailable"
              label="Cash on delivery"
              details="Whether shoppers can choose to pay when the order arrives."
              value={settings.codAvailable}
              options={policyOptions("codAvailable")}
              error={errors.codAvailable}
            />
          </Reveal>
          <Reveal open={chatOrders}>
            <s-stack direction="block" gap="small-500">
              <s-text type="strong">Cash on delivery</s-text>
              <s-text color="subdued">
                Offered. The assistant takes pay-on-delivery orders in the chat, as switched on
                under Shopping.
              </s-text>
            </s-stack>
          </Reveal>
        </s-stack>
      </s-section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

function KnowledgeSection({ settings, facts, errors, shop, draft }: SectionProps) {
  const start = initialDraft(settings).ui;
  const { values, ui } = draft.state;
  const count = productCount(facts);
  const published = [
    facts.policies?.refund ? "refund" : "",
    facts.policies?.shipping ? "shipping" : "",
    facts.policies?.privacy ? "privacy" : "",
    facts.policies?.terms ? "terms of service" : "",
  ].filter(Boolean);

  return (
    <>
      <s-section heading="What the assistant already knows">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Read from your store and kept up to date, so there is nothing to type.
          </s-paragraph>
          <SyncedLine
            label="Products"
            value={`Titles, descriptions, variants, prices, stock and images${count ? `: ${count}` : ""}.`}
            state={facts.products === undefined ? "unknown" : "synced"}
          />
          <SyncedLine
            label="Store policies"
            value={
              facts.policies === undefined
                ? "Shopify couldn't be reached to check."
                : published.length
                  ? `Published: ${listed(published, 4)}.`
                  : "None published in Shopify yet."
            }
            state={
              facts.policies === undefined ? "unknown" : published.length ? "synced" : "missing"
            }
          >
            {facts.policies !== undefined && published.length === 0 && (
              <s-link href={adminUrl(shop, "settings/legal")} target="_top">
                Add policies in Shopify
              </s-link>
            )}
          </SyncedLine>
          {facts.giftCards !== undefined && (
            <SyncedLine
              label="Gift cards"
              value={
                facts.giftCards
                  ? "Sold in your store. The assistant finds them like any other product."
                  : "None in your catalog, so the assistant says you don't sell them."
              }
              state={facts.giftCards ? "synced" : "none"}
            />
          )}
        </s-stack>
      </s-section>

      <s-section heading="About your store">
        <s-stack direction="block" gap="base">
          <s-choice-list
            name="aboutStore"
            label="What the assistant is told your business is"
            {...errorProp(errors.aboutStore)}
          >
            <s-choice value="shopify" {...selected(settings.aboutStore === "shopify")}>
              Use my store description from Shopify
            </s-choice>
            <s-choice value="custom" {...selected(settings.aboutStore === "custom")}>
              Write my own
            </s-choice>
            <s-choice value="none" {...selected(settings.aboutStore === "none")}>
              Nothing: the catalog says enough
            </s-choice>
          </s-choice-list>
          <Reveal open={values.aboutStore === "shopify"}>
            {facts.description ? (
              <SyncedLine label="Store description" value={facts.description} state="synced" />
            ) : (
              <SyncedLine
                label="Store description"
                value={
                  facts.syncedAt
                    ? "Your store has no description in Shopify, so the assistant goes by your catalog."
                    : "Shopify couldn't be reached to check."
                }
                state={facts.syncedAt ? "missing" : "unknown"}
              >
                {facts.syncedAt && (
                  <s-link href={adminUrl(shop, "online_store/preferences")} target="_top">
                    Add one in Shopify
                  </s-link>
                )}
              </SyncedLine>
            )}
          </Reveal>
          <Reveal open={values.aboutStore === "custom"}>
            <s-text-area
              name="businessDescription"
              label="Your description"
              details="A few sentences: what you sell and who it is for."
              rows={4}
              maxLength={1500}
              defaultValue={settings.businessDescription}
              {...errorProp(errors.businessDescription)}
            />
          </Reveal>
        </s-stack>
      </s-section>

      <s-section heading="Common questions">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Pick an answer and the assistant uses it. Left on Not set, it says it isn&apos;t sure
            and points the shopper to your store.
          </s-paragraph>
          {errors.topics && <s-banner tone="critical">{errors.topics}</s-banner>}
          <Columns>
            {TOPICS.map((topic) => (
              <s-stack key={topic.key} direction="block" gap="small">
                <Pick
                  name={`ui.topic.${topic.key}`}
                  label={topic.label}
                  details={`“${topic.asks}”`}
                  value={start.topicPick[topic.key] ?? ""}
                  options={[
                    ["", NOT_SET],
                    ...topic.options.map((option) => [option.value, option.label] as const),
                    [CUSTOM, "Custom answer"],
                  ]}
                />
                <Reveal open={ui.topicPick[topic.key] === CUSTOM}>
                  <s-text-field
                    name={`ui.topicText.${topic.key}`}
                    label={`Your answer: ${topic.label.toLowerCase()}`}
                    labelAccessibilityVisibility="exclusive"
                    placeholder="Your answer"
                    maxLength={300}
                    defaultValue={start.topicText[topic.key] ?? ""}
                  />
                </Reveal>
                {topic.key === "contact" && (
                  <Reveal open={ui.topicPick.contact === "email"}>
                    <SyncedLine
                      label="Contact email"
                      value={
                        facts.contactEmail ??
                        "Not found in Shopify. The assistant points shoppers to your store's website instead."
                      }
                      state={facts.contactEmail ? "synced" : facts.syncedAt ? "missing" : "unknown"}
                    />
                  </Reveal>
                )}
              </s-stack>
            ))}
          </Columns>
          <input type="hidden" name="topics" value={JSON.stringify(draft.draft.topics)} />
        </s-stack>
      </s-section>

      <s-section heading="Anything else">
        <s-stack direction="block" gap="base">
          <AddOwnWords
            open={ui.open.faq}
            label="Add your own questions and answers"
            onOpen={() => draft.open("faq")}
          >
            <s-text-area
              name="faq"
              label="Other questions shoppers often ask"
              details="One per line, question then answer. Leave empty to remove them."
              rows={5}
              maxLength={3000}
              defaultValue={settings.faq}
              {...errorProp(errors.faq)}
            />
          </AddOwnWords>
          <AddOwnWords
            open={ui.open.instructions}
            label="Add custom instructions"
            onOpen={() => draft.open("instructions")}
          >
            <s-text-area
              name="instructions"
              label="Anything else the assistant should know or do"
              details="Treat this as public: a determined shopper can get the assistant to repeat it, so include nothing confidential."
              rows={4}
              maxLength={2000}
              defaultValue={settings.instructions}
              {...errorProp(errors.instructions)}
            />
          </AddOwnWords>
        </s-stack>
      </s-section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Together
// ---------------------------------------------------------------------------

const SECTION_VIEWS: Record<SectionKey, (props: SectionProps) => JSX.Element> = {
  assistant: AssistantSection,
  shopping: ShoppingSection,
  orders: OrdersSection,
  policies: PoliciesSection,
  knowledge: KnowledgeSection,
};

/**
 * The parts named in `show`, top to bottom. With `active`, only that one is
 * visible, as in tabs; the rest stay on the page so their picks are saved
 * with it.
 */
export function SettingsFields({
  show,
  active,
  ...props
}: SectionProps & { show: readonly SectionKey[]; active?: SectionKey }) {
  return (
    <s-stack direction="block" gap="base">
      {show.map((key) => {
        const View = SECTION_VIEWS[key];
        return (
          <div key={key} data-section={key} hidden={active !== undefined && active !== key}>
            <s-stack direction="block" gap="base">
              <View {...props} />
            </s-stack>
          </div>
        );
      })}
    </s-stack>
  );
}

/** Moves between the five parts. The parts with something to fix are marked. */
export function SectionNav({
  active,
  errors,
  onChange,
}: {
  active: SectionKey;
  errors: SettingsErrors;
  onChange: (section: SectionKey) => void;
}) {
  const wrong = sectionsWithErrors(errors);
  return (
    <s-button-group gap="none" accessibilityLabel="Settings sections">
      {SECTIONS.map((section) => {
        const current = section.key === active;
        return (
          <s-button
            key={section.key}
            slot="secondary-actions"
            variant="secondary"
            {...(wrong.includes(section.key)
              ? { icon: "alert-circle" as const, tone: "critical" as const }
              : current
                ? { icon: "check" as const }
                : {})}
            aria-pressed={current}
            onClick={() => onChange(section.key)}
          >
            {section.label}
          </s-button>
        );
      })}
    </s-button-group>
  );
}
