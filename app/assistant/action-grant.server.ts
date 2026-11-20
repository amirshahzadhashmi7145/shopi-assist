/**
 * Grants: short-lived, signed permission slips for one change to one order.
 *
 * The assistant never changes an order itself. When a shopper has proved an
 * order is theirs and asks to cancel or change it, a tool hands the widget a
 * grant. The widget shows a card with a button, and only when the shopper
 * presses it does the grant come back to the server, which checks the
 * signature and then acts. So:
 *
 *  - the model cannot cancel or change anything on its own, whatever it is
 *    told or tricked into saying;
 *  - the browser cannot name a different order or a different change, because
 *    the grant is signed with the app's secret and it has neither;
 *  - an old card stops working after a few minutes.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type OrderActionKind = "cancel" | "cancel_request" | "address" | "edit";

export interface OrderActionGrant {
  /** The shop the order belongs to. Checked against the signed request. */
  shop: string;
  /** "gid://shopify/Order/123" */
  orderId: string;
  /** "#1005" */
  orderName: string;
  kind: OrderActionKind;
  /** Why the shopper wants to cancel, in their words. */
  reason?: string;
  /** For "edit": the quantity each listed variant should end up with. */
  changes?: Array<{ variantId: string; quantity: number }>;
  /** For "address": the country the order is going to, which may not change. */
  countryCode?: string;
  /** The chat it was asked in, so that chat can be told what happened. */
  conversationId?: string;
  /** When it stops working, in milliseconds since 1970. */
  exp: number;
}

export const GRANT_LIFETIME_MS = 15 * 60 * 1000;

const encode = (value: Buffer | string) => Buffer.from(value).toString("base64url");

function signature(body: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`shopi-assist-grant.${body}`).digest();
}

/** The app's secret, or undefined when the server has none (then nothing is granted). */
export function grantSecret(): string | undefined {
  return process.env.SHOPIFY_API_SECRET || undefined;
}

export function signGrant(grant: OrderActionGrant, secret: string): string {
  const body = encode(JSON.stringify(grant));
  return `${body}.${encode(signature(body, secret))}`;
}

/**
 * The grant inside a token, or null when the token is malformed, was not
 * signed by this app, is for another shop, or has expired.
 */
export function readGrant(
  token: unknown,
  expected: { shop: string; secret: string; now: number },
): OrderActionGrant | null {
  if (typeof token !== "string" || token.length > 8000) return null;
  const [body, mac, ...rest] = token.split(".");
  if (!body || !mac || rest.length) return null;

  const given = Buffer.from(mac, "base64url");
  const wanted = signature(body, expected.secret);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;

  try {
    const grant = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OrderActionGrant;
    if (grant.shop !== expected.shop) return null;
    if (typeof grant.exp !== "number" || grant.exp <= expected.now) return null;
    if (typeof grant.orderId !== "string" || typeof grant.orderName !== "string") return null;
    return grant;
  } catch {
    return null;
  }
}
