// Catalog, carts and order records for Switchback Systems.
//
// Money rule for this whole file: every amount is an integer number of cents.
// No float dollar value is ever stored or computed. Payment APIs expect the
// smallest currency unit, so `order.totalCents` can be sent as-is.

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export const CURRENCY_CODE = 'USD';

// Denver's combined state + RTD + city rate. Illustrative only — a real
// storefront resolves tax per destination address, not per storefront.
export const TAX_RATE_BPS = 881; // basis points, i.e. 8.81%

export const FREE_SHIPPING_OVER_CENTS = 7500;
export const SHIPPING_FLAT_CENTS = 795;

const catalog = JSON.parse(
  readFileSync(join(here, '..', 'data', 'products.json'), 'utf8'),
);
const bySku = new Map(catalog.map((p) => [p.sku, p]));

// In-memory and deliberately so: this is demo software. Everything is lost on
// restart, which is fine — no order is ever fulfilled.
const carts = new Map(); // sessionId -> Map<sku, qty>
const orders = new Map(); // orderNumber -> order

export function listProducts() {
  return catalog;
}

export function getProduct(sku) {
  return bySku.get(sku) ?? null;
}

function cartFor(sessionId) {
  let cart = carts.get(sessionId);
  if (!cart) {
    cart = new Map();
    carts.set(sessionId, cart);
  }
  return cart;
}

export function addToCart(sessionId, sku, qty = 1) {
  if (!bySku.has(sku)) throw new Error(`Unknown sku: ${sku}`);
  const cart = cartFor(sessionId);
  const next = (cart.get(sku) ?? 0) + qty;
  if (next <= 0) cart.delete(sku);
  else cart.set(sku, Math.min(next, 99));
}

export function setQty(sessionId, sku, qty) {
  if (!bySku.has(sku)) throw new Error(`Unknown sku: ${sku}`);
  const cart = cartFor(sessionId);
  if (qty <= 0) cart.delete(sku);
  else cart.set(sku, Math.min(qty, 99));
}

export function clearCart(sessionId) {
  carts.delete(sessionId);
}

/** Cart contents priced out. All totals are integer cents. */
export function summarise(sessionId) {
  const cart = cartFor(sessionId);

  const items = [...cart.entries()].map(([sku, qty]) => {
    const p = bySku.get(sku);
    return {
      sku,
      name: p.name,
      art: p.art,
      priceCents: p.priceCents,
      qty,
      lineTotalCents: p.priceCents * qty,
    };
  });

  const subtotalCents = items.reduce((sum, i) => sum + i.lineTotalCents, 0);
  const taxCents = Math.round((subtotalCents * TAX_RATE_BPS) / 10_000);
  const shippingCents =
    subtotalCents === 0 || subtotalCents >= FREE_SHIPPING_OVER_CENTS
      ? 0
      : SHIPPING_FLAT_CENTS;

  return {
    items,
    itemCount: items.reduce((n, i) => n + i.qty, 0),
    subtotalCents,
    taxCents,
    shippingCents,
    totalCents: subtotalCents + taxCents + shippingCents,
    currencyCode: CURRENCY_CODE,
    freeShippingOverCents: FREE_SHIPPING_OVER_CENTS,
  };
}

/**
 * Order references are capped at 22 characters.
 *
 * Payment providers commonly cap the merchant-supplied order reference around
 * this length — a full 36-character UUID gets rejected. Generating it short
 * here means the same reference is reused at payment time rather than minting
 * a second one, so the storefront and the processor agree on one id.
 *
 * Uppercase A–Z and 0–9 only, to stay clear of any charset restriction.
 */
export function newOrderNumber() {
  const hex = randomUUID().replace(/-/g, '').toUpperCase();
  return ('SWB' + hex).slice(0, 22);
}

export function createOrder(sessionId, customer) {
  const totals = summarise(sessionId);
  if (totals.itemCount === 0) throw new Error('Cart is empty');

  const order = {
    orderNumber: newOrderNumber(),
    createdAt: new Date().toISOString(),

    // No payment provider is integrated, so nothing can move this off
    // 'unpaid'. Once one is, this reflects what the processor reported.
    paymentStatus: 'unpaid',
    transactionId: null,

    customer,
    ...totals,
  };

  orders.set(order.orderNumber, order);
  return order;
}

export function getOrder(orderNumber) {
  return orders.get(orderNumber) ?? null;
}

/**
 * Records that the processor captured this order, and the transaction id it
 * gave back. That id is the only handle a later refund has, so an order
 * cannot be marked paid without one.
 */
export function markPaid(orderNumber, transactionId) {
  const order = orders.get(orderNumber);
  if (!order) throw new Error('Unknown order');
  if (!transactionId) throw new Error('markPaid requires a transactionId');

  order.paymentStatus = 'paid';
  order.transactionId = transactionId;
  return order;
}

export function markRefunded(orderNumber, refundTransactionId) {
  const order = orders.get(orderNumber);
  if (!order) throw new Error('Unknown order');

  order.paymentStatus = 'refunded';
  order.refundTransactionId = refundTransactionId ?? null;
  return order;
}
