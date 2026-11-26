/**
 * Shopper tools that read the store's own settings from Shopify at the moment
 * they are called: where it delivers and what delivery costs, and how its
 * checkout can be paid. Nothing here is stored or typed in by the merchant.
 *
 * Both answer only what a visitor finds out at the checkout anyway.
 */
import { z } from "zod";

import {
  NO_SHIPPING_RATES,
  countryCodeFor,
  deliveredCountries,
  freeFromText,
  processingText,
  rateCost,
  zoneCountryName,
  zoneDelivers,
  zonesFor,
  type ShippingRate,
  type ShippingRates,
  type ShippingZone,
} from "../shipping";
import { countryName, paymentNames } from "../store-facts";
import { defineTool, type ToolContext, type ToolDefinition } from "./registry";
import { PAYMENT_SETTINGS_QUERY, SHIPS_TO_QUERY } from "./storefront-queries";

const MAX_ZONES = 12;
const MAX_RATES = 8;
const MAX_COUNTRIES = 40;

const rateOut = (rate: ShippingRate) => ({
  name: rate.name,
  cost: rateCost(rate),
  ...(rate.freeFrom ? { freeOnOrdersOf: freeFromText(rate) } : {}),
  ...(rate.conditions.length ? { appliesTo: rate.conditions.join(" and ") } : {}),
  ...(rate.delivery ? { deliveryTime: `${rate.delivery} after the order is sent out` } : {}),
  ...(rate.description ? { details: rate.description } : {}),
});

/** Names in alphabetical order, cut off with a count when there are many. */
function listed(names: string[], max: number): string[] {
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  return sorted.length <= max ? sorted : [...sorted.slice(0, max), `and ${sorted.length - max} more`];
}

const named = (codes: readonly string[], max = MAX_COUNTRIES) => listed(codes.map(countryName), max);

const zoneOut = (zone: ShippingZone) => ({
  countries: listed(
    zone.countries.map((code) => zoneCountryName(zone, code)),
    15,
  ),
  ...(zone.restOfWorld ? { alsoEveryCountryNotNamedInAnotherZone: true } : {}),
  rates: zone.rates.slice(0, MAX_RATES).map(rateOut),
  ...(zone.more ? { moreOptionsAtCheckout: true } : {}),
});

/** What the Storefront API says about where the store delivers. See SHIPS_TO_QUERY. */
interface StorefrontCountries {
  /** Countries with a zone in the store's shipping profiles. Null: not answered, or none listed. */
  zones: string[] | null;
  /** Countries in an active market: where the store sells. Null: not answered, or none listed. */
  markets: string[] | null;
}

async function storefrontCountries(context: ToolContext): Promise<StorefrontCountries | null> {
  if (!context.storefront) return null;
  try {
    const data = await context.storefront<{
      shop: { shipsToCountries: string[] | null } | null;
      localization: { availableCountries: Array<{ isoCode: string } | null> | null } | null;
    }>(SHIPS_TO_QUERY);
    // An empty list is not taken as "delivers nowhere": it is as likely not to have been answered.
    const codes = (list: unknown): string[] | null => {
      const found = Array.isArray(list)
        ? list.filter((code): code is string => typeof code === "string" && /^[A-Z]{2}$/.test(code))
        : [];
      return found.length ? found : null;
    };
    return {
      zones: codes(data.shop?.shipsToCountries),
      markets: codes(data.localization?.availableCountries?.map((country) => country?.isoCode)),
    };
  } catch {
    return null;
  }
}

/**
 * Whether the store delivers to a country, going by the Storefront API alone.
 * Null: it cannot tell. Which list counts depends on where the store keeps
 * its shipping.
 */
function deliversPerStorefront(
  seen: StorefrontCountries,
  model: ShippingRates["model"],
  code: string,
): boolean | null {
  if (model === "profiles") return seen.zones ? seen.zones.includes(code) : null;
  // No active market sells there, so nothing can be ordered to it at all.
  if (seen.markets && !seen.markets.includes(code)) return false;
  // On markets the list of zones is left behind, and selling somewhere is not yet delivering there.
  if (model === "markets") return null;
  // Not known which the store is on: only what both lists agree on.
  return seen.zones?.includes(code) && seen.markets?.includes(code) ? true : null;
}

/**
 * Whether the settings read say the store delivers to a country.
 * Null: they do not settle it.
 */
