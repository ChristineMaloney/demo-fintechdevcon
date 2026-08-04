// Northwind Goods frontend. One module for all four pages; each page is
// identified by <body data-page="...">. No framework, no build step.

const money = (cents) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

// ── Shared chrome ───────────────────────────────────────────────────
function paintCartLink(cart) {
  const link = document.querySelector('[data-cart-link]');
  if (link) link.textContent = `Cart (${cart.itemCount})`;
}

function paintTotals(cart, root) {
  if (!root) return;
  root.innerHTML = '';

  const rows = [
    ['Subtotal', money(cart.subtotalCents)],
    ['Tax', money(cart.taxCents)],
    [
      'Shipping',
      cart.shippingCents === 0 ? 'Free' : money(cart.shippingCents),
    ],
  ];

  for (const [label, value] of rows) {
    const row = el('div', 'row');
    row.append(el('span', null, label), el('span', null, value));
    root.append(row);
  }

  const grand = el('div', 'row grand');
  grand.append(el('span', null, 'Total'), el('span', null, money(cart.totalCents)));
  root.append(grand);
}

// ── Catalog page ────────────────────────────────────────────────────
async function initCatalog() {
  const grid = document.querySelector('[data-products]');
  const { body } = await api('/api/products');

  grid.innerHTML = '';
  for (const product of body.products) {
    const card = el('div', 'product');
    card.append(el('div', 'art', product.art));
    card.append(el('h3', null, product.name));
    card.append(el('p', 'tagline', product.tagline));

    const row = el('div', 'row');
    row.append(el('span', 'price', money(product.priceCents)));

    const add = el('button', null, 'Add to cart');
    add.addEventListener('click', async () => {
      add.disabled = true;
      add.textContent = 'Added ✓';
      const { body: cart } = await api('/api/cart', {
        method: 'POST',
        body: JSON.stringify({ sku: product.sku, qty: 1 }),
      });
      paintCartLink(cart);
      setTimeout(() => {
        add.disabled = false;
        add.textContent = 'Add to cart';
      }, 900);
    });

    row.append(add);
    card.append(row);
    grid.append(card);
  }
}

// ── Cart page ───────────────────────────────────────────────────────
async function initCart() {
  const linesRoot = document.querySelector('[data-cart-lines]');
  const summary = document.querySelector('[data-summary]');

  async function render(cart) {
    paintCartLink(cart);
    linesRoot.innerHTML = '';

    if (cart.items.length === 0) {
      summary.hidden = true;
      const empty = el('div', 'empty');
      empty.append(el('p', null, 'Your cart is empty.'));
      const link = el('a', 'btn', 'Browse the shop');
      link.href = '/';
      empty.append(link);
      linesRoot.append(empty);
      return;
    }

    summary.hidden = false;

    for (const item of cart.items) {
      const line = el('div', 'line');
      line.append(el('div', 'art', item.art));

      const info = el('div', 'info');
      info.append(el('div', 'name', item.name));
      info.append(el('div', 'unit', `${money(item.priceCents)} each`));
      line.append(info);

      const qty = el('div', 'qty');
      const dec = el('button', null, '−');
      const count = el('span', 'count', String(item.qty));
      const inc = el('button', null, '+');

      const setTo = async (next) => {
        dec.disabled = inc.disabled = true;
        const { body } = await api('/api/cart', {
          method: 'PUT',
          body: JSON.stringify({ sku: item.sku, qty: next }),
        });
        render(body);
      };

      dec.addEventListener('click', () => setTo(item.qty - 1));
      inc.addEventListener('click', () => setTo(item.qty + 1));
      qty.append(dec, count, inc);
      line.append(qty);

      line.append(el('div', 'line-total', money(item.lineTotalCents)));
      linesRoot.append(line);
    }

    paintTotals(cart, document.querySelector('[data-totals]'));
  }

  const clear = document.querySelector('[data-clear]');
  clear?.addEventListener('click', async () => {
    const { body } = await api('/api/cart', { method: 'DELETE' });
    render(body);
  });

  const { body } = await api('/api/cart');
  render(body);
}

