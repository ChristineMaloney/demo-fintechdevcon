// Catalog, carts, and order records.
//
// MONEY RULE: every amount in this file is an integer number of cents.
// Nothing here ever holds a float dollar value. Payment APIs generally
// expect amounts in the smallest currency unit, so whatever provider we
// end up with can take `totalCents` as-is.

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const TAX_RATE = 0.0825;
const SHIPPING_CENTS = 599;
const FREE_SHIPPING_OVER_CENTS = 7500;
const CURRENCY = 'USD';

let catalog = [];

export async function loadCatalog(rootDir) {
  const raw = await readFile(join(rootDir, 'data', 'products.json'), 'utf8');
  catalog = JSON.parse(raw);
  return catalog;
}

export function getCatalog() {
  return catalog;
}

export function findProduct(sku) {
  return catalog.find((p) => p.sku === sku) ?? null;
}

// ── Carts ────────────────────────────────────────────────────────────
// In-memory, keyed by session cookie. Fine for a demo; swap for a real
// store if this ever outlives the demo.
const carts = new Map();

export function getCart(sid) {
  if (!carts.has(sid)) carts.set(sid, new Map());
  return carts.get(sid);
}

export function setQty(sid, sku, qty) {
  const cart = getCart(sid);
  const clamped = Math.max(0, Math.min(99, Math.floor(qty)));
  if (clamped === 0) cart.delete(sku);
  else cart.set(sku, clamped);
  return cart;
}

export function addToCart(sid, sku, qty = 1) {
  const cart = getCart(sid);
  return setQty(sid, sku, (cart.get(sku) ?? 0) + qty);
}

export function clearCart(sid) {
  carts.set(sid, new Map());
}

/**
 * Price a cart. Returns a plain object safe to send to the browser and
 * — importantly — the exact `totalCents` a payment integration needs.
 */
export function priceCart(sid) {
  const cart = getCart(sid);
  const items = [];

  for (const [sku, qty] of cart) {
    const product = findProduct(sku);
    if (!product) continue; // catalog changed under us; drop silently
    items.push({
      sku,
      name: product.name,
      art: product.art,
      priceCents: product.priceCents,
      qty,
      lineTotalCents: product.priceCents * qty,
    });
  }

  const subtotalCents = items.reduce((sum, i) => sum + i.lineTotalCents, 0);
  const taxCents = Math.round(subtotalCents * TAX_RATE);
  const shippingCents =
    subtotalCents === 0 || subtotalCents >= FREE_SHIPPING_OVER_CENTS
      ? 0
      : SHIPPING_CENTS;

  return {
    items,
    itemCount: items.reduce((n, i) => n + i.qty, 0),
    subtotalCents,
    taxCents,
    shippingCents,
    totalCents: subtotalCents + taxCents + shippingCents,
    currencyCode: CURRENCY,
    freeShippingOverCents: FREE_SHIPPING_OVER_CENTS,
  };
}

// ── Orders ───────────────────────────────────────────────────────────
// A local record of what the shopper is buying. Created before payment
// so the confirmation page has something to show. Payment state is
// tracked separately and stays 'unpaid' until something actually
// verifies it server-side.
const orders = new Map();

/**
 * Short, URL-safe order reference. Kept to 22 characters: payment
 * providers commonly cap the merchant-supplied order reference around
 * this length, and a full 36-character UUID would be rejected.
 */
export function newOrderNumber() {
  return randomUUID().replace(/-/g, '').slice(0, 22);
}

export function createOrder(sid) {
  const priced = priceCart(sid);
  if (priced.items.length === 0) return null;

  const order = {
    orderNumber: newOrderNumber(),
    createdAt: new Date().toISOString(),
    paymentStatus: 'unpaid',
    ...priced,
  };
  orders.set(order.orderNumber, order);
  return order;
}

export function getOrder(orderNumber) {
  return orders.get(orderNumber) ?? null;
}
