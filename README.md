# Switchback Systems

A small hardware storefront in Denver, Colorado. Browse the catalog, build a
cart, reach checkout — and find that **no payment provider is integrated**.

That gap is deliberate. This is the "before" state: a realistic merchant
application waiting for the J.P. Morgan **Online Payments API** to be added.

```bash
node server.js
```

Then open <http://localhost:3000>. There is no build step and **no npm
install** — the app has zero dependencies and runs on the Node 18+ standard
library alone.

## What works today

| Area | Status |
| --- | --- |
| Product catalog | Works — 6 products from `data/products.json` |
| Cart (add, quantity, remove) | Works — cookie session, server-side |
| Totals: subtotal, 8.81% tax, shipping | Works — free over $75 |
| Billing details collected at checkout | Works |
| Order records + confirmation page | Works |
| **Charging a card** | **Not implemented** |
| **Verifying payment** | **Not implemented** |
| **Refunding** | **Not implemented** |

Checkout renders the card form with every field disabled, plus a clearly
labelled *Place order without payment (demo only)* button so the storefront
still has a complete happy path to show. No card is collected and no money
moves.

## The integration seam

Online Payments is a direct, server-to-server API — the merchant owns the card
form and posts to `/payments`, rather than mounting a hosted widget. So the
seam here is a card form plus three endpoints.

1. **`POST /api/payments`** — [server.js](server.js)
   Returns `501`. Should authorize and capture the card against
   `{JPM_PAYMENTS_API_URL}/payments` and record the returned `transactionId`.

2. **`GET /api/payment-status/:orderNumber`** — [server.js](server.js)
   Returns `501`. Should confirm server-side that the transaction actually
   settled, rather than trusting what the browser reports.

3. **`POST /api/orders/:orderNumber/refund`** — [server.js](server.js)
   Returns `501`. The lifecycle does not end at capture, and a storefront that
   can only take money is only half integrated.

Plus one flag and one form:

- **`GET /api/payment-capabilities`** returns `{ integrated: false }`. This one
  is not a stub — it reports the truth. Flipping it to `true` is what wakes the
  client up.
- **The card fieldset** in [public/checkout.html](public/checkout.html) is
  present and disabled, ready to be enabled.

[public/app.js](public/app.js) already calls all of it. The branch at
`if (caps.integrated)` enables the card fields, enables the Pay button, drops
the "not integrated" notice, and removes the demo bypass — so wiring up the
server is most of the work.

### Groundwork already done

The parts that are annoying to retrofit are handled:

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
- **`.env` loads at boot** via a small built-in parser, so credentials added
  later are available in `process.env` with no dependency and no source edit
  when switching environments.
- **Certificates and `.env` are gitignored** already.

## Layout

```
server.js              HTTP server, static files, JSON API, integration stubs
lib/store.js           Catalog, carts, order records — all money in cents
data/products.json     Product catalog
public/
  index.html           Catalog
  cart.html            Cart
  checkout.html        Checkout — billing form and the disabled card fieldset
  confirmation.html    Order confirmation
  app.js               All page logic
  style.css            Styles
```

## Notes

This is demo software. Carts and orders live in memory and vanish on restart,
there is no authentication, and no order is ever fulfilled. The 8.81% rate is
Denver's combined state + RTD + city rate, applied flat as an illustration
rather than a real per-destination tax calculation.