// ── Checkout page ───────────────────────────────────────────────────
async function initCheckout() {
  const mount = document.getElementById('payment-container');
  const form = document.getElementById('billing-form');
  const linesRoot = document.querySelector('[data-cart-lines-compact]');
  const centsNote = document.querySelector('[data-cents-note]');

  const { body: cart } = await api('/api/cart');
  paintCartLink(cart);

  if (cart.items.length === 0) {
    form.hidden = true;
    mount.innerHTML = '';
    const empty = el('div', 'empty');
    empty.append(el('p', null, 'There is nothing to pay for yet.'));
    const link = el('a', 'btn', 'Browse the shop');
    link.href = '/';
    empty.append(link);
    mount.append(empty);
    return;
  }

  // Compact summary
  for (const item of cart.items) {
    const line = el('div', 'line');
    line.append(el('div', 'art', item.art));
    const info = el('div', 'info');
    info.append(el('div', 'name', item.name));
    info.append(el('div', 'unit', `Qty ${item.qty}`));
    line.append(info);
    line.append(el('div', 'line-total', money(item.lineTotalCents)));
    linesRoot.append(line);
  }
  paintTotals(cart, document.querySelector('[data-totals]'));

  // A payment API takes an integer amount in the smallest currency unit.
  // Surfacing it here makes the handoff obvious.
  centsNote.textContent = `amount → ${cart.totalCents} (${cart.currencyCode}, minor units)`;

  // ── Billing details → checkout session → Drop-in UI ───────────────
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.textContent = 'Starting checkout…';

    const f = Object.fromEntries(new FormData(form));
    const consumer = {
      email: f.email,
      billingAddress: {
        recipientFullName: f.recipientFullName,
        line1: f.line1,
        city: f.city,
        state: f.state.toUpperCase(),
        country: f.country,
        postalCode: f.postalCode,
      },
    };

    const session = await api('/api/create-checkout-session', {
      method: 'POST',
      body: JSON.stringify({ consumer }),
    });

    if (!session.ok || !session.body.checkoutSessionToken) {
      submit.disabled = false;
      submit.textContent = 'Continue to payment';
      renderCheckoutError(mount, session.body);
      return;
    }

    form.hidden = true;
    await mountDropIn(mount, session.body);
  });
}

/**
 * The Drop-in bundle loads as a module script, so `window.DropInUI` may
 * not exist yet when the shopper submits the form.
 */
function whenDropInReady(timeoutMs = 10000) {
  return new Promise((resolveReady, reject) => {
    if (window.DropInUI) return resolveReady(window.DropInUI);
    const startedAt = Date.now();
    const tick = setInterval(() => {
      if (window.DropInUI) {
        clearInterval(tick);
        resolveReady(window.DropInUI);
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(tick);
        reject(new Error('The J.P. Morgan Drop-in UI script did not load.'));
      }
    }, 50);
  });
}

async function mountDropIn(mount, { checkoutSessionToken, orderNumber }) {
  mount.innerHTML = '';
  mount.append(el('div', 'empty', 'Loading payment form…'));

  let DropInUI;
  try {
    DropInUI = await whenDropInReady();
  } catch (err) {
    renderCheckoutError(mount, { message: err.message });
    return;
  }

  const dropin = new DropInUI({ checkoutSessionToken });

  dropin.subscribe((event) => {
    if (event.message === 'MountSuccess') {
      mount.querySelector('.empty')?.remove();
      return;
    }

    if (event.message === 'PaymentSuccess') {
      // The server re-checks this against JPM's notifications API before
      // the confirmation page calls the order paid.
      dropin.unmount?.();
      location.href = `/confirmation?order=${encodeURIComponent(orderNumber)}`;
      return;
    }

    if (event.message === 'PaymentPending') {
      renderCheckoutNotice(
        mount,
        'Payment pending',
        'This payment method settles asynchronously. The confirmation page will show the final result.'
      );
      dropin.unmount?.();
      setTimeout(() => {
        location.href = `/confirmation?order=${encodeURIComponent(orderNumber)}`;
      }, 1500);
      return;
    }

    if (event.message === 'PaymentUnsuccessful') {
      // Recoverable — the form stays mounted so the shopper can retry.
      renderCheckoutNotice(
        mount,
        'Payment declined',
        'That payment was not approved. You can try a different card.',
        { prepend: true }
      );
      return;
    }

    if (event.level === 'error') {
      renderCheckoutNotice(
        mount,
        'Payment error',
        'Something went wrong processing that payment. Please try again.',
        { prepend: true }
      );
    }
  });

  dropin.mount('payment-container');
  window.addEventListener('pagehide', () => dropin.unmount?.(), { once: true });
}

