/**
 * Storefront API documents used by the shopper tools.
 *
 * Kept in their own file so `npm run graphql-codegen` can validate them
 * against the Storefront schema (everything else under app/ is validated
 * against the Admin schema). See .graphqlrc.ts.
 */

const PRODUCT_CARD_FRAGMENT = `#graphql
  fragment ShopiAssistProductCard on Product {
    id
    title
    handle
    vendor
    productType
    availableForSale
    onlineStoreUrl
    description(truncateAt: 220)
    tags
    options(first: 5) {
      name
      optionValues { name }
    }
    featuredImage {
      url(transform: { maxWidth: 480 })
      altText
    }
    priceRange {
      minVariantPrice { amount currencyCode }
      maxVariantPrice { amount currencyCode }
    }
    compareAtPriceRange {
      maxVariantPrice { amount currencyCode }
    }
    variants(first: 13) {
      nodes {
        id
        title
        availableForSale
        price { amount currencyCode }
      }
    }
  }
`;

/**
 * Keyword search, optionally narrowed by the store's own filters. The
 * filters that apply to the results come back with them, each value with the
 * input that selects it, so a second search can ask for exactly that.
 */
export const SEARCH_PRODUCTS_QUERY = `#graphql
  query ShopiAssistSearchProducts(
    $query: String!
    $first: Int!
    $filters: [ProductFilter!]
    $country: CountryCode
    $language: LanguageCode
  ) @inContext(country: $country, language: $language) {
    search(
      query: $query
      first: $first
      types: [PRODUCT]
      unavailableProducts: LAST
      productFilters: $filters
    ) {
      totalCount
      productFilters {
        label
        type
        values { label count input }
      }
      nodes {
        ... on Product { ...ShopiAssistProductCard }
      }
    }
  }
  ${PRODUCT_CARD_FRAGMENT}
`;

export const BEST_SELLERS_QUERY = `#graphql
  query ShopiAssistBestSellers(
    $first: Int!
    $country: CountryCode
    $language: LanguageCode
  ) @inContext(country: $country, language: $language) {
    products(first: $first, sortKey: BEST_SELLING) {
      nodes { ...ShopiAssistProductCard }
    }
  }
  ${PRODUCT_CARD_FRAGMENT}
`;

export const COLLECTION_BEST_SELLERS_QUERY = `#graphql
  query ShopiAssistCollectionBestSellers(
    $handle: String!
    $first: Int!
    $country: CountryCode
    $language: LanguageCode
  ) @inContext(country: $country, language: $language) {
    collection(handle: $handle) {
      title
      handle
      products(first: $first, sortKey: BEST_SELLING) {
        nodes { ...ShopiAssistProductCard }
      }
    }
  }
  ${PRODUCT_CARD_FRAGMENT}
`;

/** The products added to the store most recently, newest first. */
export const NEWEST_PRODUCTS_QUERY = `#graphql
  query ShopiAssistNewestProducts(
    $first: Int!
    $country: CountryCode
    $language: LanguageCode
  ) @inContext(country: $country, language: $language) {
    products(first: $first, sortKey: CREATED_AT, reverse: true) {
      nodes { ...ShopiAssistProductCard }
    }
  }
  ${PRODUCT_CARD_FRAGMENT}
`;

export const COLLECTION_NEWEST_QUERY = `#graphql
  query ShopiAssistCollectionNewest(
    $handle: String!
    $first: Int!
    $country: CountryCode
    $language: LanguageCode
  ) @inContext(country: $country, language: $language) {
    collection(handle: $handle) {
      title
      handle
      products(first: $first, sortKey: CREATED, reverse: true) {
        nodes { ...ShopiAssistProductCard }
      }
    }
  }
  ${PRODUCT_CARD_FRAGMENT}
`;

/** In-stock products ordered by price. `reverse` puts the dearest first. */
export const PRODUCTS_BY_PRICE_QUERY = `#graphql
  query ShopiAssistProductsByPrice(
    $first: Int!
    $reverse: Boolean!
    $country: CountryCode
    $language: LanguageCode
  ) @inContext(country: $country, language: $language) {
    products(first: $first, sortKey: PRICE, reverse: $reverse, query: "available_for_sale:true") {
      nodes { ...ShopiAssistProductCard }
    }
  }
  ${PRODUCT_CARD_FRAGMENT}
`;

export const COLLECTION_BY_PRICE_QUERY = `#graphql
  query ShopiAssistCollectionByPrice(
    $handle: String!
    $first: Int!
    $reverse: Boolean!
    $country: CountryCode
    $language: LanguageCode
  ) @inContext(country: $country, language: $language) {
    collection(handle: $handle) {
      title
      handle
      products(first: $first, sortKey: PRICE, reverse: $reverse, filters: [{ available: true }]) {
        nodes { ...ShopiAssistProductCard }
      }
    }
  }
  ${PRODUCT_CARD_FRAGMENT}
`;

