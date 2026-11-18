/**
 * The setup tour. Opens automatically the first time the app is opened after
 * install and walks the merchant from "just installed" to "shoppers can chat
 * with an assistant that knows my store".
 *
 * Every step is optional and saves on its own: the assistant already works
 * from the catalog and published policies, so nothing here blocks going live.
 */
import type { FormEvent } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { getLlmStatus } from "../assistant/llm/index.server";
import {
  getSettings,
  getSetupState,
  markSetupCompleted,
  markSetupStarted,
  saveSettings,
  settingsFromForm,
  setupProgress,
  type SettingsErrors,
  type SettingsField,
} from "../assistant/settings.server";
import { AssistantChat } from "../components/AssistantChat";
import {
  BusinessFields,
  FIELD_GROUPS,
  PersonalityFields,
  PolicyFields,
  QuestionFields,
} from "../components/AssistantFields";
import { activateWidgetUrl, useEmbedStatus } from "../components/useEmbedStatus";
import { authenticate } from "../shopify.server";

const STEPS = [
  { key: "business", title: "Your business" },
  { key: "policies", title: "Returns and shipping" },
  { key: "questions", title: "Common questions" },
  { key: "personality", title: "Name and tone" },
  { key: "live", title: "Go live" },
] as const;

const LAST_STEP = STEPS.length;

/** Fields each step is allowed to save. The last step saves nothing. */
const STEP_FIELDS: Record<number, readonly SettingsField[]> = {
  1: FIELD_GROUPS.business,
  2: FIELD_GROUPS.policies,
  3: FIELD_GROUPS.questions,
  4: FIELD_GROUPS.personality,
};

function clampStep(value: unknown): number {
  const step = Math.trunc(Number(value));
  return Number.isFinite(step) && step >= 1 && step <= LAST_STEP ? step : 1;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const state = await getSetupState(shop);
  // Remember that the tour has been seen, so the app stops opening on it.
  if (!state.started) await markSetupStarted(shop);

  const settings = await getSettings(shop);
  const llm = getLlmStatus();

  return {
    step: clampStep(new URL(request.url).searchParams.get("step")),
    shop,
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    settings,
    progress: setupProgress(settings),
    completed: state.completed,
    llmReady: llm.ready,
    llmProblem: llm.problem ?? null,
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

  const fields = STEP_FIELDS[step];
  if (fields) {
    const result = await saveSettings(session.shop, settingsFromForm(form, fields));
    if (!result.ok) return { errors: result.errors };
  }
  return redirect(`/app/setup?step=${Math.min(step + 1, LAST_STEP)}`);
};

type FormSubmitEvent =
  | FormEvent<HTMLFormElement>
  | (SubmitEvent & { currentTarget: HTMLFormElement });

const PREVIEW_SUGGESTIONS = [
  "What are your best sellers?",
  "What's your return policy?",
  "How long does shipping take?",
];

export default function Setup() {
  const { step, shop, apiKey, settings, progress, completed, llmReady, llmProblem } =
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
    business: progress.business,
    policies: progress.policies,
    questions: progress.questions,
    personality: progress.personality,
    live: embedStatus === "active",
  };
  const current = STEPS[step - 1];
  const fieldProps = { settings, errors };

  return (
    <s-page heading="Set up your assistant">
      <s-section heading={`Step ${step} of ${LAST_STEP}: ${current.title}`}>
        <s-stack direction="block" gap="base">
          {step === 1 && (
            <s-paragraph>
              Welcome! Your assistant can already search your products and read your published
              store policies. These steps teach it the things only you know. Each one is
              optional, takes about a minute, and can be changed later in Settings.
            </s-paragraph>
          )}

          {step < LAST_STEP ? (
            <form key={step} onSubmit={handleSubmit}>
              <input type="hidden" name="step" value={step} />
              <s-stack direction="block" gap="base">
                {step === 1 && (
                  <>
                    <s-paragraph>
                      Tell the assistant what your store is about, so it can describe your
                      business and recommend the right products.
                    </s-paragraph>
                    <BusinessFields {...fieldProps} />
                  </>
                )}
                {step === 2 && (
                  <>
                    <s-paragraph>
                      Returns and shipping are the questions shoppers ask most. Give the short
                      answers here. For anything you leave out, the assistant falls back to
                      your published policy pages.
                    </s-paragraph>
                    <PolicyFields {...fieldProps} />
                  </>
                )}
                {step === 3 && (
                  <>
                    <s-paragraph>
                      Add the answers you find yourself repeating. The assistant answers from
                      what you write here and will not invent an answer you did not give.
                    </s-paragraph>
                    <QuestionFields {...fieldProps} />
                  </>
                )}
                {step === 4 && (
                  <>
                    <s-paragraph>
                      Give the assistant a name and a voice that fits your brand. You can pick
                      the chat window&apos;s color in the theme editor in the next step.
                    </s-paragraph>
                    <PersonalityFields {...fieldProps} />
                  </>
                )}

                <s-stack direction="inline" gap="small">
                  {step > 1 && (
                    <s-button href={`/app/setup?step=${step - 1}`} variant="tertiary">
                      Back
                    </s-button>
                  )}
                  <s-button
                    type="submit"
                    variant="primary"
                    {...(saving ? { loading: true } : {})}
                  >
                    Save and continue
                  </s-button>
                  <s-button href={`/app/setup?step=${step + 1}`} variant="tertiary">
                    Skip this step
                  </s-button>
                </s-stack>
              </s-stack>
            </form>
          ) : (
            <s-stack direction="block" gap="base">
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
                  <s-text type="strong">Save</s-text> there, and the chat bubble appears on
                  every page of your store. You can also set its color and position there.
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

              <s-divider />

              <s-stack direction="block" gap="small-200">
                <s-heading>Try it as a shopper</s-heading>
                {!llmReady && (
                  <s-banner tone="warning" heading="The assistant can't answer yet">
                    {llmProblem} Add it to the app server&apos;s environment and restart the app.
                  </s-banner>
                )}
                <AssistantChat
                  action="/app/preview"
                  fetcherKey="setup-preview"
                  disabled={!llmReady}
                  userLabel="You, as a shopper"
                  placeholder="Ask what a shopper would ask"
                  pendingText="Thinking…"
                  suggestions={PREVIEW_SUGGESTIONS}
                  intro={
                    <s-paragraph>
                      This is exactly what shoppers get, using everything you just saved. Test
                      chats are not added to your conversation log.
                    </s-paragraph>
                  }
                />
              </s-stack>

              <s-divider />

              <form onSubmit={handleSubmit}>
                <input type="hidden" name="step" value={step} />
                <input type="hidden" name="intent" value="finish" />
                <s-stack direction="inline" gap="small">
                  <s-button href={`/app/setup?step=${step - 1}`} variant="tertiary">
                    Back
                  </s-button>
                  <s-button
                    type="submit"
                    variant="primary"
                    {...(saving ? { loading: true } : {})}
                  >
                    {completed ? "Done" : "Finish setup"}
                  </s-button>
                </s-stack>
              </form>
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Setup steps">
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

      <s-section slot="aside" heading="Good to know">
        <s-paragraph>
          Nothing here is required. You can leave the tour at any time and finish from the
          Home page, or edit every answer later in Settings.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
