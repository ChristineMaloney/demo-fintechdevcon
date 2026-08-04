# Switchback Systems

A small hardware storefront in Denver, Colorado. Browse the catalog, build a
cart, check out, and pay by card through the J.P. Morgan **Online Payments
API**.

```bash
npm install
node server.js
```

Then open <http://localhost:3000>. There is no build step. The one dependency
is `jsonwebtoken`, used to sign the JPM auth assertion; everything else is the
Node 18+ standard library.

Card payments need credentials. Copy `.env.example` to `.env` and fill in the
`JPM_*` values — until they are all present the storefront reports itself as
unintegrated and checkout falls back to the demo bypass, exactly as it did
before the integration. `.env` is gitignored; never commit it.

### Running against the mock endpoint

To exercise the flow without credentials, point `.env` at JPM's mock host and
turn off auth:

```
JPM_BYPASS_AUTH=true
JPM_PAYMENTS_API_URL=https://api-mock.payments.jpmorgan.com/api/v2
```

No JWT is signed and no token is fetched — requests go out unauthenticated and
the mock returns canned responses. The other `JPM_*` values are unread in this
mode and can stay as placeholders. CAT and PROD both reject unauthenticated
requests, so set `JPM_BYPASS_AUTH=false` before pointing at either; the
credentials become required again at that point.

## What works today

| Area | Status |
| --- | --- |
| Product catalog | Works — 6 products from `data/products.json` |
| Cart (add, quantity, remove) | Works — cookie session, server-side |
| Totals: subtotal, 8.81% tax, shipping | Works — free over $75 |
| Billing details collected at checkout | Works |
| Order records + confirmation page | Works |
| Charging a card | Works — JPM Online Payments, auth + capture in one step |
| Verifying payment | Works — read back from JPM, server-side |
| Refunding | Works — linked refund against the stored transaction |

## The integration

Online Payments is a direct, server-to-server API — the storefront owns the
card form and posts to `/payments` rather than mounting a hosted widget. The
card travels from the browser to this server to JPM, and nowhere else.

[lib/jpmAuth.js](lib/jpmAuth.js) signs an RS256 JWT assertion and exchanges it
for an access token, caching that token until just before JPM's stated expiry.
[lib/jpmPayments.js](lib/jpmPayments.js) is the API client and calls
`getAccessToken()` per request — cheap on a warm cache, correct on a cold one.

1. **`POST /api/payments`** — [server.js](server.js)
   Authorizes and captures in one step (`captureMethod: NOW`), then records the
   returned `transactionId` against the order. Paying the same order twice
   returns the original transaction rather than charging again.

2. **`GET /api/payment-status/:orderNumber`** — [server.js](server.js)
   Reads the transaction back from JPM. The browser's word that a payment
   settled is not evidence; this is.

3. **`POST /api/orders/:orderNumber/refund`** — [server.js](server.js)
   Linked refund against the stored transaction id. Omit `amountCents` in the
   body for a full refund. The lifecycle does not end at capture.

4. **`GET /api/payment-capabilities`** — [server.js](server.js)
   Reports `integrated: true` only when the environment actually carries enough
   to reach JPM, so a half-filled `.env` presents as unintegrated rather than
   failing at the Pay button.

[public/app.js](public/app.js) branches on that flag: it enables the card
fields and the Pay button, drops the "not integrated" notice, and removes the
demo bypass. No client change was needed.

### Money and failure

- An order moves to `paid` only on a positive capture. A decline, an ambiguous
  status, or a JPM error all leave it `unpaid` with a null `transactionId`.
- Processor error detail is logged server-side, never returned to the browser.
- A one-time purchase that does not store the card is `CARDHOLDER` /
  `NOT_STORED` / `isAmountFinal: true` — JPM message type CGEN.

### Groundwork this built on

The parts that are annoying to retrofit were already handled:

- **Amounts are integer cents everywhere.** [lib/store.js](lib/store.js) never
  holds a float dollar value, so `order.totalCents` can go straight to an API
  expecting the smallest currency unit. Checkout displays the exact integer
  next to the total.
- **Order references are 22 characters**, uppercase `A–Z0–9` only. Providers
  commonly cap the merchant-supplied order reference near this length, and a
  full 36-character UUID would be rejected — so the id is generated short and
  reused rather than minting a second one at payment time.
- **Billing address is already collected** in the shape the API wants:
  `fullName`, plus `line1` / `city` / `state` / `postalCode` / `country` under
  `customer.billingAddress`.
- **Orders are created before payment**, as `unpaid` with a null
  `transactionId` — so there is a record to attach a transaction to, and a
  status to move forward.
- **`countryCode` is sent as `USA`**, the three-letter form the API expects,
  rather than the `US` the order record stores.
- **`.env` loads at boot** via a small built-in parser, so credentials added
  later are available in `process.env` with no dependency and no source edit
  when switching environments.
- **Certificates and `.env` are gitignored** already.

## Layout

```
server.js              HTTP server, static files, JSON API, payment endpoints
lib/store.js           Catalog, carts, order records — all money in cents
lib/jpmAuth.js         JPM OAuth — signed JWT, token exchange, token cache
lib/jpmPayments.js     JPM Online Payments — authorize/capture, verify, refund
data/products.json     Product catalog
public/
  index.html           Catalog
  cart.html            Cart
  checkout.html        Checkout — billing form and card fieldset
  confirmation.html    Order confirmation
  app.js               All page logic
  style.css            Styles
```

## Notes

This is demo software. Carts and orders live in memory and vanish on restart,
there is no authentication, and no order is ever fulfilled. The 8.81% rate is
Denver's combined state + RTD + city rate, applied flat as an illustration
rather than a real per-destination tax calculation.
