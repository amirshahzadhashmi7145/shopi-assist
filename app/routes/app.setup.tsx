/**
 * The setup tour. Opens automatically the first time the app is opened after
 * install and walks the merchant from "just installed" to "shoppers can chat
 * with an assistant that knows my store" in three steps:
 *
 *   1. switch on what the assistant may do,
 *   2. pick the store's policies from lists,
 *   3. turn the widget on and try it.
 *
 * Nothing is typed, every step is optional and each saves on its own: the
 * assistant already works from the catalog and published policies, so nothing
 * here blocks going live. The steps show the same parts as Settings.
 */
import type { FormEvent } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
  ShouldRevalidateFunction,
} from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { getLlmStatus } from "../assistant/llm/index.server";
import { fieldsOf, type SectionKey } from "../assistant/setting-options";
import {
  getSettings,
  getSetupState,
  markSetupCompleted,
  markSetupStarted,
  saveSettings,
  settingsFromForm,
  setupProgress,
  type AssistantSettings,
  type SettingsErrors,
} from "../assistant/settings.server";
import { shippingForPage, type ShippingView } from "../assistant/shipping";
import { loadShippingRates } from "../assistant/shipping.server";
import { toGraphqlFn } from "../assistant/shopify-clients.server";
import { factsForPage, type StoreFactsView } from "../assistant/store-facts";
import { syncStoreFactsForPage } from "../assistant/store-facts.server";
import { PAGE_WIDTH, PageColumns } from "../components/PageColumns";
import { SettingsFields } from "../components/settings/SettingsFields";
import { LivePreview } from "../components/settings/StorefrontPreview";
import { useSettingsDraft } from "../components/settings/useSettingsDraft";
import { activateWidgetUrl, useEmbedStatus } from "../components/useEmbedStatus";
import { factClients } from "../facts-clients.server";
import { authenticate } from "../shopify.server";

/** Each step and the parts of Settings it shows. The last step saves nothing. */
const STEPS = [
  { key: "abilities", title: "What it can do", sections: ["orders"] },
  { key: "policies", title: "Your policies", sections: ["policies"] },
  { key: "live", title: "Go live", sections: [] },
] as const satisfies ReadonlyArray<{ key: string; title: string; sections: readonly SectionKey[] }>;

const LAST_STEP = STEPS.length;

function clampStep(value: unknown): number {
  const step = Math.trunc(Number(value));
  return Number.isFinite(step) && step >= 1 && step <= LAST_STEP ? step : 1;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const state = await getSetupState(shop);
  // Remember that the tour has been seen, so the app stops opening on it.
  if (!state.started) await markSetupStarted(shop);

  const [settings, synced, rates] = await Promise.all([
    getSettings(shop),
    // What Shopify already answers for the store is not asked in the steps.
    factClients(shop, admin).then((clients) =>
      syncStoreFactsForPage(shop, clients, { maxAgeMs: 10 * 1000 }),
    ),
    loadShippingRates(toGraphqlFn(admin, "Admin")),
  ]);

  return {
    step: clampStep(new URL(request.url).searchParams.get("step")),
    shop,
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    settings,
    facts: factsForPage(synced.facts),
    shipping: shippingForPage(rates),
    progress: setupProgress(settings),
    completed: state.completed,
    llmReady: getLlmStatus().ready,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const form = await request.formData();
  const step = clampStep(form.get("step"));

  if (form.get("intent") === "finish") {
    await markSetupCompleted(session.shop);
    return redirect("/app");
  }

  const fields = fieldsOf(STEPS[step - 1].sections);
  if (fields.length) {
    const result = await saveSettings(session.shop, settingsFromForm(form, fields));
    if (!result.ok) return { errors: result.errors };
  }
  return redirect(`/app/setup?step=${Math.min(step + 1, LAST_STEP)}`);
};

/**
 * A message sent in the preview chat changes nothing this page shows, so the
 * page's data is not fetched again for it. Otherwise every test message would
 * wait on the settings and, once a minute, on Shopify.
 */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  formAction,
  defaultShouldRevalidate,
}) => (formAction === "/app/preview" ? false : defaultShouldRevalidate);

type FormSubmitEvent =
  | FormEvent<HTMLFormElement>
  | (SubmitEvent & { currentTarget: HTMLFormElement });

/** One step's switches and lists, with its own copy of what has been picked. */
function StepForm({
  step,
  sections,
  settings,
  facts,
  shipping,
  errors,
  shop,
  saving,
  onSubmit,
}: {
  step: number;
  sections: readonly SectionKey[];
  settings: AssistantSettings;
  facts: StoreFactsView;
  shipping: ShippingView;
  errors: SettingsErrors;
  shop: string;
  saving: boolean;
  onSubmit: (event: FormSubmitEvent) => void;
}) {
  const draft = useSettingsDraft(settings);
  return (
    <form onSubmit={onSubmit} onInput={draft.handleInput} onReset={draft.reset}>
      <input type="hidden" name="step" value={step} />
      <s-stack direction="block" gap="base">
        <SettingsFields
          show={sections}
          settings={settings}
          facts={facts}
          shipping={shipping}
          errors={errors}
          shop={shop}
          draft={draft}
        />
        <s-stack direction="inline" gap="small">
          {step > 1 && (
            <s-button href={`/app/setup?step=${step - 1}`} variant="tertiary">
              Back
            </s-button>
          )}
          <s-button type="submit" variant="primary" {...(saving ? { loading: true } : {})}>
            Save and continue
          </s-button>
          <s-button href={`/app/setup?step=${step + 1}`} variant="tertiary">
            Skip this step
          </s-button>
        </s-stack>
      </s-stack>
    </form>
  );
}

