// Switchback Systems — HTTP server.
//
// Zero dependencies: Node 18+ standard library only. No build step, no
// `npm install`. Start it with `node server.js`.
//
// The catalog, cart and order flow all work. Taking money does not — the
// payment endpoints below are stubs that return 501. See README.md.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  listProducts,
  addToCart,
  setQty,
  clearCart,
  summarise,
  createOrder,
  getOrder,
} from './lib/store.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, 'public');

// ─────────────────────────────────────────────────────────────────────
// .env
//
// Loaded at boot so credentials added later land on process.env with no
// dependency and no source edit. Real values live in .env (gitignored);
// .env.example documents the shape.
// ─────────────────────────────────────────────────────────────────────
function loadDotEnv() {
  const path = join(here, '.env');
  if (!existsSync(path)) return;

  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const PORT = Number(process.env.PORT) || 3000;

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Body is not valid JSON');
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** Cookie-backed session id. Enough to keep carts apart; not authentication. */
function sessionId(req, res) {
  const existing = parseCookies(req).sid;
  if (existing) return existing;

  const sid = randomUUID();
  res.setHeader(
    'set-cookie',
    `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
  );
  return sid;
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const target = normalize(join(PUBLIC_DIR, rel));

  // Refuse anything that escapes public/.
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');

    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

// ─────────────────────────────────────────────────────────────────────
// Server
// ─────────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;
  const method = req.method ?? 'GET';

  try {
    // ── Catalog ──────────────────────────────────────────────────────
    if (pathname === '/api/products' && method === 'GET') {
      return sendJson(res, 200, { products: listProducts() });
    }

    // ── Cart ─────────────────────────────────────────────────────────
    if (pathname === '/api/cart' && method === 'GET') {
      const sid = sessionId(req, res);
      return sendJson(res, 200, summarise(sid));
    }

    // Add to cart: { sku, qty? }. qty defaults to 1 and is additive.
    if (pathname === '/api/cart' && method === 'POST') {
      const sid = sessionId(req, res);
      const { sku, qty = 1 } = await readBody(req);
      try {
        addToCart(sid, sku, Number(qty) || 1);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
      return sendJson(res, 200, summarise(sid));
    }

    // Set an absolute quantity: { sku, qty }. qty 0 removes the line.
    if (pathname === '/api/cart' && method === 'PATCH') {
      const sid = sessionId(req, res);
      const { sku, qty } = await readBody(req);
      try {
        setQty(sid, sku, Number(qty) || 0);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
      return sendJson(res, 200, summarise(sid));
    }

    if (pathname === '/api/cart' && method === 'DELETE') {
      const sid = sessionId(req, res);
      clearCart(sid);
      return sendJson(res, 200, summarise(sid));
    }

    // ── Orders ───────────────────────────────────────────────────────
    // Creates the order record. Deliberately separate from payment: the
    // order exists as 'unpaid' first, and payment moves it forward.
    if (pathname === '/api/orders' && method === 'POST') {
      const sid = sessionId(req, res);
      const body = await readBody(req);

      const customer = {
        fullName: String(body.fullName ?? '').trim(),
        email: String(body.email ?? '').trim(),
        billingAddress: {
          line1: String(body.line1 ?? '').trim(),
          city: String(body.city ?? '').trim(),
          state: String(body.state ?? '').trim().toUpperCase(),
          postalCode: String(body.postalCode ?? '').trim(),
          country: 'US',
        },
      };

      const missing = [
        ['fullName', customer.fullName],
        ['email', customer.email],
        ['line1', customer.billingAddress.line1],
        ['city', customer.billingAddress.city],
        ['state', customer.billingAddress.state],
        ['postalCode', customer.billingAddress.postalCode],
      ]
        .filter(([, v]) => !v)
        .map(([k]) => k);

      if (missing.length) {
        return sendJson(res, 400, { error: 'Missing fields', missing });
      }

      let order;
      try {
        order = createOrder(sid, customer);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
      clearCart(sid);
      return sendJson(res, 201, order);
    }

    if (pathname.startsWith('/api/orders/') && method === 'GET') {
      const order = getOrder(pathname.slice('/api/orders/'.length));
      if (!order) return sendJson(res, 404, { error: 'Unknown order' });
      return sendJson(res, 200, order);
    }

    // ═════════════════════════════════════════════════════════════════
    // INTEGRATION SEAM — J.P. Morgan Online Payments API
    //
    // The endpoints below are the whole gap. Everything else in this
    // application is finished. The client already calls all of them.
    // ═════════════════════════════════════════════════════════════════

    // Capability flag. Not a stub — it reports the truth about the current
    // state, and the checkout page branches on it: false disables the card
    // form and shows the "not integrated" notice, true enables both.
    // An integration flips this to true once /api/payments can charge.
    if (pathname === '/api/payment-capabilities' && method === 'GET') {
      return sendJson(res, 200, {
        integrated: false,
        provider: null,
        methods: [],
      });
    }

    // SEAM 1 — Authorize and capture a card payment.
    //
    // Online Payments is a direct, server-to-server API: this storefront
    // collects the card on its own form (see public/checkout.html) and
    // posts it here. There is no hosted widget to mount.
    //
    // Should POST to {JPM_PAYMENTS_API_URL}/payments with a bearer token
    // from the auth module, sending amount (integer cents), currency,
    // merchantOrderNumber (the existing 22-char order.orderNumber),
    // paymentMethodType.card and accountHolder.billingAddress — then
    // record the returned transactionId against the order.
    if (pathname === '/api/payments' && method === 'POST') {
      return sendJson(res, 501, {
        error: 'not_integrated',
        message:
          'No payment provider is integrated, so this card cannot be charged. ' +
          'This endpoint should authorize and capture the payment ' +
          'server-side and return the resulting transaction id.',
        expectedResponse: {
          transactionId: '<processor transaction id>',
          paymentStatus: 'paid',
          orderNumber: '<=22 chars',
        },
      });
    }

    // SEAM 2 — Confirm settlement server-side.
    //
    // The browser reporting success is not evidence a payment settled.
    // Should read the transaction back from the processor and return the
    // authoritative status.
    if (pathname.startsWith('/api/payment-status/') && method === 'GET') {
      const orderNumber = pathname.slice('/api/payment-status/'.length);
      return sendJson(res, 501, {
        error: 'not_integrated',
        message:
          'No payment provider is integrated, so payment cannot be verified ' +
          'server-side. This endpoint should confirm the transaction settled ' +
          'rather than trusting anything the browser reports.',
        orderNumber,
      });
    }

    // SEAM 3 — Refund a captured payment.
    //
    // Included because the payment lifecycle does not end at capture, and
    // a storefront that can only take money is only half integrated.
    if (/^\/api\/orders\/[^/]+\/refund$/.test(pathname) && method === 'POST') {
      const orderNumber = pathname.split('/')[3];
      return sendJson(res, 501, {
        error: 'not_integrated',
        message:
          'No payment provider is integrated, so there is nothing to refund. ' +
          'This endpoint should issue a refund against the stored ' +
          'transaction id and record the result.',
        orderNumber,
      });
    }

    // ── Static files ─────────────────────────────────────────────────
    if (method === 'GET' || method === 'HEAD') {
      return await serveStatic(req, res, pathname);
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    return sendJson(res, 400, { error: err.message ?? 'Bad request' });
  }
});

server.listen(PORT, () => {
  console.log(`  Switchback Systems  →  http://localhost:${PORT}`);
  console.log(`  ${listProducts().length} products loaded`);
  console.log('  Payments: not integrated (POST /api/payments returns 501)');
});