function deliversPerSettings(rates: ShippingRates, code: string, complete: boolean): boolean | null {
  const zones = zonesFor(rates, code);
  // On shipping profiles, a country reached only by the rate "for the rest of
  // the world" is delivered to only if the store also sells there.
  const named = zones.some((zone) => zone.countries.includes(code));
  if (zones.some(zoneDelivers)) return named || rates.model === "markets" ? true : null;
  if (zones.length) return rates.otherProfiles ? null : false;
  return complete ? false : null;
}

const getShippingInfo = defineTool({
  name: "get_shipping_info",
  description:
    "Everything about delivery, read from the store's own shipping settings at this moment: which countries it delivers to, what delivery costs, how soon orders are sent out and how long delivery takes. Use it before answering any question about delivery or shipping, even if you looked earlier in the chat. Give the country the shopper means as a two-letter ISO code (for example 'CA' for Canada); leave it out to get every delivery zone.",
  audiences: ["shopper"],
  schema: z.object({
    country: z
      .string()
      .trim()
      .max(60)
      .optional()
      .describe("Two-letter ISO country code, such as 'US', 'GB' or 'PK'. Leave out for all zones."),
  }),
  isAvailable: (context) => Boolean(context.shippingRates) || Boolean(context.storefront),
  async run({ country }, context) {
    const asked = country ? countryCodeFor(country) : null;
    if (country && !asked) {
      return {
        output: {
          country,
          recognised: false,
          note: "That country was not recognised. Ask the shopper which country they mean, then look again with its two-letter code.",
        },
      };
    }
    // The country the shopper is browsing the store from, when the page said.
    const browsing = context.buyer.country ? countryCodeFor(context.buyer.country) : null;

    const rates = context.shippingRates ? await context.shippingRates() : { ...NO_SHIPPING_RATES };
    const picks = context.shippingPicks ?? {};
    // How soon orders leave: the store's own setting in Shopify, else what the owner picked.
    const dispatch =
      rates.processingDays !== undefined
        ? { dispatch: `Orders are handed to the carrier ${processingText(rates.processingDays)}.` }
        : picks.dispatch
          ? { dispatch: picks.dispatch }
          : {};
    // How long delivery takes: each rate's own time, else what the owner picked.
    const usualTime = (shown: ShippingRate[]) =>
      picks.deliveryTime && shown.some((rate) => !rate.delivery)
        ? { usualDeliveryTime: picks.deliveryTime }
        : {};
    const usualTimeNote = (shown: ShippingRate[]) =>
      picks.deliveryTime && shown.some((rate) => !rate.delivery)
        ? " A rate with no delivery time of its own takes the store's usual one, given as usualDeliveryTime."
        : "";

    if (
      rates.state === "live" &&
      rates.zones.length === 0 &&
      !rates.truncated &&
      !rates.otherProfiles
    ) {
      // Shopify was read, and holds no delivery zone or rate for the store.
      // The owner's picks for area and cost are for when Shopify cannot be
      // asked: here it was asked, and they would promise what its checkout
      // has no way to give.
      return {
        output: {
          ratesAvailable: false,
          ...dispatch,
          note: "The store's shipping settings in Shopify list no delivery zone or rate right now. Say that you cannot give delivery details at the moment and that the checkout shows what is available, and suggest contacting the store. Never guess a price or a delivery country.",
        },
      };
    }

    if (rates.state !== "live" || rates.zones.length === 0) {
      // The rates cannot be read. Where the store delivers may still be told
      // by the Storefront API, and what the store owner picked or wrote is
      // the best there is for the rest.
      const seen = await storefrontCountries(context);
      const code = asked ?? browsing;
      const verdict = code && seen ? deliversPerStorefront(seen, rates.model, code) : null;
      const sellsThere =
        code && verdict === null && rates.model !== "profiles" && seen?.markets?.includes(code);
      // "Which countries?" gets the whole list, whichever country the shopper is in.
      const everyZone = !asked && rates.model === "profiles" ? seen?.zones : null;
      const everyMarket = !asked && rates.model !== "profiles" ? seen?.markets : null;
      // Shopify's own word on where the store delivers says it better than the owner's pick.
      const knowsWhere = verdict !== null || Boolean(everyZone) || Boolean(everyMarket);
      const owner = [knowsWhere ? "" : picks.area, picks.cost, picks.deliveryTime, context.shippingNote]
        .filter(Boolean)
        .join("\n");
      return {
        output: {
          ratesAvailable: false,
          ...dispatch,
          ...(code ? { country: countryName(code) } : {}),
          ...(verdict !== null ? { delivers: verdict } : {}),
          ...(sellsThere ? { storeSellsThere: true } : {}),
          ...(everyZone ? { deliversTo: named(everyZone) } : {}),
          ...(everyMarket ? { sellsTo: named(everyMarket) } : {}),
          ...(owner ? { fromTheStoreOwner: owner } : {}),
          note: `The store's shipping rates could not be read from its settings just now.${
            owner
              ? " Give what the store owner says above as the answer."
              : " Say that the checkout shows the exact delivery cost before payment."
          } Never guess a price or a delivery country.${
            sellsThere || everyMarket
              ? " The store sells to the countries given here, and the checkout shows the delivery options for each: say that, without promising delivery."
              : ""
          }${
            !asked && code
              ? " No country was named, so 'country' is the one the shopper is browsing the store from: say which country an answer is for."
              : ""
          }`,
        },
      };
    }

    const delivering = rates.zones.filter(zoneDelivers);
    const everywhereElse = delivering.some((zone) => zone.restOfWorld);
    // Whether the zones read are every place the store delivers. On profiles,
    // products with rates of their own can reach countries these do not.
    const complete =
      !everywhereElse && !rates.truncated && !(rates.model !== "markets" && rates.otherProfiles);
    const general =
      " These are the store's general rates, read from its shipping settings just now: they are what the store does today. A rate marked 'calculated at checkout' is priced for the shopper's own address, and the checkout always shows the final options and cost before payment." +
      (rates.otherProfiles
        ? " Some products have shipping rates of their own, which the checkout shows."
        : "") +
      (rates.truncated ? " The store has more delivery zones than are listed here." : "");

    if (asked) {
      const zones = zonesFor(rates, asked);
      const usable = zones.filter((zone) => zone.rates.length > 0);
      if (usable.length) {
        // On shipping profiles, a rate "for the rest of the world" reaches
        // only the countries the store sells to. Where the storefront says
        // this is not one of them, the rate is there but the promise is not.
        const restOnly =
          rates.model !== "markets" && usable.every((zone) => !zone.countries.includes(asked));
        const sold = restOnly ? (await storefrontCountries(context))?.markets : null;
        const notSoldThere = Boolean(sold && !sold.includes(asked));
        // Some zones cover only certain provinces or states of the country.
        // Then every zone is given with its own answer, one that delivers
        // nothing included: its area must not pass for one the other rates reach.
        const split = zones.some((zone) => zone.parts?.[asked]);
        const shown = split
          ? usable.flatMap((zone) => zone.rates.slice(0, MAX_RATES))
          : usable.flatMap((zone) => zone.rates).slice(0, MAX_RATES);
        return {
          output: {
            country: countryName(asked),
            ...(notSoldThere ? { deliveryNotConfirmed: true } : { delivers: true }),
            ...dispatch,
            ...(split
              ? {
                  areas: zones.map((zone) => ({
                    ...(zone.parts?.[asked]
                      ? { onlyIn: zone.parts[asked] }
                      : { restOfTheCountry: true }),
                    ...(zone.rates.length
                      ? { rates: zone.rates.slice(0, MAX_RATES).map(rateOut) }
                      : zone.more
                        ? { ratesShownAtCheckout: true }
                        : { delivers: false }),
                  })),
                }
              : { rates: shown.map(rateOut) }),
            ...usualTime(shown),
            ...(zones.some((zone) => zone.more) ? { moreOptionsAtCheckout: true } : {}),
            note: `${
              notSoldThere
                ? `These are the store's rates for every country it has no zone of its own for, but its checkout does not list ${countryName(asked)} among the countries it sells to. Do not promise delivery there: give the rates as what would apply, and say that the checkout confirms whether ${countryName(asked)} can be delivered to.`
                : "Give these rates as they are, each with what it applies to."
            }${
              split
                ? " Delivery within this country depends on the province or state: say which areas each set of rates is for, say so plainly where an area has no delivery, and ask the shopper for theirs when it matters."
                : ""
            }${usualTimeNote(shown)}${general}`,
          },
        };
      }

      // No rate that applies to every order. Whether that means "no
      // delivery" depends on whether everything could be read: a zone that
      // names the country may have rates for certain products only, and a
      // country no zone names may be in one that was not read.
      const unsure = zones.length
        ? zones.some((zone) => zone.more) || rates.otherProfiles
        : !complete;
      if (unsure) {
        const seen = await storefrontCountries(context);
        const verdict = seen ? deliversPerStorefront(seen, rates.model, asked) : null;
        if (verdict !== false) {
          return {
            output: {
              country: countryName(asked),
              ...(verdict === true ? { delivers: true } : {}),
              ratesAvailable: false,
              ...dispatch,
              note: `The store's settings give no delivery cost for ${countryName(asked)} that applies to every order: it can depend on the products, or could not be read in full. Do not say that the store does not deliver there. Say that the checkout shows the delivery options and their cost for the shopper's address before payment. Never guess a price.`,
            },
          };
        }
      }
      const everywhere = deliveredCountries(rates);
      return {
        output: {
          country: countryName(asked),
          delivers: false,
          ...(everywhere.length
            ? complete
              ? { deliversOnlyTo: named(everywhere) }
              : { deliversTo: named(everywhere) }
            : {}),
          note: `The store has no shipping set up for ${countryName(asked)}. Say so plainly.${
            !everywhere.length
              ? " Its settings list no country it delivers to right now."
              : complete
                ? " It delivers to the countries listed here and to no others: name only these."
                : " The countries listed here are ones it does deliver to. There may be others: look again with a country to check it."
          }`,
        },
      };
    }

    const shownZones = delivering.slice(0, MAX_ZONES);
    const shownRates = shownZones.flatMap((zone) => zone.rates.slice(0, MAX_RATES));
    const there = browsing ? deliversPerSettings(rates, browsing, complete) : null;
    return {
      output: {
        ...dispatch,
        zones: shownZones.map(zoneOut),
        ...(delivering.length > MAX_ZONES ? { moreZones: delivering.length - MAX_ZONES } : {}),
        ...usualTime(shownRates),
        ...(browsing
          ? {
              shopperIsBrowsingFrom: countryName(browsing),
              ...(there === null ? {} : { deliversThere: there }),
            }
          : {}),
        note: `${
          !delivering.length
            ? "The store's settings list no delivery option for any country right now: say so, and suggest contacting the store."
            : `Each zone lists the countries it covers and what delivery to them costs. ${
                complete
                  ? "The store delivers to the countries in these zones and to no others: name only these."
                  : "A country not named may still be covered: look again with that country to be sure."
              }`
        }${usualTimeNote(shownRates)}${general}`,
      },
    };
  },
});

const getPaymentMethods = defineTool({
  name: "get_payment_methods",
  description:
    "The card brands and wallets this store's checkout takes, read from the store's checkout settings at this moment. Use it only when a shopper asks which ways of paying the store takes. It is not needed to start an order: every way of paying is chosen on the store's checkout page.",
  audiences: ["shopper"],
  schema: z.object({}),
  isAvailable: (context) => Boolean(context.storefront),
  async run(_args, context) {
    const data = await context.storefront!<{
      shop: {
        paymentSettings: {
          acceptedCardBrands: string[] | null;
          supportedDigitalWallets: string[] | null;
        } | null;
      } | null;
    }>(PAYMENT_SETTINGS_QUERY);
    const { cards, wallets } = paymentNames({
      syncedAt: null,
      cards: data.shop?.paymentSettings?.acceptedCardBrands ?? [],
      wallets: data.shop?.paymentSettings?.supportedDigitalWallets ?? [],
    });

    // Cards and wallets are all Shopify tells an app. Whatever else a store
    // takes (cash on delivery, a bank transfer) shows on its checkout page by
    // itself, so nothing here says whether it is offered, and neither may the
    // assistant.
    const elsewhere =
      " Any other way of paying, such as cash on delivery or a bank transfer, is not something Shopify tells apps about: if the shopper asks about one, say that the checkout page shows every way of paying the store offers, and do not say that it is or is not offered.";
    return {
      output: {
        cards,
        wallets,
        note:
          (cards.length || wallets.length
            ? "Read from the store's checkout settings just now. The checkout may offer more, depending on the shopper's country."
            : "Shopify lists no card brands or wallets for this store's checkout right now. Say that the checkout page shows the ways to pay; do not guess any.") +
          elsewhere,
      },
    };
  },
});

export const storeInfoTools: ToolDefinition[] = [getShippingInfo, getPaymentMethods];
