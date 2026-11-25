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
  processingText,
  rateCost,
  zonesFor,
  type ShippingRate,
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
  ...(rate.conditions.length ? { appliesTo: rate.conditions.join(" and ") } : {}),
  ...(rate.description ? { details: rate.description } : {}),
});

/** Country names, alphabetical, cut off with a count when there are many. */
function named(codes: readonly string[], max = MAX_COUNTRIES): string[] {
  const names = codes.map(countryName).sort((a, b) => a.localeCompare(b));
  return names.length <= max ? names : [...names.slice(0, max), `and ${names.length - max} more`];
}

const zoneOut = (zone: ShippingZone) => ({
  countries: named(zone.countries, 15),
  ...(zone.restOfWorld ? { alsoEveryCountryNotNamedInAnotherZone: true } : {}),
  rates: zone.rates.slice(0, MAX_RATES).map(rateOut),
});

/** The countries the store has a shipping zone for, asked of the Storefront API now. */
async function shipsToNow(context: ToolContext): Promise<string[] | null> {
  if (!context.storefront) return null;
  try {
    const data = await context.storefront<{ shop: { shipsToCountries: string[] | null } | null }>(
      SHIPS_TO_QUERY,
    );
    return (data.shop?.shipsToCountries ?? []).filter((code) => /^[A-Z]{2}$/.test(code));
  } catch {
    return null;
  }
}

const getShippingInfo = defineTool({
  name: "get_shipping_info",
  description:
    "Everything about delivery, read from the store's own shipping settings at this moment: which countries it delivers to, what delivery costs and how soon orders are sent out. Use it before answering any question about delivery or shipping, even if you looked earlier in the chat. Give the country the shopper means as a two-letter ISO code (for example 'CA' for Canada); leave it out to get every delivery zone.",
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
    // How soon orders leave, where the store has set that in Shopify.
    const dispatch =
      rates.processingDays === undefined
        ? {}
        : { dispatch: `Orders are handed to the carrier ${processingText(rates.processingDays)}.` };

    if (rates.state !== "live" || rates.zones.length === 0) {
      // The rates cannot be read. Where the store delivers still can be, and
      // what the store owner picked or wrote is the best there is for the rest.
      const shipsTo = await shipsToNow(context);
      const knowsCountries = shipsTo !== null && shipsTo.length > 0;
      const code = asked ?? browsing;
      const owner = [context.shippingPicks, context.shippingNote].filter(Boolean).join("\n");
      return {
        output: {
          ratesAvailable: false,
          ...dispatch,
          ...(code ? { country: countryName(code) } : {}),
          ...(code && knowsCountries ? { delivers: shipsTo.includes(code) } : {}),
          ...(!code && knowsCountries ? { deliversTo: named(shipsTo) } : {}),
          ...(owner ? { fromTheStoreOwner: owner } : {}),
          note: `The store's shipping rates could not be read from its settings just now.${
            owner
              ? " Use what the store owner says above."
              : " Say that the checkout shows the exact delivery cost before payment."
          } Never guess a price or a delivery country.${
            !asked && code
              ? " No country was named, so this is for the country the shopper is browsing the store from: say which country it is for."
              : ""
          }`,
        },
      };
    }

    const everywhereElse = rates.zones.some((zone) => zone.restOfWorld);
    const general =
      " These are the store's general rates, read from its shipping settings just now: they are what the store does today. A rate marked 'calculated at checkout' is priced for the shopper's own address, and the checkout always shows the final cost before payment." +
      (rates.otherProfiles
        ? " Some products have shipping rates of their own, which the checkout shows."
        : "") +
      (rates.truncated ? " The store has more delivery zones than are listed here." : "");
    if (asked) {
      const zones = zonesFor(rates, asked);
      if (!zones.length) {
        const everywhere = [...new Set(rates.zones.flatMap((zone) => zone.countries))];
        return {
          output: {
            country: countryName(asked),
            delivers: false,
            deliversOnlyTo: named(everywhere),
            note: `The store has no shipping set up for ${countryName(asked)}. Say so plainly. It delivers to the countries listed here and to no others: name only these.`,
          },
        };
      }
      return {
        output: {
          country: countryName(asked),
          delivers: true,
          ...dispatch,
          rates: zones.flatMap((zone) => zone.rates).slice(0, MAX_RATES).map(rateOut),
          note: `Give these rates as they are, each with what it applies to.${general}`,
        },
      };
    }

    return {
      output: {
        ...dispatch,
        zones: rates.zones.slice(0, MAX_ZONES).map(zoneOut),
        ...(rates.zones.length > MAX_ZONES ? { moreZones: rates.zones.length - MAX_ZONES } : {}),
        ...(browsing
          ? {
              shopperIsBrowsingFrom: countryName(browsing),
              deliversThere: zonesFor(rates, browsing).length > 0,
            }
          : {}),
        note: `Each zone lists the countries it covers and what delivery to them costs. ${
          everywhereElse || rates.truncated
            ? "A country not named may still be covered: look again with that country to be sure."
            : "The store delivers to the countries in these zones and to no others: name only these."
        }${general}`,
      },
    };
  },
});

const COD_ANSWERS = {
  chat: "offered: the shopper can place the order in this chat and pay when it arrives",
  yes: "offered at checkout",
  no: "not offered",
} as const;

const getPaymentMethods = defineTool({
  name: "get_payment_methods",
  description:
    "How shoppers can pay at this store, read from the store's checkout settings at this moment: card brands, wallets, and whether cash on delivery is offered. Use it every time a shopper asks how they can pay.",
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
    const cod = context.settings.cashOnDelivery;

    return {
      output: {
        cards,
        wallets,
        cashOnDelivery: cod ? COD_ANSWERS[cod] : "not known: the store has not said",
        note:
          cards.length || wallets.length
            ? "Read from the store's checkout settings just now. The checkout may offer more, depending on the shopper's country."
            : "Shopify lists no card brands or wallets for this store's checkout right now. Say that the checkout shows the ways to pay; do not guess any.",
      },
    };
  },
});

export const storeInfoTools: ToolDefinition[] = [getShippingInfo, getPaymentMethods];
