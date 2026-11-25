/**
 * Settings: everything the merchant can decide about the assistant, in five
 * parts, with a live preview of the storefront chat beside them.
 *
 * Nothing here has to be typed. Features are switches, policies and common
 * questions are picked from lists, and what Shopify already knows about the
 * store is read from Shopify (see store-facts.server.ts).
 */
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
  ShouldRevalidateFunction,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { getLlmStatus } from "../assistant/llm/index.server";
import {
  SECTIONS,
  fieldsOf,
  isSectionKey,
  sectionsWithErrors,
  type SectionKey,
} from "../assistant/setting-options";
import {
  getSettings,
  saveSettings,
  settingsFromForm,
  type AssistantSettings,
  type SettingsErrors,
} from "../assistant/settings.server";
import { shippingForPage, type ShippingView } from "../assistant/shipping";
import { loadShippingRates } from "../assistant/shipping.server";
import { toGraphqlFn } from "../assistant/shopify-clients.server";
import { factsForPage, type StoreFactsView } from "../assistant/store-facts";
import { syncStoreFactsForPage, type FactsReached } from "../assistant/store-facts.server";
import { SectionNav, SettingsFields } from "../components/settings/SettingsFields";
import { LivePreview } from "../components/settings/StorefrontPreview";
import { SyncedFromShopify } from "../components/settings/SyncedFromShopify";
import { useSettingsDraft } from "../components/settings/useSettingsDraft";
import { factClients } from "../facts-clients.server";
import { authenticate } from "../shopify.server";

const ALL_SECTIONS = SECTIONS.map((section) => section.key);

/**
 * Opening the page asks Shopify afresh. This only keeps the reload that
 * follows a save from asking a second time within seconds of the first.
 */
const FACTS_MAX_AGE_MS = 10 * 1000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const wanted = new URL(request.url).searchParams.get("section");

  const [settings, synced, rates] = await Promise.all([
    getSettings(shop),
    factClients(shop, admin).then((clients) =>
      syncStoreFactsForPage(shop, clients, { maxAgeMs: FACTS_MAX_AGE_MS }),
    ),
    // Shipping zones and rates are never kept: read now, shown as they are.
    loadShippingRates(toGraphqlFn(admin, "Admin")),
  ]);
  return {
    shop,
    settings,
    facts: factsForPage(synced.facts),
    shipping: shippingForPage(rates),
    reached: synced.reached,
    section: isSectionKey(wanted) ? wanted : ("assistant" as SectionKey),
    llmReady: getLlmStatus().ready,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  // The shop always comes from the authenticated session, never from the form.
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();

  if (form.get("intent") === "sync") {
    const synced = await syncStoreFactsForPage(
      session.shop,
      await factClients(session.shop, admin),
    );
    return { ok: true, errors: {} as SettingsErrors, reached: synced.reached };
  }

  const result = await saveSettings(
    session.shop,
    settingsFromForm(form, fieldsOf(ALL_SECTIONS)),
  );
  const errors: SettingsErrors = result.ok ? {} : result.errors;
  return { ok: result.ok, errors, reached: null };
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

const NO_ERRORS: SettingsErrors = {};

export default function Settings() {
  const { shop, settings, facts, shipping, reached, section: startAt, llmReady } =
    useLoaderData<typeof loader>();
  const save = useFetcher<typeof action>({ key: "settings-save" });
  const sync = useFetcher<typeof action>({ key: "settings-sync" });
  const shopify = useAppBridge();

  const saving = save.state !== "idle";
  const errors = save.data?.errors ?? NO_ERRORS;
  const failed = save.data?.ok === false;

  // Which part is open lives here, above what is rebuilt after a save, so
  // saving leaves the merchant where they were.
  const [section, setSection] = useState<SectionKey>(startAt);
  // A refused save takes them to the first part with something to fix.
  const [shownErrors, setShownErrors] = useState(errors);
  if (errors !== shownErrors) {
    setShownErrors(errors);
    const wrong = sectionsWithErrors(errors);
    if (wrong.length && !wrong.includes(section)) setSection(wrong[0]);
  }

  useEffect(() => {
    if (save.state === "idle" && save.data?.ok) {
      shopify.toast.show("Settings saved");
    }
  }, [save.state, save.data, shopify]);

  const handleSubmit = (event: FormSubmitEvent) => {
    event.preventDefault();
    if (saving) return;
    save.submit(new FormData(event.currentTarget), { method: "POST" });
  };

  return (
    <s-page heading="Settings">
      {/* Starting again from the saved settings after each save also clears
          the "unsaved changes" bar. */}
      <Workspace
        key={JSON.stringify(settings)}
        shop={shop}
        settings={settings}
        facts={facts}
        shipping={shipping}
        reached={sync.data?.reached ?? reached}
        errors={errors}
        failed={failed}
        section={section}
        onSection={setSection}
        llmReady={llmReady}
        onSubmit={handleSubmit}
        checking={sync.state !== "idle"}
        onCheckAgain={() => sync.submit({ intent: "sync" }, { method: "POST" })}
      />
    </s-page>
  );
}

function Workspace({
  shop,
  settings,
  facts,
  shipping,
  reached,
  errors,
  failed,
  section,
  onSection,
  llmReady,
  onSubmit,
  checking,
  onCheckAgain,
}: {
  shop: string;
  settings: AssistantSettings;
  facts: StoreFactsView;
  shipping: ShippingView;
  reached: FactsReached | null;
  errors: SettingsErrors;
  failed: boolean;
  section: SectionKey;
  onSection: (section: SectionKey) => void;
  llmReady: boolean;
  onSubmit: (event: FormSubmitEvent) => void;
  checking: boolean;
  onCheckAgain: () => void;
}) {
  const draft = useSettingsDraft(settings);

  return (
    <>
      <s-stack direction="block" gap="base">
        {failed && (
          <s-banner tone="critical" heading="Settings weren't saved">
            Fix the highlighted fields and save again.
          </s-banner>
        )}
        {!draft.draft.enabled && (
          <s-banner tone="warning" heading="The chat is paused">
            Shoppers don&apos;t see the chat bubble while it is switched off under Assistant.
            Everything else you set here is kept.
          </s-banner>
        )}
        <SectionNav active={section} errors={errors} onChange={onSection} />
        <form data-save-bar onSubmit={onSubmit} onInput={draft.handleInput} onReset={draft.reset}>
          <SettingsFields
            show={ALL_SECTIONS}
            active={section}
            settings={settings}
            facts={facts}
            shipping={shipping}
            errors={errors}
            shop={shop}
            draft={draft}
          />
        </form>
      </s-stack>

      <s-section slot="aside" heading="Preview">
        <LivePreview
          settings={draft.draft}
          unsaved={draft.dirty}
          ready={llmReady}
          fetcherKey="settings-preview"
        />
      </s-section>

      <s-section slot="aside" heading="From your Shopify store">
        <SyncedFromShopify
          facts={facts}
          shipping={shipping}
          reached={reached}
          action={
            <s-stack direction="inline">
              <s-button
                variant="tertiary"
                icon="refresh"
                onClick={onCheckAgain}
                {...(checking ? { loading: true } : {})}
              >
                Check again
              </s-button>
            </s-stack>
          }
        />
      </s-section>
    </>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
