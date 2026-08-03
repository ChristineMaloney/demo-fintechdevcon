// Front Range Supply Co. frontend. One module for all four pages; each page is
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
  const linesRoot = document.querySelector('[data-cart-lines-compact]');
  const centsNote = document.querySelector('[data-cents-note]');

  const { body: cart } = await api('/api/cart');
  paintCartLink(cart);

  if (cart.items.length === 0) {
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

  // ── Ask the server for a checkout session ─────────────────────────
  // Today this returns 501. Once a payment provider is integrated it
  // returns a session token, and the branch below is where that
  // provider's payment form gets mounted.
  const session = await api('/api/create-checkout-session', {
    method: 'POST',
    body: JSON.stringify({ amount: cart.totalCents }),
  });

  if (session.ok && session.body.checkoutSessionToken) {
    mount.innerHTML = '';
    mount.append(
      el('div', 'empty', 'Checkout session received — mount the payment form here.')
    );
    return;
  }

  renderNotIntegrated(mount, session.body, cart);
}

function renderNotIntegrated(mount, info, cart) {
  mount.innerHTML = '';

  const notice = el('div', 'notice');
  notice.append(el('strong', null, 'No payment provider integrated yet'));
  notice.append(
    el(
      'div',
      null,
      info?.message ??
        'POST /api/create-checkout-session is still a stub, so there is no payment form to show.'
    )
  );
  mount.append(notice);

  // Demo-only escape hatch so the storefront has a complete happy path
  // before any payment provider exists. Integrating one replaces this
  // with a real payment form.
  const place = el('button', 'block', 'Place order without payment (demo only)');
  place.style.marginTop = '1.25rem';
  place.addEventListener('click', async () => {
    place.disabled = true;
    place.textContent = 'Placing order…';
    const { ok, body } = await api('/api/orders', { method: 'POST' });
    if (!ok) {
      place.disabled = false;
      place.textContent = 'Place order without payment (demo only)';
      return;
    }
    location.href = `/confirmation?order=${encodeURIComponent(body.orderNumber)}`;
  });
  mount.append(place);

  const caveat = el(
    'div',
    'cents-note',
    `No card is collected and no money moves — this only records an order for ${money(
      cart.totalCents
    )}.`
  );
  caveat.style.textAlign = 'center';
  mount.append(caveat);
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

  // Second integration seam: server-side verification. Returns 501
  // until a payment provider is integrated.
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
        'This order was recorded without taking payment. Once a payment ' +
          'provider is integrated, this panel shows the transaction as ' +
          'confirmed by the server.'
      )
    );
    verification.append(note);
  }
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
