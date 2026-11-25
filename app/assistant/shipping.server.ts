/**
 * Reads a store's shipping zones and rates from Shopify, at the moment they
 * are asked for. Nothing is kept: every call is a fresh read, so a rate the
 * merchant changed a minute ago is the rate that is quoted.
 *
 * Needs the `read_shipping` access scope. Until a store has approved it, the
 * answer says so (`no_access`) and the callers fall back to what they have.
 */
import {
  NO_SHIPPING_RATES,
  readProcessingDays,
  readShippingProfile,
  type ShippingRates,
} from "./shipping";
import type { GraphqlFn } from "./types";

/** The store's shipping profiles. The default one holds the rates most products use. */
export const SHIPPING_PROFILES_QUERY = `#graphql
  query ShopiAssistShippingProfiles {
    deliveryProfiles(first: 10) {
      nodes {
        id
        default
      }
    }
  }
`;

/**
 * One profile's zones, each with the countries it covers and its rates. The
 * page sizes keep the query well inside Shopify's cost limit for one request;
 * a store with more zones than this is reported as having more.
 */
export const SHIPPING_RATES_QUERY = `#graphql
  query ShopiAssistShippingRates($id: ID!) {
    deliveryProfile(id: $id) {
      profileLocationGroups {
        locationGroupZones(first: 15) {
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
            methodDefinitions(first: 8) {
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

/** How long the store takes to hand an order to the carrier, where it has said. */
export const PROCESSING_TIME_QUERY = `#graphql
  query ShopiAssistProcessingTime {
    deliveryPromiseSettings {
      processingTime
    }
  }
`;

/**
 * The store's processing time in business days, as set in Shopify now.
 * Undefined when it is not set or cannot be read; never throws.
 */
export async function loadProcessingDays(admin: GraphqlFn | undefined): Promise<number | undefined> {
  if (!admin) return undefined;
  try {
    const data = await admin<{ deliveryPromiseSettings: { processingTime: string | null } | null }>(
      PROCESSING_TIME_QUERY,
    );
    return readProcessingDays(data.deliveryPromiseSettings?.processingTime);
  } catch {
    return undefined;
  }
}

interface Profiles {
  deliveryProfiles: { nodes: Array<{ id: string; default: boolean }> } | null;
}

/**
 * The store's general shipping zones and rates, as they are in Shopify now.
 * `admin` must be the Admin API client of the authenticated shop. Never
 * throws: when Shopify cannot be asked the answer says why.
 */
export async function loadShippingRates(admin: GraphqlFn | undefined): Promise<ShippingRates> {
  if (!admin) return { ...NO_SHIPPING_RATES };
  // Asked alongside the rates; it has nothing to do with whether they can be read.
  const processing = loadProcessingDays(admin);
  const withProcessing = async (rates: ShippingRates): Promise<ShippingRates> => {
    const processingDays = await processing;
    return processingDays === undefined ? rates : { ...rates, processingDays };
  };
  try {
    const profiles = (await admin<Profiles>(SHIPPING_PROFILES_QUERY)).deliveryProfiles?.nodes ?? [];
    const general = profiles.find((profile) => profile.default) ?? profiles[0];
    if (!general) {
      return withProcessing({ state: "live", zones: [], otherProfiles: false, truncated: false });
    }

    const data = await admin<unknown>(SHIPPING_RATES_QUERY, { id: general.id });
    return withProcessing({
      state: "live",
      ...readShippingProfile(data),
      otherProfiles: profiles.length > 1,
    });
  } catch (error) {
    // Shopify's own words for a scope the store has not granted.
    const denied = error instanceof Error && /access denied/i.test(error.message);
    if (!denied) {
      console.error(
        `[shopi-assist] shipping rates could not be read error=${error instanceof Error ? error.name : "unknown"}`,
      );
    }
    return withProcessing({ ...NO_SHIPPING_RATES, state: denied ? "no_access" : "unreachable" });
  }
}
