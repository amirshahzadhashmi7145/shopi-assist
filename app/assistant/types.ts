/**
 * Shared types for the assistant. Nothing in this file touches Shopify, the
 * database or an LLM, so it is safe to import from anywhere (including tests).
 */

/**
 * Who is on the other end of the chat. This is decided by the server route
 * that received the request, never by anything the client sends:
 *  - "shopper":  anonymous storefront visitor, reached through the app proxy.
 *  - "merchant": store staff inside the Shopify admin, authenticated by Shopify.
 */
export type Audience = "shopper" | "merchant";

export interface Money {
  amount: string;
  currencyCode: string;
}

/** A product the widget can render as a card under an assistant reply. */
export interface ProductCard {
  id: string;
  title: string;
  handle: string;
  /** Absolute online-store URL, or null when the product has no storefront page. */
  url: string | null;
  imageUrl: string | null;
  imageAlt: string | null;
  price: Money | null;
  /** Set only when the product is on sale. */
  compareAtPrice: Money | null;
  available: boolean;
  /**
   * Numeric variant id for a one-click "Add to cart". Only set when the
   * product has exactly one variant; otherwise the shopper must choose options
   * on the product page.
   */
  variantId: string | null;
}

/** One line of an order the shopper asked for in chat. */
export interface OrderItem {
  /** Numeric variant id, as used by the storefront /cart/add.js endpoint. */
  variantId: string;
  quantity: number;
  title: string;
}

/**
 * One line of the shopper's storefront cart, as their browser reported it
 * with the message. Untrusted and possibly out of date: it is shown to the
 * model as information and never used to decide what something costs.
 */
export interface CartLine {
  variantId: string;
  title: string;
  quantity: number;
}

/**
 * An order tied to the current conversation: placed through its order form,
 * or proved to be the shopper's by its number and checkout email. Recorded by
 * the server, never taken from the browser.
 */
export interface KnownOrder {
  /** "gid://shopify/Order/123" */
  id: string;
  /** "#1005" */
  name: string;
  source: "placed" | "verified";
}

/** Something the server asks the storefront widget to do in the browser. */
export type ClientAction =
  | {
      type: "add_to_cart";
      /** Numeric variant id, as used by the storefront /cart/add.js endpoint. */
      variantId: string;
      quantity: number;
      title?: string;
    }
  /** Show the shopper's cart as an order summary with a checkout button. */
  | { type: "checkout" }
  /**
   * Make sure the cart holds at least these items, then show the same order
   * summary. "At least" keeps it safe to repeat: an item already in the cart
   * is topped up to the quantity asked for, never added a second time.
   */
  | {
      type: "order";
      items: OrderItem[];
      /** Empty the cart first, so the order holds these items and nothing else. */
      replace?: boolean;
    }
  /** Take every line with this variant out of the cart. */
  | { type: "remove_from_cart"; variantId: string; title?: string }
  /** Empty the cart. */
  | { type: "clear_cart" };

/**
 * Minimal GraphQL caller. Resolves with the `data` payload and rejects on
 * transport or GraphQL errors. Tools depend on this instead of on Shopify's
 * client classes so they can be unit tested with plain functions.
 */
export type GraphqlFn = <T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
) => Promise<T>;

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
}
