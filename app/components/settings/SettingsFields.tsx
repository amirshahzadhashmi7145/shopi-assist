/**
 * The four parts of Settings: Assistant, Orders, Policies and Knowledge.
 * Shared by the Settings page (all four, one shown at a time) and the setup
 * tour (a few at a time), so the two can never drift apart.
 *
 * Only what a merchant decides is here. What every store has (answering
 * about products, adding to the cart, the way to the checkout) has no switch
 * and no line of its own, and nothing here only reports what was read from
 * Shopify: a line from Shopify stands where a question would otherwise be
 * asked, or beside the picks it bears on.
 *
 * Built so a merchant can set the assistant up without writing anything:
 *  - features are switches, and a feature's own options appear only once it
 *    is on;
 *  - policies and common questions are picked from lists;
 *  - what Shopify already answers is not asked: its answer is shown in the
 *    question's place;
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
  ORDER_FORM_CHOICES,
  ORDER_FORM_LABELS,
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
  type OrderFormField,
  type PolicyField,
  type SectionKey,
} from "../../assistant/setting-options";
import type { AssistantSettings, SettingsErrors } from "../../assistant/settings.server";
import type { ShippingView } from "../../assistant/shipping";
import type { StoreFactsView } from "../../assistant/store-facts";
import {
  ACCENT_PRESETS,
  WIDGET_POSITIONS,
  WIDGET_POSITION_LABELS,
} from "../../assistant/widget-look";
import {
  AddOwnWords,
  Columns,
  Pick,
  Reveal,
  Swatches,
  SyncedLine,
  Toggle,
  errorProp,
} from "./controls";
import { initialDraft } from "./draft";
import type { SettingsDraft } from "./useSettingsDraft";

interface SectionProps {
  /** The saved settings: what every control starts from. */
  settings: AssistantSettings;
  /** What Shopify says about the store. */
  facts: StoreFactsView;
  /** The store's shipping zones and rates, as Shopify had them when the page was opened. */
  shipping: ShippingView;
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

const orderFormOptions = (field: OrderFormField) =>
  (ORDER_FORM_CHOICES[field] as readonly string[]).map(
    (value) => [value, (ORDER_FORM_LABELS[field] as Record<string, string>)[value]] as const,
  );

