// Northwind Goods — sample storefront.
//
// Zero npm dependencies: Node 18+ standard library only. `node server.js`
// and you have a working shop. No payment provider is integrated — see
// the two clearly marked stubs near the bottom of the API router.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import {
  loadCatalog,
  getCatalog,
  findProduct,
  addToCart,
  setQty,
  clearCart,
  priceCart,
  createOrder,
  getOrder,
  markOrderPaid,
} from './lib/store.js';
import {
  createCheckoutIntent,
  fetchNotifications,
  summarizeNotifications,
  describeCheckoutTarget,
  dropInUiUrl,
} from './lib/jpmCheckout.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');

// ── .env loader ──────────────────────────────────────────────────────
// Node 20.6+ has --env-file, but this keeps Node 18 working and means
// any auth module added later can just read process.env.
function loadEnv() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// ── HTTP plumbing ────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const PAGES = {
  '/': 'index.html',
  '/cart': 'cart.html',
  '/checkout': 'checkout.html',
  '/confirmation': 'confirmation.html',
};

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        reject(new Error('Body was not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ── Sessions ─────────────────────────────────────────────────────────
// One cookie, one cart. No login in this demo.
function sessionId(req, res) {
  const cookies = Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const eq = c.indexOf('=');
        return eq === -1 ? [c, ''] : [c.slice(0, eq), c.slice(eq + 1)];
      })
  );

  if (cookies.sid) return cookies.sid;

  const sid = randomUUID();
  res.setHeader(
    'Set-Cookie',
    `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
  );
  return sid;
}

// ── Static files ─────────────────────────────────────────────────────
async function serveStatic(pathname, res) {
  const target = PAGES[pathname] ?? pathname.replace(/^\/+/, '');
  const filePath = resolve(PUBLIC_DIR, target);

  // Path traversal guard: never serve outside public/.
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1><p><a href="/">Back to the shop</a></p>');
  }
}

// ── API ──────────────────────────────────────────────────────────────
async function handleApi(req, res, url) {
  const sid = sessionId(req, res);
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/products' && method === 'GET') {
    return json(res, 200, { products: getCatalog() });
  }

  if (pathname === '/api/cart' && method === 'GET') {
    return json(res, 200, priceCart(sid));
  }

  // Add to cart: { sku, qty? } — qty defaults to 1 and is additive.
  if (pathname === '/api/cart' && method === 'POST') {
    const { sku, qty = 1 } = await readBody(req);
    if (!findProduct(sku)) {
      return json(res, 400, { error: `Unknown sku: ${sku}` });
    }
    addToCart(sid, sku, Number(qty) || 1);
    return json(res, 200, priceCart(sid));
  }

  // Set an absolute quantity: { sku, qty }. qty 0 removes the line.
  if (pathname === '/api/cart' && method === 'PUT') {
    const { sku, qty } = await readBody(req);
    if (!findProduct(sku)) {
      return json(res, 400, { error: `Unknown sku: ${sku}` });
    }
    setQty(sid, sku, Number(qty) || 0);
    return json(res, 200, priceCart(sid));
  }

  if (pathname === '/api/cart' && method === 'DELETE') {
    clearCart(sid);
    return json(res, 200, priceCart(sid));
  }

  // Snapshot the cart into an order record. The returned `orderNumber`
  // is already ≤22 chars, which keeps it usable as a merchant order
  // reference — reuse it rather than minting a second id.
  if (pathname === '/api/orders' && method === 'POST') {
    const order = createOrder(sid);
    if (!order) return json(res, 400, { error: 'Cart is empty' });
    clearCart(sid);
    return json(res, 201, order);
  }

  const orderMatch = pathname.match(/^\/api\/orders\/([\w-]{1,64})$/);
  if (orderMatch && method === 'GET') {
    const order = getOrder(orderMatch[1]);
    if (!order) return json(res, 404, { error: 'No such order' });
    return json(res, 200, order);
  }

  // ══════════════════════════════════════════════════════════════════
  // J.P. Morgan Payments — Checkout (Drop-in UI)
  // ══════════════════════════════════════════════════════════════════
  //
  // Auth lives in lib/jpmAuth.js, the Checkout calls in lib/jpmCheckout.js.
  // The two endpoints below are the only places the storefront touches JPM.

  // Which Drop-in bundle the browser should load. Served rather than
  // hardcoded in the page so switching environments stays a .env change.
  if (pathname === '/api/checkout-config' && method === 'GET') {
    const { apiHost, mock } = describeCheckoutTarget();
    return json(res, 200, { dropInUiUrl: dropInUiUrl(), apiHost, mock });
  }

  // Snapshot the cart into an order, then trade that order for a
  // checkoutSessionToken. The order is created *before* payment because
  // its orderNumber (≤22 chars) is what JPM wants as merchantOrderNumber,
  // and because the confirmation page needs a record either way.
  if (pathname === '/api/create-checkout-session' && method === 'POST') {
    const { consumer } = await readBody(req);

    if (!consumer?.email || !consumer?.billingAddress?.line1) {
      return json(res, 400, {
        error: 'missing_consumer',
        message: 'Billing email and address are required to start a checkout.',
      });
    }

    const order = createOrder(sid);
    if (!order) return json(res, 400, { error: 'Cart is empty' });

    try {
      const session = await createCheckoutIntent({
        merchantOrderNumber: order.orderNumber,
        amountCents: order.totalCents,
        currencyCode: order.currencyCode,
        consumer,
      });

      // Only clear the cart once JPM has accepted the intent — a failed
      // call leaves the shopper's cart intact so they can retry.
      clearCart(sid);

      return json(res, 200, {
        checkoutSessionToken: session.checkoutSessionToken,
        orderNumber: order.orderNumber,
        amountCents: order.totalCents,
        currencyCode: order.currencyCode,
      });
    } catch (err) {
      console.error('JPM checkout intent failed:', err);
      return json(res, 502, { error: 'checkout_intent_failed', message: err.message });
    }
  }

  // Server-side proof that the payment settled. The browser's
  // PaymentSuccess event is a UI hint; this is the record we trust.
  const statusMatch = pathname.match(/^\/api\/payment-status\/([\w-]{1,64})$/);
  if (statusMatch && method === 'GET') {
    const orderNumber = statusMatch[1];
    const order = getOrder(orderNumber);
    if (!order) return json(res, 404, { error: 'No such order' });

    try {
      const summary = summarizeNotifications(await fetchNotifications(orderNumber));

      if (!summary.settled) {
        // Notifications are asynchronous — nothing yet means "not yet".
        return json(res, 200, {
          orderNumber,
          paymentStatus: order.paymentStatus,
          settled: false,
          ...summary,
        });
      }

      // Guard against a settled amount that disagrees with what we charged.
      if (summary.amountCents != null && summary.amountCents !== order.totalCents) {
        console.error(
          `Amount mismatch on ${orderNumber}: JPM ${summary.amountCents} vs order ${order.totalCents}`
        );
        return json(res, 409, {
          error: 'amount_mismatch',
          orderNumber,
          expectedCents: order.totalCents,
          settledCents: summary.amountCents,
        });
      }

      markOrderPaid(orderNumber, summary);
      return json(res, 200, { orderNumber, paymentStatus: 'paid', ...summary });
    } catch (err) {
      console.error('JPM notifications lookup failed:', err);
      return json(res, 502, { error: 'verification_failed', message: err.message });
    }
  }

  return json(res, 404, { error: `No route for ${method} ${pathname}` });
}

// ── Server ───────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      sessionId(req, res); // make sure the shopper has a cart cookie
      await serveStatic(url.pathname, res);
    }
  } catch (err) {
    console.error(`${req.method} ${url.pathname} failed:`, err);
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  }
});

loadEnv();
await loadCatalog(ROOT);

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`  Northwind Goods  →  http://localhost:${PORT}`);
  console.log(`  ${getCatalog().length} products loaded`);
  const { apiHost, authHost, mock } = describeCheckoutTarget();
  if (!mock && !process.env.JPM_MERCHANT_ID) {
    console.log('  Checkout: JPM_MERCHANT_ID not set — see .env.example');
  } else {
    console.log('  Checkout: J.P. Morgan Drop-in UI');
    console.log(`    api   → ${apiHost}`);
    console.log(`    auth  → ${authHost ?? 'none (mock takes no credentials)'}`);
    if (mock && !process.env.JPM_MERCHANT_ID) {
      console.log('    note  → using JPM sample merchantId (mock only)');
    }
  }
});
