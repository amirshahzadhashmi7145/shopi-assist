import { useEffect } from "react";
import type { FormEvent } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import {
  getSettings,
  saveSettings,
  settingsFromForm,
  type SettingsErrors,
  type SettingsField,
} from "../assistant/settings.server";
import {
  AbilityFields,
  BusinessFields,
  FIELD_GROUPS,
  PersonalityFields,
  PolicyFields,
  QuestionFields,
  QuickPolicyFields,
} from "../components/AssistantFields";

import { authenticate } from "../shopify.server";

/** Every setting this page shows, and so every setting its form may change. */
const SETTINGS_PAGE_FIELDS: readonly SettingsField[] = [
  ...FIELD_GROUPS.abilities,
  ...FIELD_GROUPS.quickPolicies,
  ...FIELD_GROUPS.personality,
  ...FIELD_GROUPS.business,
  ...FIELD_GROUPS.policies,
  ...FIELD_GROUPS.questions,
  "enabled",
  "instructions",
  "retentionDays",
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { settings: await getSettings(session.shop) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  // The shop always comes from the authenticated session, never from the form.
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  const result = await saveSettings(
    session.shop,
    settingsFromForm(form, SETTINGS_PAGE_FIELDS),
  );

  const errors: SettingsErrors = result.ok ? {} : result.errors;
  return { ok: result.ok, errors };
};


type FormSubmitEvent =
  | FormEvent<HTMLFormElement>
  | (SubmitEvent & { currentTarget: HTMLFormElement });

export default function Settings() {
  const { settings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const saving = fetcher.state !== "idle";
  const errors = fetcher.data?.errors ?? {};
  const failed = fetcher.data?.ok === false;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      shopify.toast.show("Settings saved");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const handleSubmit = (event: FormSubmitEvent) => {
    event.preventDefault();
    if (saving) return;
    fetcher.submit(new FormData(event.currentTarget), { method: "POST" });
  };

  // Remounting the form after a save resets every field to the stored value,
  // which also clears the "unsaved changes" bar.
  const formKey = JSON.stringify(settings);

  return (
    <s-page heading="Settings">
      <form key={formKey} data-save-bar onSubmit={handleSubmit}>
        <s-stack direction="block" gap="base">
          {failed && (
            <s-banner tone="critical" heading="Settings weren't saved">
              Fix the highlighted fields and save again.
            </s-banner>
          )}

          <s-section heading="What the assistant can do">
            <s-stack direction="block" gap="base">
              <AbilityFields settings={settings} errors={errors} />
              <s-banner tone="info">
                Order status and return requests read order details, including the email
                address on the order, which Shopify classes as protected customer data. Before
                turning them on for a live store, request protected customer data access
                (including the email field) for this app in your Shopify Dev Dashboard.
              </s-banner>
            </s-stack>
          </s-section>

          <s-section heading="Your policies">
            <QuickPolicyFields settings={settings} errors={errors} />
          </s-section>

          <s-section heading="Name and tone">
            <PersonalityFields settings={settings} errors={errors} />
          </s-section>

          <s-section heading="More detail (optional)">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Only if you want to. Anything you write here is added to what the assistant
                knows, on top of the choices above.
              </s-paragraph>
              <BusinessFields settings={settings} errors={errors} />
              <PolicyFields settings={settings} errors={errors} />
              <QuestionFields settings={settings} errors={errors} />
              <s-text-area
                name="instructions"
                label="Anything else the assistant should know or do"
                details="Treat everything on this page as public: a determined shopper can get the assistant to repeat it, so don't include anything confidential."
                rows={4}
                maxLength={2000}
                defaultValue={settings.instructions}
                {...(errors.instructions ? { error: errors.instructions } : {})}
              />
            </s-stack>
          </s-section>

          <s-section heading="Storefront chat">
            <s-checkbox
              name="enabled"
              label="Answer shoppers in the storefront chat"
              details="Turn this off to pause the assistant. The chat bubble is hidden from shoppers until you turn it back on."
              {...(settings.enabled ? { defaultChecked: true } : {})}
            />
          </s-section>

          <s-section heading="Privacy">
            <s-number-field
              name="retentionDays"
              label="Keep chat transcripts for"
              suffix="days"
              details="Conversations with no activity for this long are deleted automatically. Between 1 and 365."
              min={1}
              max={365}
              step={1}
              defaultValue={String(settings.retentionDays)}
              {...(errors.retentionDays ? { error: errors.retentionDays } : {})}
            />
          </s-section>
        </s-stack>
      </form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