/** "A", "A and B", "A, B and 3 more". */
function listed(names: string[], show = 3): string {
  if (names.length <= 1) return names.join("");
  if (names.length <= show) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, show).join(", ")} and ${names.length - show} more`;
}

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
        </s-stack>
      </s-section>

      <s-section heading="Appearance">
        <s-stack direction="block" gap="base">
          <Swatches
            name="ui.accentMode"
            label="Chat color"
            value={start.accentMode}
            picked={ui.accentMode}
            options={ACCENT_PRESETS}
            other={{ value: CUSTOM, label: "Custom color" }}
          />
          <Reveal open={ui.accentMode === CUSTOM}>
            <s-color-field
              name="ui.accentText"
              label="Your color"
              defaultValue={start.accentText}
              {...errorProp(errors.accentColor)}
            />
          </Reveal>
          {/* Out of sight, a refused colour is still said. */}
          {errors.accentColor && ui.accentMode !== CUSTOM && (
            <s-text tone="critical">{errors.accentColor}</s-text>
          )}
          <input type="hidden" name="accentColor" value={draft.draft.accentColor} />
          <s-choice-list
            name="widgetPosition"
            label="Position on the page"
            {...errorProp(errors.widgetPosition)}
          >
            {WIDGET_POSITIONS.map((position) => (
              <s-choice
                key={position}
                value={position}
                {...selected(settings.widgetPosition === position)}
              >
                {WIDGET_POSITION_LABELS[position]}
              </s-choice>
            ))}
          </s-choice-list>
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
// Orders
// ---------------------------------------------------------------------------

function OrdersSection({ settings, errors, draft }: SectionProps) {
  const { values, ui } = draft.state;
  // The address form's options stay out of the way until asked for, unless
  // one of them was changed or has something wrong with it.
  const formOptions =
    ui.open.addressForm ||
    Boolean(errors.orderFirstName || errors.orderCompany || errors.orderAddress2);
  const readsOrders =
    values.orderLookupEnabled ||
    values.allowOrderCancel ||
    values.allowAddressChange ||
    values.allowOrderEdit ||
    values.allowReturns;

  return (
    <s-section heading="Order management">
      <s-stack direction="block" gap="base">
        <s-paragraph color="subdued">
          Everything here is for orders that are already placed. New orders always go through
          your checkout page.
        </s-paragraph>
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
          details="Before an order ships, the shopper can correct its delivery address in a short form in the chat (same country only). The order is tagged for you."
          on={settings.allowAddressChange}
        />
        {/* Nothing to set up for most stores, so the options wait behind a button. */}
        <Reveal open={values.allowAddressChange && !formOptions}>
          <s-stack direction="inline">
            <s-button variant="tertiary" icon="settings" onClick={() => draft.open("addressForm")}>
              Address form options
            </s-button>
          </s-stack>
        </Reveal>
        <Reveal open={values.allowAddressChange && formOptions} nested>
          <s-text color="subdued">
            The form already follows each country&apos;s address layout. Change these only if
            you changed the same options in your Shopify checkout settings.
          </s-text>
          <Columns>
            <Pick
              name="orderFirstName"
              label="Full name"
              value={settings.orderFirstName}
              options={orderFormOptions("orderFirstName")}
              error={errors.orderFirstName}
            />
            <Pick
              name="orderCompany"
              label="Company name"
              value={settings.orderCompany}
              options={orderFormOptions("orderCompany")}
              error={errors.orderCompany}
            />
            <Pick
              name="orderAddress2"
              label="Address line 2"
              value={settings.orderAddress2}
              options={orderFormOptions("orderAddress2")}
              error={errors.orderAddress2}
            />
          </Columns>
        </Reveal>
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
      value="Not published in Shopify yet. The assistant answers from what is set below."
      state="missing"
    >
      <s-link href={adminUrl(shop, "settings/legal")} target="_top">
        Add it in Shopify
      </s-link>
    </SyncedLine>
  );
}

/** The store's shipping rates as Shopify has them, or why they could not be read. */
function ShippingRatesLine({ shipping, shop }: { shipping: ShippingView; shop: string }) {
  const settingsLink = (label: string) => (
    <s-link href={adminUrl(shop, "settings/shipping")} target="_top">
      {label}
    </s-link>
  );

  if (shipping.state === "no_access") {
    return (
      <SyncedLine
        label="Shipping rates"
        value="The assistant can quote your real rates once you approve the app's updated permission. Shopify asks for it the next time you open the app from your admin. Until then it uses your pick below."
        state="blocked"
      />
    );
  }
  if (shipping.state === "unreachable") {
    return (
      <SyncedLine
        label="Shipping rates"
        value="Shopify couldn't be reached to read them just now. Your pick below is used meanwhile."
        state="unknown"
      />
    );
  }
  if (shipping.zones.length === 0) {
    // "None" only when everything was read. With more than could be read, or
    // rates that some products or an app keep apart, there are rates: just
    // none that could be read as the rate for every order.
    if (shipping.truncated || shipping.otherProfiles) {
      return (
        <SyncedLine
          label="Shipping rates"
          value="Your shipping settings in Shopify couldn't be read as rates for every order: some products or an app have rates of their own, or there was more than could be read. The assistant tells shoppers the checkout shows the options, and uses your picks below where Shopify gives no answer."
          state="unknown"
        />
      );
    }
    return (
      <SyncedLine
        label="Shipping rates"
        value="No shipping zones or rates are set up in Shopify yet. Until there are, the assistant has none to quote and tells shoppers the checkout shows what is available. Your picks below are its answer only if Shopify can't be read."
        state="missing"
      >
        {settingsLink("Set up shipping in Shopify")}
      </SyncedLine>
    );
  }
  // A store keeps its rates with its markets, or in the zones of its shipping profiles.
  const units = shipping.model === "markets" ? "markets" : "zones";
  return (
    <s-stack direction="block" gap="small">
      <SyncedLine
        label="Shipping rates"
        value={`Read from your ${shipping.model === "markets" ? "markets" : "shipping zones"} in Shopify each time a shopper asks, so the assistant always quotes your current rates.`}
        state="live"
      />
      {shipping.zones.map((zone, index) => (
        <s-box key={index} padding="small" background="subdued" borderRadius="base">
          <s-stack direction="block" gap="small-500">
            <s-text type="strong">{zone.where}</s-text>
            {zone.rates.map((rate, rateIndex) => (
              <s-text key={rateIndex} color="subdued">
                {rate}
              </s-text>
            ))}
          </s-stack>
        </s-box>
      ))}
      {shipping.truncated ? (
        // Shopify has more than were read, so no count would be right.
        <s-text color="subdued">Your store has more {units} in Shopify than are listed here.</s-text>
      ) : (
        shipping.more > 0 && (
          <s-text color="subdued">
            And {shipping.more} more {shipping.more === 1 ? units.slice(0, -1) : units} in Shopify.
          </s-text>
        )
      )}
      {shipping.otherProfiles && (
        <s-text color="subdued">
          Some products have shipping rates of their own. The checkout shows those.
        </s-text>
      )}
      {settingsLink("Change them in Shopify")}
    </s-stack>
  );
}

function PoliciesSection({ settings, facts, shipping, errors, shop, draft }: SectionProps) {
  const { values, ui } = draft.state;
  const noReturns = values.returnWindow === "none";
  const takesAmount = SHIPPING_FEES_WITH_AMOUNT.includes(values.shippingFee);

  // Where the store delivers: its own delivery settings when they could be
  // read. Without them Shopify still lists the countries with a shipping
  // zone, which is right only for a store that keeps its shipping in zones:
  // on one that has moved to markets, that list is left behind.
  const liveRates = shipping.state === "live" && shipping.zones.length > 0;
  const fromZones = !liveRates && shipping.model === "profiles" && facts.shipsTo !== undefined;
  const countries = liveRates ? shipping.countries : fromZones ? facts.countries : [];
  const everywhereElse = liveRates && shipping.restOfWorld;
  const knowsCountries = liveRates || fromZones;
  // More zones than were read: the countries found are some of them, not all.
  const atLeast = liveRates && shipping.truncated ? "at least " : "";
  // Shopify was read, and everything it holds was: what it lists is the whole answer.
  const readInFull = shipping.state === "live" && !shipping.truncated && !shipping.otherProfiles;

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
          {knowsCountries &&
            (countries.length || everywhereElse ? (
              <SyncedLine
                label="Shipping regions"
                value={
                  everywhereElse
                    ? countries.length
                      ? `Delivers to ${atLeast}${countries.length} named ${countries.length === 1 ? "country" : "countries"} (${listed(countries)}) and the rest of the world.`
                      : "Delivers worldwide: one zone covers every country."
                    : countries.length === 1 && !atLeast
                      ? `Delivers to ${countries[0]}.`
                      : `Delivers to ${atLeast}${countries.length} ${countries.length === 1 ? "country" : "countries"}: ${listed(countries)}.`
                }
                state={liveRates ? "live" : "synced"}
              />
            ) : (
              <SyncedLine
                label="Shipping regions"
                value={
                  !liveRates
                    ? "No shipping zones found in Shopify."
                    : readInFull
                      ? "No country has a delivery option set in Shopify yet."
                      : "No country with a delivery option was found, but your shipping settings in Shopify couldn't be read in full."
                }
                state={liveRates && !readInFull ? "unknown" : "missing"}
              >
                <s-link href={adminUrl(shop, "settings/shipping")} target="_top">
                  Set up shipping in Shopify
                </s-link>
              </SyncedLine>
            ))}
          {/* Asked only when Shopify has no list to give: its own says it better. */}
          <Reveal open={countries.length === 0 && !everywhereElse}>
            <Pick
              name="shipsTo"
              label={fromZones ? "Where you ship, until then" : "Shipping regions"}
              details={
                readInFull
                  ? // Shopify was read: it is the pick that has no say, not Shopify.
                    "Shopify lists no country you deliver to yet. This pick is the assistant's answer only if Shopify can't be read."
                  : shipping.state === "live"
                    ? "The countries you deliver to couldn't be read from Shopify in full, so this pick is used where they can't be."
                    : fromZones
                      ? "Used until your shipping zones in Shopify list some countries."
                      : "Shopify couldn't be read for the countries you deliver to, so pick here."
              }
              value={settings.shipsTo}
              options={policyOptions("shipsTo")}
              error={errors.shipsTo}
            />
          </Reveal>
          <ShippingRatesLine shipping={shipping} shop={shop} />
          {shipping.processing && (
            <SyncedLine label="Order processing time" value={shipping.processing} state="live" />
          )}
          <Columns>
            {/* Asked only where the store has not set it in Shopify. */}
            <Reveal open={!shipping.processing}>
              <Pick
                name="processingTime"
                label="Order processing time"
                value={settings.processingTime}
                options={policyOptions("processingTime")}
                error={errors.processingTime}
              />
            </Reveal>
            {/* Asked only where the store's rates in Shopify do not all say it themselves. */}
            <Reveal open={!(liveRates && shipping.deliveryTimes)}>
              <Pick
                name="deliveryTime"
                label="Delivery time"
                {...(liveRates
                  ? { details: "Used for rates that have no delivery time set in Shopify." }
                  : {})}
                value={settings.deliveryTime}
                options={policyOptions("deliveryTime")}
                error={errors.deliveryTime}
              />
            </Reveal>
            {/* Asked only while Shopify's own rates cannot be read. */}
            <Reveal open={!liveRates}>
              <Pick
                name="shippingFee"
                label="Shipping fees"
                value={settings.shippingFee}
                options={policyOptions("shippingFee")}
                error={errors.shippingFee}
              />
            </Reveal>
            <Reveal open={!liveRates && takesAmount}>
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
          {/* Always within reach: a note that has fallen behind must be easy to change or clear. */}
          <AddOwnWords
            open={ui.open.shippingInfo}
            label={
              liveRates ? "Add a note for when Shopify can't be read" : "Add a note in your own words"
            }
            onOpen={() => draft.open("shippingInfo")}
          >
            <s-text-area
              name="shippingInfo"
              label={liveRates ? "Your note on shipping (backup only)" : "Your note on shipping"}
              details={
                liveRates
                  ? "Not used while your shipping settings are read live from Shopify: a typed note can fall behind them. It is the assistant's answer only if Shopify can't be read. Leave empty to remove it. For anything Shopify doesn't hold, such as cut-off times, use custom instructions under Knowledge."
                  : "Added to your picks above. Leave empty to remove it."
              }
              rows={3}
              maxLength={1500}
              defaultValue={settings.shippingInfo}
              {...errorProp(errors.shippingInfo)}
            />
          </AddOwnWords>
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

  return (
    <>
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
