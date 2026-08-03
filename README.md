# Front Range Supply Co.

A small, working e-commerce storefront selling high-country gear out of Denver.
Browse products, build a cart, reach checkout — and find that **no payment
provider is integrated**.

That gap is deliberate. This is the "before" state: a realistic merchant
application waiting for a payments integration to be added.

Front Range Supply Co. is a fictional store. This is the Colorado-themed branch;
`before-integration` carries the same application in neutral branding.

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
| Order records + confirmation page | Works |
| **Taking payment** | **Not implemented** |
| **Verifying payment** | **Not implemented** |

The tax rate is Denver's combined state, city, RTD and CD rate. It's a flat
constant for illustration — a real store would resolve tax per destination
address.

Checkout renders an honest "no payment provider integrated" notice, plus a
clearly-labelled *Place order without payment (demo only)* button so the
storefront still has a complete happy path to show. No card is collected and no
money moves.

## The integration seam

Three places are deliberately left empty:

1. **`POST /api/create-checkout-session`** — [server.js](server.js)
   Returns `501`. Should exchange the cart total for a payment session token
   the browser can use to render a payment form.

2. **`GET /api/payment-status/:orderNumber`** — [server.js](server.js)
   Returns `501`. Should confirm server-side that the transaction actually
   settled, rather than trusting what the browser reports.

3. **`<div id="payment-container">`** — [public/checkout.html](public/checkout.html)
   The mount point for a payment form.

The client already calls all three, so wiring up the server is most of the
work. [public/app.js](public/app.js) has a branch that fires as soon as a real
session token comes back.

### Groundwork already done

The parts that are annoying to retrofit are handled:

- **Amounts are integer cents everywhere.** [lib/store.js](lib/store.js) never
  holds a float dollar value, so `order.totalCents` can go straight to a
  payment API expecting the smallest currency unit. The checkout page displays
  the exact integer next to the total.
- **Order references are 22 characters.** Providers commonly cap the
  merchant-supplied order reference near this length, and a full 36-character
  UUID would be rejected — so the id is generated short and reused rather than
  minting a second one at payment time.
- **`.env` loads at boot** via a small built-in parser, so credentials added
  later are available in `process.env` with no dependency and no source edits
  when switching environments.
- **Certificates and `.env` are gitignored** already.

## Theming

Colorado flag palette — the blue field, the red C, its gold disc — over warm
sandstone neutrals. The ridgeline along the bottom of the header is an inline
SVG data URI in [public/style.css](public/style.css); there are no image files
and no extra requests.

## Layout

```
server.js              HTTP server, static files, JSON API, integration stubs
lib/store.js           Catalog, carts, order records — all money in cents
data/products.json     Product catalog
public/
  index.html           Catalog
  cart.html            Cart
  checkout.html        Checkout — payment form mount point lives here
  confirmation.html    Order confirmation
  app.js               All page logic
  style.css            Styles
```

## Notes

This is demo software. Carts and orders live in memory and vanish on restart,
there is no authentication, and no order is ever fulfilled.
