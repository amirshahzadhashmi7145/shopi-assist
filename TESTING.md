# Testing Shopi Assist on a development store

Dummy data and things to try. Everything here is for development stores only.

## Dummy orders

```bash
npm run seed:test-orders                # two unpaid orders
npm run seed:test-orders -- --count 3
```

- Creates unpaid orders for made-up customers and prints each order number with its email. (The chat itself places no orders: this script is the only thing that makes them.)
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

On a development store the address form (for a change of delivery address) shows a **Fill test details** button. Shopify tells the app whether a store is a development store; real stores never see the button.

## Things to say to the bot

| Feature | Say | Expect |
| --- | --- | --- |
| Find products | "What are your best sellers?" | Product cards |
| Cheapest and dearest | "What's your cheapest snowboard?", "most expensive?" | The right product, in stock |
| Add to cart | "Add the first one to my cart" | "Added to your cart" |
| Place an order | "I want to buy the [product name]" | Order summary, no extra questions |
| What's in the cart | "What's in my cart?" | The real cart contents |
| Order with old items in the cart | Add two products, then "I want to buy [a third]" | The bot says the other items are in the order too |
| Only what I asked for | "Only the [product name]" | Cart is emptied, summary shows that one item |
| Remove an item | "Remove the [product name]", or press Remove on a summary line | Summary updates |
| Empty the cart | "Clear the cart" | "Your cart is empty now." |
| Checkout | "Checkout" | Summary of the cart |
| Pay on delivery | "I want to pay cash on delivery" | The same order summary and Go to checkout button; the bot says to choose cash on delivery on the checkout page (if you picked "Offered" under Policies), and never asks for an address or takes the order itself |
| Order status | "Where is my order #1002? My email is test.buyer@example.com" | Payment and delivery status |
| Follow-up on a looked-up order | After an order status answer, "where is it?" | Answers again without asking for the email |
| Order status, number only | Tick "Let shoppers check status with the order number alone", then "status of order 1002" | Date, payment and delivery status, and an offer of tracking with email or phone |
| Order status, no email | "Order 1002, my phone is +1 202 555 0143" | Full status |
| Cancel an order | Tick "Cancel orders". "Cancel order 1002, my phone is +1 202 555 0143, I changed my mind" | A card; pressing Cancel order cancels it in admin |
| Cancel a shipped order | Mark a dummy order fulfilled in admin, then ask to cancel it | "Already being prepared or has shipped", no card |
| New address | Tick "Change the delivery address". "Change the address for order 1003" with proof | A card, then a form laid out for the order's country, with the state as a list; "Fill test details" fills it; the order shows the new address and the tag `address-changed-in-chat` |
| Missing address parts | In that form, clear State and Postal code, press Save address | Both boxes ask to be filled in |
| Change items | Tick "Change the items in an order". "Add another one to order 1003" with proof | A card listing the order after the change; pressing Confirm change updates it |
| Signed-in customer | Tick "Recognise signed-in customers", sign in on the storefront, "where is my order?" | Answers without asking for a number or email |
| Wrong email | Same order number, another email | "No order matches" |
| Return request | Mark a dummy order fulfilled in admin first, then "I want to return order #1002", email, reason | A return request in admin |

Order status and return requests must be ticked in the app's setup first.

## If the chat looks out of date

Reload the storefront page. The page asks for a new copy of the widget whenever its code changes, so a normal reload is enough. To confirm, look at the app log after sending a message: `cart=2` (or any number) means the current widget is running; `cart=-` means the browser is still on an old copy, so hard refresh once (Ctrl+Shift+R, or Cmd+Shift+R on a Mac).

## Without a store

```bash
npm run widget:preview    # http://localhost:4010, canned replies and a fake cart
npm test                  # the automated tests
```
