/**
 * Reads where a store delivers and what delivery costs from Shopify, at the
 * moment it is asked for. Nothing is kept: every call is a fresh read, so a
 * rate the merchant changed a minute ago is the rate that is quoted.
 *
 * Shopify keeps these settings in one of two places (see shipping.ts), so the
 * first thing asked is which one this store is on. A store on market-driven
 * shipping still has its old shipping profiles, but its checkout ignores
 * them: reading those would quote rates the store no longer charges.
 *
 * Needs the `read_markets` access scope for a store on markets and
 * `read_shipping` for one on profiles (and for the processing time). Until a
 * store has approved them, the answer says so (`no_access`) and the callers
 * fall back to what they have.
 */
import {
  NO_SHIPPING_RATES,
  readMarketShipping,
  readProcessingDays,
  readShippingProfile,
  type ShippingRates,
} from "./shipping";
import type { GraphqlFn } from "./types";

/** Which of its two shipping set-ups the store is on. Needs no permission. */
export const SHIPPING_MODEL_QUERY = `#graphql
  query ShopiAssistShippingModel {
    shop {
      features {
        marketDrivenShipping
      }
    }
  }
`;

/**
 * What goes with the rates on either set-up: how long the store takes to
 * hand an order to the carrier, and its shipping profiles. `own` are the
 * merchant's; any other in `all` belongs to an app, whose rates the checkout
 * adds to the store's own.
 */
export const SHIPPING_SETUP_QUERY = `#graphql
  query ShopiAssistShippingSetup {
    deliveryPromiseSettings {
      processingTime
    }
    all: deliveryProfiles(first: 25) {
      pageInfo { hasNextPage }
      nodes {
        id
        default
      }
    }
    own: deliveryProfiles(first: 25, merchantOwnedOnly: true) {
      pageInfo { hasNextPage }
      nodes {
        id
      }
    }
  }
`;

/**
 * One profile's zones, each with the countries it covers and its rates. The
 * page sizes keep the query well inside Shopify's cost limit for one request;
 * a store with more than this is reported as having more.
 */
