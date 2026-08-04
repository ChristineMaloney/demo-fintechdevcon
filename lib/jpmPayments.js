// J.P. Morgan Payments — Online Payments API client.
//
// Online Payments is server-to-server: this storefront collects the card on
// its own form and the card never goes anywhere except from this process to
// JPM. There is no hosted widget, which is why every function here takes raw
// card data and why none of it is reachable from the browser directly.
//
// Auth is not this module's job. getAccessToken() from ./jpmAuth.js already
// caches a token until just before JPM's stated expiry; calling it per
// request is the intended usage, not an inefficiency.

import { randomUUID } from 'node:crypto';

import { getAccessToken } from './jpmAuth.js';

// Identifies this integration to JPM in every request. Sent as merchant.merchantSoftware.
const MERCHANT_SOFTWARE = {
  companyName: 'Switchback Systems',
  productName: 'Switchback Storefront',
  version: '1.0',
};

/**
 * True when the env is configured well enough to attempt a charge. The
 * /api/payment-capabilities endpoint reports this, and the checkout page
 * enables the card form on the strength of it.
 */
export function isConfigured() {
  return Boolean(
    process.env.JPM_PAYMENTS_API_URL &&
      process.env.JPM_MERCHANT_ID &&
      process.env.JPM_CLIENT_ID &&
      process.env.JPM_PRIVATE_KEY_PATH &&
      process.env.JPM_CERT_THUMBPRINT &&
      process.env.JPM_RESOURCE_ID,
  );
}

function baseUrl() {
  const url = process.env.JPM_PAYMENTS_API_URL;
  if (!url) {
    // Deliberately no default. CAT and PROD are different hosts and guessing
    // wrong means either a dead request or a live charge in a test flow.
    throw new Error(
      'JPM_PAYMENTS_API_URL is not set. Set it to the Online Payments base ' +
        'URL for the environment you are targeting (CAT or PROD).',
    );
  }
  return url.replace(/\/+$/, '');
}

function merchantId() {
  const id = process.env.JPM_MERCHANT_ID;
  if (!id) throw new Error('JPM_MERCHANT_ID is not set.');
  return id;
}

/**
 * Thrown for any non-2xx response from JPM. Carries the HTTP status and the
 * parsed body so callers can decide what to surface to a shopper.
 */
export class JpmPaymentError extends Error {
  constructor(message, { status, body }) {
    super(message);
    this.name = 'JpmPaymentError';
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, payload) {
  const token = await getAccessToken();

  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      // request-id must be unique per request — JPM uses it for idempotency
      // and for tracing a transaction when you open a support ticket.
      'request-id': randomUUID(),
      'merchant-id': merchantId(),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    const detail =
      body?.responseStatus ??
      body?.errors?.[0]?.message ??
      body?.message ??
      res.statusText;
    throw new JpmPaymentError(`JPM ${method} ${path} failed (${res.status}): ${detail}`, {
      status: res.status,
      body,
    });
  }

  return body;
}

/**
 * Authorize and capture in one step (captureMethod NOW).
 *
 * A one-time storefront purchase where the card is not being stored, so per
 * JPM's CIT table this is CARDHOLDER / NOT_STORED / isAmountFinal true —
 * message type CGEN.
 *
 * @param {object} order   order record from lib/store.js (cents, 22-char orderNumber)
 * @param {object} card    { accountNumber, expiry: { month, year }, cvv }
 */
export async function authorizeAndCapture(order, card) {
  const { customer } = order;

  return request('POST', '/payments', {
    captureMethod: 'NOW',
    // JPM expects the smallest currency unit, which is what store.js has
    // held all along — no conversion, no float anywhere in the path.
    amount: order.totalCents,
    currency: order.currencyCode,
    merchantOrderNumber: order.orderNumber,
    merchant: { merchantSoftware: MERCHANT_SOFTWARE },
    paymentMethodType: {
      card: {
        accountNumber: String(card.accountNumber).replace(/\s/g, ''),
        expiry: {
          month: Number(card.expiry.month),
          year: Number(card.expiry.year),
        },
        cvv: String(card.cvv),
      },
    },
    accountHolder: {
      fullName: customer.fullName,
      email: customer.email,
      billingAddress: {
        line1: customer.billingAddress.line1,
        city: customer.billingAddress.city,
        state: customer.billingAddress.state,
        postalCode: customer.billingAddress.postalCode,
        countryCode: 'USA',
      },
    },
    initiatorType: 'CARDHOLDER',
    accountOnFile: 'NOT_STORED',
    isAmountFinal: true,
  });
}

/**
 * Read a transaction back from JPM. This is the authoritative answer to
 * "did it settle" — the browser's word is not evidence.
 */
export async function retrievePayment(transactionId) {
  return request('GET', `/payments/${encodeURIComponent(transactionId)}`);
}

/**
 * Refund against an existing transaction (linked refund). Omit amountCents
 * for a full refund of the original amount.
 */
export async function refundPayment(transactionId, currency, amountCents) {
  return request('POST', '/refunds', {
    merchant: { merchantSoftware: MERCHANT_SOFTWARE },
    ...(amountCents === undefined ? {} : { amount: amountCents }),
    currency,
    paymentMethodType: {
      transactionReference: { transactionReferenceId: transactionId },
    },
  });
}

/**
 * Maps a JPM transactionStatus onto the storefront's own two-state
 * paymentStatus. Anything JPM has not positively settled stays 'unpaid' —
 * an ambiguous processor answer must never read as paid.
 */
export function isSettled(jpmResponse) {
  const status = jpmResponse?.transactionStatus ?? jpmResponse?.responseStatus;
  return status === 'CAPTURED' || status === 'CLOSED' || status === 'SUCCESS';
}