function renderCheckoutNotice(mount, title, detail, { prepend = false } = {}) {
  mount.querySelector('[data-checkout-notice]')?.remove();
  const notice = el('div', 'notice');
  notice.dataset.checkoutNotice = '';
  notice.append(el('strong', null, title));
  notice.append(el('div', null, detail));
  if (prepend) mount.prepend(notice);
  else mount.append(notice);
}

function renderCheckoutError(mount, info) {
  mount.innerHTML = '';
  renderCheckoutNotice(
    mount,
    'Checkout unavailable',
    info?.message ?? 'The checkout session could not be created. Please try again.'
  );
}

// ── Confirmation page ───────────────────────────────────────────────
async function initConfirmation() {
  const sub = document.querySelector('[data-order-sub]');
  const table = document.querySelector('[data-order-details]');
  const verification = document.querySelector('[data-verification]');

  const { body: cart } = await api('/api/cart');
  paintCartLink(cart);

  const orderNumber = new URLSearchParams(location.search).get('order');
  if (!orderNumber) {
    sub.textContent = 'No order reference in the URL.';
    return;
  }

  const { ok, body: order } = await api(
    `/api/orders/${encodeURIComponent(orderNumber)}`
  );
  if (!ok) {
    sub.textContent = `Order ${orderNumber} was not found.`;
    return;
  }

  sub.textContent = `Order ${order.orderNumber}`;

  const rows = [
    ['Items', String(order.itemCount)],
    ['Subtotal', money(order.subtotalCents)],
    ['Tax', money(order.taxCents)],
    ['Shipping', order.shippingCents === 0 ? 'Free' : money(order.shippingCents)],
    ['Total', money(order.totalCents)],
    ['Placed', new Date(order.createdAt).toLocaleString()],
  ];

  for (const [label, value] of rows) {
    const tr = document.createElement('tr');
    tr.append(el('th', null, label), el('td', null, value));
    table.append(tr);
  }

  const statusRow = document.createElement('tr');
  const statusCell = el('td');
  statusCell.append(el('span', 'badge', order.paymentStatus));
  statusRow.append(el('th', null, 'Payment'), statusCell);
  table.append(statusRow);

  // Server-side verification against JPM's notifications API. The browser
  // saying "PaymentSuccess" is never proof on its own.
  const status = await api(
    `/api/payment-status/${encodeURIComponent(order.orderNumber)}`
  );

  if (!status.ok) {
    const note = el('div', 'notice');
    note.append(el('strong', null, 'Payment not verified'));
    note.append(
      el(
        'div',
        null,
        status.body?.message ??
          'The server could not confirm this transaction with J.P. Morgan.'
      )
    );
    verification.append(note);
    return;
  }

  const payment = status.body;

  if (!payment.settled) {
    const note = el('div', 'notice');
    note.append(el('strong', null, 'Awaiting confirmation'));
    note.append(
      el(
        'div',
        null,
        'J.P. Morgan has not reported this transaction yet. Notifications ' +
          'are asynchronous — refresh in a moment.'
      )
    );
    verification.append(note);
    return;
  }

  statusCell.firstChild.textContent = 'paid';

  const confirmed = el('div', 'notice');
  confirmed.append(el('strong', null, 'Payment confirmed by J.P. Morgan'));
  const details = document.createElement('table');
  details.className = 'details';

  const paymentRows = [
    ['Card', [payment.cardType, payment.maskedAccountNumber].filter(Boolean).join(' ')],
    ['Amount settled', payment.amountCents != null ? money(payment.amountCents) : null],
    ['Approval code', payment.approvalCode],
    ['Issuer response', payment.responseMessage],
    ['Fraud check', payment.fraudCheckStatus],
    ['Transaction ref', payment.transactionReference],
  ];

  for (const [label, value] of paymentRows) {
    if (!value) continue;
    const tr = document.createElement('tr');
    tr.append(el('th', null, label), el('td', null, value));
    details.append(tr);
  }

  confirmed.append(details);
  verification.append(confirmed);
}

// ── Boot ────────────────────────────────────────────────────────────
const PAGES = {
  catalog: initCatalog,
  cart: initCart,
  checkout: initCheckout,
  confirmation: initConfirmation,
};

const init = PAGES[document.body.dataset.page];
if (init) {
  init().catch((err) => {
    console.error('Page failed to initialise:', err);
  });
}
