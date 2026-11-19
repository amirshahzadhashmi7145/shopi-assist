/**
 * What every storefront endpoint behind Shopify's app proxy does with a POST
 * before it looks at the content. The request's signature has already been
 * checked by `authenticate.public.appProxy`; the body is still untrusted input
 * from an anonymous visitor.
 */

const MAX_BODY_BYTES = 16 * 1024;
export const NO_STORE = { "Cache-Control": "no-store" };

export function errorJson(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status, headers: NO_STORE });
}

/**
 * Reads the request body but stops as soon as it exceeds `maxBytes`, so a
 * request that lies about (or omits) Content-Length cannot make the server
 * buffer an arbitrarily large body. Returns null when the limit is exceeded.
 */
async function readBodyCapped(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * The JSON object in a storefront POST, or the error response to send back.
 *
 * Only the widget should be posting to these endpoints. Another website can
 * make a visitor's browser send a "simple" cross-site POST without asking,
 * but it cannot set a JSON content type without a CORS preflight, which these
 * endpoints never approve. Browsers also label cross-site requests.
 */
export async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown> | Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return errorJson("invalid_request", "Unsupported content type.", 415);
  }
  // The content-type rule above is the real barrier. This second check only
  // refuses what the browser itself labels as coming from another site.
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return errorJson("invalid_request", "Cross-site requests are not allowed.", 403);
  }

  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return errorJson("invalid_request", "That message is too long.", 413);
  }
  const text = await readBodyCapped(request, MAX_BODY_BYTES);
  if (text === null) {
    return errorJson("invalid_request", "That message is too long.", 413);
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    return errorJson("invalid_request", "Something went wrong. Please reload the page.", 400);
  }
}

/**
 * Makes an error response readable by the widget.
 *
 * Shopify's app proxy does not pass an error response through as it is: seen
 * on a real store, a 502 with a JSON body reached the browser as something
 * the widget could not parse, so the shopper was told the store could not be
 * reached. Errors that carry a message for the shopper therefore travel as
 * HTTP 200 with `ok: false` and the real status inside the body.
 */
export async function throughProxy(response: Response): Promise<Response> {
  if (response.ok) return response;
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { error?: Record<string, unknown> } | null;
  if (!body?.error) return response;
  return Response.json(
    { ...body, ok: false, error: { ...body.error, status: response.status } },
    { status: 200, headers: NO_STORE },
  );
}

/**
 * The visitor's address as Shopify's proxy reports it. Used only as one of
 * several rate-limit keys, never for access decisions.
 */
export function clientIp(request: Request): string | undefined {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
}