/** Products matching keywords, ordered by price. */
export const SEARCH_BY_PRICE_QUERY = `#graphql
  query ShopiAssistSearchByPrice(
    $query: String!
    $first: Int!
    $reverse: Boolean!
    $country: CountryCode
    $language: LanguageCode
  ) @inContext(country: $country, language: $language) {
    search(
      query: $query
      first: $first
      types: [PRODUCT]
      sortKey: PRICE
      reverse: $reverse
      unavailableProducts: HIDE
    ) {
      nodes {
        ... on Product { ...ShopiAssistProductCard }
      }
    }
  }
  ${PRODUCT_CARD_FRAGMENT}
`;

export const PRODUCT_DETAILS_QUERY = `#graphql
  query ShopiAssistProductDetails(
    $handle: String!
    $country: CountryCode
    $language: LanguageCode
  ) @inContext(country: $country, language: $language) {
    product(handle: $handle) {
      ...ShopiAssistProductCard
      fullDescription: description(truncateAt: 1500)
      tags
      options(first: 5) {
        name
        optionValues { name }
      }
      allVariants: variants(first: 30) {
        nodes {
          id
          title
          availableForSale
          price { amount currencyCode }
          compareAtPrice { amount currencyCode }
          selectedOptions { name value }
        }
      }
    }
  }
  ${PRODUCT_CARD_FRAGMENT}
`;

export const COLLECTIONS_QUERY = `#graphql
  query ShopiAssistCollections(
    $first: Int!
    $country: CountryCode
    $language: LanguageCode
  ) @inContext(country: $country, language: $language) {
    collections(first: $first, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        title
        handle
        onlineStoreUrl
        description(truncateAt: 160)
      }
    }
  }
`;

export const SHOP_POLICIES_QUERY = `#graphql
  query ShopiAssistShopPolicies {
    shop {
      name
      shippingPolicy { title body url }
      refundPolicy { title body url }
      privacyPolicy { title body url }
      termsOfService { title body url }
    }
  }
`;

export const VARIANT_FOR_CART_QUERY = `#graphql
  query ShopiAssistVariantForCart($id: ID!) {
    node(id: $id) {
      ... on ProductVariant {
        id
        title
        availableForSale
        product { title }
      }
    }
  }
`;

/** The countries the store sells to, named in the shopper's language. */
export const DELIVERY_COUNTRIES_QUERY = `#graphql
  query ShopiAssistDeliveryCountries($language: LanguageCode)
  @inContext(language: $language) {
    localization {
      availableCountries { isoCode name }
    }
  }
`;

/**
 * A cart of its own for some of the shopper's items, to pay for at the
 * store's checkout. The cart on the storefront is left as it is.
 */
export const CHECKOUT_CART_MUTATION = `#graphql
  mutation ShopiAssistCheckoutCart($input: CartInput!, $country: CountryCode)
  @inContext(country: $country) {
    cartCreate(input: $input) {
      cart {
        checkoutUrl
        totalQuantity
      }
      userErrors { code field message }
    }
  }
`;

/** The cards and wallets the store's checkout takes. */
export const PAYMENT_SETTINGS_QUERY = `#graphql
  query ShopiAssistPaymentSettings {
    shop {
      paymentSettings {
        acceptedCardBrands
        supportedDigitalWallets
      }
    }
  }
`;

/**
 * What the store's own settings say that a visitor could find out anyway:
 * how it describes itself, where it delivers, and whether it has published a
 * refund policy and a shipping policy. Each stands in Settings where a
 * question would otherwise be asked.
 */
export const STORE_FACTS_QUERY = `#graphql
  query ShopiAssistStorefrontFacts {
    shop {
      description
      shipsToCountries
      refundPolicy { id }
      shippingPolicy { id }
    }
  }
`;

/**
 * Where the store delivers, as far as the Storefront API can say, for when
 * its shipping settings cannot be read from the Admin API or leave a doubt.
 *
 * Two lists, because neither is right on every store. `shipsToCountries` is
 * the countries with a zone in the store's shipping profiles: right on a
 * store that still uses profiles, left behind on one that has moved its
 * shipping to markets (a dev store on markets, delivering to two countries,
 * still listed one). `availableCountries` is every country in an active
 * market: where the store sells, which on a store with delivery switched off
 * for a market is more than where it delivers.
 */
export const SHIPS_TO_QUERY = `#graphql
  query ShopiAssistShipsTo {
    shop {
      shipsToCountries
    }
    localization {
      availableCountries {
        isoCode
      }
    }
  }
`;

/** Every line of an order in one request, priced for the buyer's country. */
export const VARIANTS_FOR_ORDER_QUERY = `#graphql
  query ShopiAssistVariantsForOrder($ids: [ID!]!, $country: CountryCode)
  @inContext(country: $country) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        availableForSale
        price { amount currencyCode }
        product { title }
      }
    }
  }
`;
