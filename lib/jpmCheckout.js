// J.P. Morgan Payments — Checkout API (Drop-in UI).
//
// Two server-side calls back the drop-in payment form:
//
//   createCheckoutIntent()  POST /checkout/intent        → checkoutSessionToken
//   fetchNotifications()    GET  /checkout/notifications → settled transaction
//
// The browser never talks to JPM's Checkout API directly — it gets a
// checkoutSessionToken from us and hands that to the Drop-in UI bundle.
//
// Auth comes from ./jpmAuth.js. Do not fetch tokens here: getAccessToken()
// already caches one across calls, which is the whole point of it.

import { randomUUID } from 'node:crypto';
import { request } from 'undici';

import { getAccessToken, API_BASE_URL, TOKEN_URL } from './jpmAuth.js';

// Checkout API base. Defaults to the mock environment's /v1 surface.
// MOCK: https://api-mock.payments.jpmorgan.com/v1
// CAT:  https://merchant-api.checkout-cat.merchant.jpmorgan.com/v1
// PROD: https://merchant-api.checkout.merchant.jpmorgan.com/v1
const CHECKOUT_API_URL =
  process.env.JPM_CHECKOUT_API_URL || `${API_BASE_URL}/v1`;

// JPM's mock behaves like a CAT endpoint in every respect except one: it
// does not authenticate. Sending it through IDAnywhere would only mean
// failing at token exchange before the mock is ever called, so auth is
// skipped for it. Every other environment goes through getAccessToken().
const MOCK_HOST = 'api-mock.payments.jpmorgan.com';

export function isMockTarget() {
  return new URL(CHECKOUT_API_URL).hostname === MOCK_HOST;
}

// JPM caps notification lookback at 30 days. 29 keeps us off the boundary.
const NOTIFICATION_LOOKBACK_DAYS = 29;

/**
 * Request/order identifiers are capped at 22 characters by the Checkout
 * API — a full 36-char UUID is rejected with a 400.
 */
function shortId() {
  return randomUUID().replace(/-/g, '').slice(0, 22);
}

function merchantId() {
  const id = process.env.JPM_MERCHANT_ID;
  if (!id) throw new Error('Missing JPM_MERCHANT_ID. See .env.example.');
  return id;
}

/**
 * Headers every Checkout call needs. `merchantId` and `requestId` are
 * camelCase — kebab-case spellings are rejected with a 400.
 *
 * Authorization is omitted against the mock, which takes no credentials.
 */
async function checkoutHeaders() {
  const headers = {
    'content-type': 'application/json',
    merchantId: merchantId(),
    requestId: shortId(),
  };

  if (!isMockTarget()) {
    headers.authorization = `Bearer ${await getAccessToken()}`;
  }

  return headers;
}

/** Where Checkout calls go, and whether they carry a token. */
export function describeCheckoutTarget() {
  return {
    apiHost: new URL(CHECKOUT_API_URL).hostname,
    authHost: isMockTarget() ? null : new URL(TOKEN_URL).hostname,
  };
}

async function readError(res) {
  const text = await res.body.text();
  return `JPM Checkout ${res.statusCode}: ${text || '(empty response body)'}`;
}

/**
 * Creates a checkout session for one order.
 *
 * @param {object} args
 * @param {string} args.merchantOrderNumber Order reference, max 22 chars.
 * @param {number} args.amountCents Total in the smallest currency unit.
 * @param {string} args.currencyCode ISO 4217, uppercase (e.g. "USD").
 * @param {object} args.consumer `{ email, billingAddress }`.
 * @returns {Promise<{checkoutSessionToken: string, merchantOrderNumber: string}>}
 */
export async function createCheckoutIntent({
  merchantOrderNumber,
  amountCents,
  currencyCode,
  consumer,
}) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`amountCents must be a positive integer, got: ${amountCents}`);
  }
  if (merchantOrderNumber.length > 22) {
    throw new Error(`merchantOrderNumber exceeds 22 chars: ${merchantOrderNumber}`);
  }

  const payload = {
    merchantOrderNumber,
    currencyCode: currencyCode.toUpperCase(),
    // Amount stays in minor units all the way through — lib/store.js never
    // holds a float dollar value, so there is nothing to convert here.
    cart: { totalTransactionAmount: amountCents },
    consumer,
    checkoutOptions: {
      authorization: { authorizationType: 'AUTH_METHOD_CART_AMOUNT' },
      capture: { captureMethod: 'CAPTURE_METHOD_NOW' },
      consumerProfileOptions: { isSaveConsumerProfile: 'false' },
    },
  };

  const res = await request(`${CHECKOUT_API_URL}/checkout/intent`, {
    method: 'POST',
    headers: await checkoutHeaders(),
    body: JSON.stringify(payload),
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(await readError(res));
  }

  const data = await res.body.json();
  if (!data.checkoutSessionToken) {
    throw new Error('JPM Checkout intent response had no checkoutSessionToken.');
  }

  return {
    checkoutSessionToken: data.checkoutSessionToken,
    merchantOrderNumber: data.merchantOrderNumber ?? merchantOrderNumber,
  };
}

/**
 * Fetches notification messages for one order. This is the server-side
 * proof that a payment settled — a `PaymentSuccess` event in the browser
 * is a UI hint, not evidence.
 *
 * @param {string} merchantOrderNumber
 * @returns {Promise<{messages: object[]}>}
 */
export async function fetchNotifications(merchantOrderNumber) {
  const now = Date.now();
  const periodEnd = new Date(now).toISOString();
  const periodStart = new Date(
    now - NOTIFICATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const url = new URL(`${CHECKOUT_API_URL}/checkout/notifications`);
  url.searchParams.set('merchantOrderNumber', merchantOrderNumber);
  url.searchParams.set('periodStart', periodStart);
  url.searchParams.set('periodEnd', periodEnd);

  const res = await request(url, { method: 'GET', headers: await checkoutHeaders() });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(await readError(res));
  }

  return res.body.json();
}

/**
 * Reduces a notifications response to the bits the confirmation page shows.
 * Returns `{ settled: false }` when no order notification has arrived yet —
 * notifications are asynchronous, so an empty result right after payment
 * means "not yet", not "failed".
 */
export function summarizeNotifications(data) {
  const order = (data?.messages ?? [])
    .map((m) => m.orderNotification)
    .find(Boolean);

  if (!order) return { settled: false };

  const card = order.paymentMethod?.card;
  return {
    settled: order.status === 'STATUS_SUCCESS' && order.responseCode === 'APPROVED',
    status: order.status,
    responseCode: order.responseCode,
    responseMessage: order.responseMessage,
    // JPM returns the amount as a string of minor units; keep it an integer
    // so it can be compared against order.totalCents directly.
    amountCents: order.totalAmount?.amount != null
      ? Number.parseInt(order.totalAmount.amount, 10)
      : null,
    currencyCode: order.totalAmount?.currencyCode ?? null,
    maskedAccountNumber: order.paymentMethod?.maskedAccountNumber ?? null,
    cardType: card?.cardTypeName ?? null,
    approvalCode: order.paymentMethod?.approvalCode ?? null,
    transactionReference: order.transactionReference ?? null,
    fraudCheckStatus: order.fraudCheckResult?.fraudCheckStatus ?? null,
    transactionTimestamp: order.transactionTimestamp ?? null,
  };
}

export { CHECKOUT_API_URL };