export const SHIPPING_RATES_QUERY = `#graphql
  query ShopiAssistShippingRates($id: ID!) {
    deliveryProfile(id: $id) {
      profileLocationGroups {
        locationGroupZones(first: 25) {
          pageInfo { hasNextPage }
          nodes {
            zone {
              name
              countries {
                code {
                  countryCode
                  restOfWorld
                }
              }
            }
            methodDefinitions(first: 12) {
              pageInfo { hasNextPage }
              nodes {
                name
                active
                description
                rateProvider {
                  ... on DeliveryRateDefinition {
                    price { amount currencyCode }
                  }
                  ... on DeliveryParticipant {
                    carrierService { formattedName name }
                  }
                }
                methodConditions {
                  field
                  operator
                  conditionCriteria {
                    ... on MoneyV2 { amount currencyCode }
                    ... on Weight { unit value }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * The store's markets that sell by region, each with the countries in it and
 * its delivery options. One request: the page sizes are chosen so that its
 * cost, which Shopify works out from them and not from what the store has,
 * stays near half of the limit for a single query. A store with more than
 * this is reported as having more.
 *
 * The four kinds of option name their rates differently, hence the aliases.
 */
export const MARKET_SHIPPING_QUERY = `#graphql
  query ShopiAssistMarketShipping {
    markets(first: 20, type: REGION) {
      pageInfo { hasNextPage }
      nodes {
        id
        name
        status
        conditions {
          regionsCondition {
            applicationLevel
            regions(first: 250) {
              pageInfo { hasNextPage }
              nodes {
                __typename
                name
                ... on MarketRegionCountry {
                  code
                }
                ... on MarketRegionSubdivision {
                  subdivisionCode: code
                  country { code }
                }
              }
            }
          }
        }
        parentMarkets(first: 1) {
          nodes { id }
        }
        delivery {
          shipping {
            isEnabled
            optionDefinitions(first: 6, active: true) {
              pageInfo { hasNextPage }
              nodes {
                __typename
                description
                isActive
                freeDeliveryMinimumValue { amount currencyCode }
                ... on DeliveryFlatRateOptionDefinition {
                  name
                  flatGroups: rateGroups(first: 2) {
                    pageInfo { hasNextPage }
                    nodes {
                      conditions { collectionsCount { count } }
                      rate {
                        price { amount currencyCode }
                        transitTimeMinSeconds
                        transitTimeMaxSeconds
                      }
                    }
                  }
                }
                ... on DeliveryValueBasedOptionDefinition {
                  name
                  valueGroups: rateGroups(first: 2) {
                    pageInfo { hasNextPage }
                    nodes {
                      conditions { collectionsCount { count } }
                      rates(first: 10) {
                        pageInfo { hasNextPage }
                        nodes {
                          price { amount currencyCode }
                          minValue { amount currencyCode }
                          maxValue { amount currencyCode }
                          transitTimeMinSeconds
                          transitTimeMaxSeconds
                        }
                      }
                    }
                  }
                }
                ... on DeliveryWeightBasedOptionDefinition {
                  name
                  weightGroups: rateGroups(first: 2) {
                    pageInfo { hasNextPage }
                    nodes {
                      conditions { collectionsCount { count } }
                      rates(first: 10) {
                        pageInfo { hasNextPage }
                        nodes {
                          price { amount currencyCode }
                          minWeight { unit value }
                          maxWeight { unit value }
                          transitTimeMinSeconds
                          transitTimeMaxSeconds
                        }
                      }
                    }
                  }
                }
                ... on DeliveryCarrierCalculatedOptionDefinition {
                  carrierGroups: rateGroups(first: 2) {
                    pageInfo { hasNextPage }
                    nodes {
                      conditions { collectionsCount { count } }
                      carrierService { formattedName name }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface Model {
  shop: { features: { marketDrivenShipping: boolean } | null } | null;
}

interface Setup {
  deliveryPromiseSettings: { processingTime: string | null } | null;
  all: { pageInfo: { hasNextPage: boolean }; nodes: Array<{ id: string; default: boolean }> } | null;
  own: { pageInfo: { hasNextPage: boolean }; nodes: Array<{ id: string }> } | null;
}

/** Shopify's own words for a scope the store has not granted. */
const isDenied = (error: unknown) => error instanceof Error && /access denied/i.test(error.message);

/**
 * Where the store delivers and what it charges, as it is in Shopify now.
 * `admin` must be the Admin API client of the authenticated shop. Never
 * throws: when Shopify cannot be asked the answer says why.
 */
export async function loadShippingRates(admin: GraphqlFn | undefined): Promise<ShippingRates> {
  if (!admin) return { ...NO_SHIPPING_RATES };

  // Asked alongside the question of which set-up the store is on. It needs a
  // permission that question does not, so its failing is kept apart.
  const setupRead = admin<Setup>(SHIPPING_SETUP_QUERY).then(
    (setup) => ({ setup, error: null }),
    (error: unknown) => ({ setup: null, error }),
  );

  let model: ShippingRates["model"];
  let processingDays: number | undefined;
  const answer = (rates: Omit<ShippingRates, "model" | "processingDays">): ShippingRates => ({
    ...rates,
    ...(model ? { model } : {}),
    ...(processingDays === undefined ? {} : { processingDays }),
  });

  try {
    const [found, { setup, error: setupError }] = await Promise.all([
      admin<Model>(SHIPPING_MODEL_QUERY),
      setupRead,
    ]);
    const flag = found.shop?.features?.marketDrivenShipping;
    // No answer on which set-up: reading either one could quote the wrong rates.
    if (typeof flag !== "boolean") throw new Error("Shopify did not say which shipping set-up the store uses");
    model = flag ? "markets" : "profiles";
    processingDays = readProcessingDays(setup?.deliveryPromiseSettings?.processingTime);
    const profiles = setup?.all?.nodes ?? [];

    if (model === "markets") {
      const read = readMarketShipping(await admin<unknown>(MARKET_SHIPPING_QUERY));
      // A profile that is not the merchant's own is an app's, and the
      // checkout adds its rates to the markets' own.
      const own = new Set((setup?.own?.nodes ?? []).map((profile) => profile.id));
      const appRates =
        setup?.own != null &&
        !setup.own.pageInfo.hasNextPage &&
        profiles.some((profile) => !own.has(profile.id));
      return answer({
        state: "live",
        ...read,
        otherProfiles: read.otherProfiles || appRates,
      });
    }

    // Profiles: the rates need the list of them, so its failure is the answer.
    if (!setup) throw setupError;
    const general = profiles.find((profile) => profile.default);
    const morePages = setup.all?.pageInfo.hasNextPage === true;
    if (!general) {
      // No general profile among those read: with more unread, the rates are
      // not known; with none unread, the store truly has no zones.
      return answer({ state: "live", zones: [], otherProfiles: profiles.length > 0, truncated: morePages });
    }
    const data = await admin<unknown>(SHIPPING_RATES_QUERY, { id: general.id });
    return answer({
      state: "live",
      ...readShippingProfile(data),
      otherProfiles: profiles.length > 1 || morePages,
    });
  } catch (error) {
    const denied = isDenied(error);
    if (!denied) {
      console.error(
        `[shopi-assist] shipping rates could not be read error=${error instanceof Error ? error.name : "unknown"}`,
      );
    }
    // How soon orders leave is its own question: known even when the rates are not.
    if (processingDays === undefined) {
      const { setup } = await setupRead;
      processingDays = readProcessingDays(setup?.deliveryPromiseSettings?.processingTime);
    }
    return answer({ ...NO_SHIPPING_RATES, state: denied ? "no_access" : "unreachable" });
  }
}