export default function Setup() {
  const { step, shop, apiKey, settings, facts, shipping, progress, completed, llmReady } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const embedStatus = useEmbedStatus();

  const saving = navigation.state !== "idle";
  const errors: SettingsErrors =
    actionData && "errors" in actionData ? actionData.errors : {};

  const handleSubmit = (event: FormSubmitEvent) => {
    event.preventDefault();
    if (saving) return;
    submit(new FormData(event.currentTarget), { method: "POST" });
  };

  const stepDone: Record<string, boolean> = {
    // Abilities have sensible defaults, so the step counts once the tour moves past it.
    abilities: step > 1 || completed,
    policies: progress.policies,
    live: embedStatus === "active",
  };
  const current = STEPS[step - 1];

  const aside = (
    <>
      <s-section heading="Setup steps">
        <s-stack direction="block" gap="small">
          {STEPS.map((item, index) => (
            <s-stack key={item.key} direction="inline" gap="small" alignItems="center">
              <s-link href={`/app/setup?step=${index + 1}`}>
                {index + 1}. {item.title}
              </s-link>
              {stepDone[item.key] ? (
                <s-badge tone="success">Done</s-badge>
              ) : index + 1 === step ? (
                <s-badge tone="info">Current</s-badge>
              ) : null}
            </s-stack>
          ))}
        </s-stack>
      </s-section>

      <s-section heading="Good to know">
        <s-paragraph>
          Nothing here is required. You can leave the tour at any time and finish from the Home
          page. In Settings you can also rename {settings.assistantName}, change the welcome
          message and pick answers to common questions.
        </s-paragraph>
      </s-section>
    </>
  );

  return (
    <s-page heading="Set up your assistant" inlineSize={PAGE_WIDTH}>
      <PageColumns aside={aside}>
        <s-section heading={`Step ${step} of ${LAST_STEP}: ${current.title}`}>
          {step === 1 && (
            <s-paragraph>
              Welcome! {settings.assistantName} already knows your products and reads your
              published policies. Setup is switches and lists, with nothing to type. It takes
              about two minutes, and everything can be changed later in Settings.
            </s-paragraph>
          )}
          {step === 2 && (
            <s-paragraph>
              Pick the answers to what shoppers ask most. Anything left on Not set is answered
              from your published policy pages instead.
            </s-paragraph>
          )}
          {step === LAST_STEP && (
            <s-stack direction="block" gap="small-200">
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-heading>Turn on the chat widget</s-heading>
                {embedStatus === "checking" && (
                  <s-spinner size="base" accessibilityLabel="Checking widget status" />
                )}
                {embedStatus === "active" && <s-badge tone="success">On</s-badge>}
                {embedStatus === "inactive" && <s-badge tone="warning">Off</s-badge>}
              </s-stack>
              <s-paragraph>
                This is the one step Shopify asks you to do yourself. The button opens your
                theme editor with the chat already switched on. Press{" "}
                <s-text type="strong">Save</s-text> there, and the chat bubble appears on every
                page of your store.
              </s-paragraph>
              <s-stack direction="inline" gap="small">
                <s-button
                  href={activateWidgetUrl(shop, apiKey)}
                  target="_top"
                  variant={embedStatus === "active" ? "secondary" : "primary"}
                >
                  {embedStatus === "active" ? "Open widget settings" : "Turn on chat widget"}
                </s-button>
                <s-button href={`https://${shop}`} target="_blank" variant="tertiary">
                  View storefront
                </s-button>
              </s-stack>
            </s-stack>
          )}
        </s-section>

        {step < LAST_STEP ? (
          <StepForm
            key={step}
            step={step}
            sections={current.sections}
            settings={settings}
            facts={facts}
            shipping={shipping}
            errors={errors}
            shop={shop}
            saving={saving}
            onSubmit={handleSubmit}
          />
        ) : (
          <s-section heading="Try it as a shopper">
            <s-stack direction="block" gap="base">
              <s-box maxInlineSize="420px">
                <LivePreview
                  settings={settings}
                  unsaved={false}
                  ready={llmReady}
                  fetcherKey="setup-preview"
                />
              </s-box>
              <form onSubmit={handleSubmit}>
                <input type="hidden" name="step" value={step} />
                <input type="hidden" name="intent" value="finish" />
                <s-stack direction="inline" gap="small">
                  <s-button href={`/app/setup?step=${step - 1}`} variant="tertiary">
                    Back
                  </s-button>
                  <s-button type="submit" variant="primary" {...(saving ? { loading: true } : {})}>
                    {completed ? "Done" : "Finish setup"}
                  </s-button>
                </s-stack>
              </form>
            </s-stack>
          </s-section>
        )}
      </PageColumns>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
