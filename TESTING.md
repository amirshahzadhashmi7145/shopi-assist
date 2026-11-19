# Testing Shopi Assist on a development store

Dummy data and things to try. Everything here is for development stores only.

## Dummy orders

```bash
npm run seed:test-orders                # two unpaid orders
npm run seed:test-orders -- --count 3
```

- Creates pay-on-delivery orders for made-up customers and prints each order number with its email.
- Refuses to run on a store that is not a development store.
- Needs a United States shipping zone and protected customer data access (Dev Dashboard, your app, Settings, Access requests).
- Clean up: in Shopify admin, filter orders by the tag `shopi-assist-test`.

## Dummy customers

| Name | Email | Phone | Address |
| --- | --- | --- | --- |
| Test Buyer | test.buyer@example.com | +1 202 555 0143 | 742 Evergreen Terrace, Springfield, IL 62704, US |
| Sam Sample | sam.sample@example.com | +1 202 555 0178 | 350 Fifth Avenue, New York, NY 10118, US |
| Dana Demo | dana.demo@example.com | +1 202 555 0112 | 1600 Amphitheatre Parkway, Mountain View, CA 94043, US |

The emails end in example.com, so nothing reaches a real inbox.

## Test mode in the chat

On a development store the order form shows a **Fill test details** button, and the limits on orders per visitor and per phone number are 50 times looser. Shopify tells the app whether a store is a development store; real stores never see the button.

## Things to say to the bot

| Feature | Say | Expect |
| --- | --- | --- |
| Find products | "What are your best sellers?" | Product cards |
| Add to cart | "Add the first one to my cart" | "Added to your cart" |
| Place an order | "I want to buy the [product name]" | Order summary, no extra questions |
| Remove an item | Press Remove on a summary line | Summary updates |
| Checkout | "Checkout" | Summary of the cart |
| Pay on delivery | Press "Order here, pay on delivery", then "Fill test details" | Order number, order is unpaid in admin |
| Missing address parts | Clear State and Postal code, press Review order | Both boxes ask to be filled in |
| Order status | "Where is my order #1002? My email is test.buyer@example.com" | Payment and delivery status |
| Wrong email | Same order number, another email | "No order matches" |
| Return request | Mark a dummy order fulfilled in admin first, then "I want to return order #1002", email, reason | A return request in admin |

Order status and return requests must be ticked in the app's setup first.

## Without a store

```bash
npm run widget:preview    # http://localhost:4010, canned replies and a fake cart
npm test                  # the automated tests
```
