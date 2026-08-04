// Switchback Systems — all page logic.
//
// One module for four pages. Each block runs only if its page's anchor
// element is present.

// ── Money ────────────────────────────────────────────────────────────
// Cents in, string out. Dollar floats never exist in this file either.
const usd = (cents) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// ── Fetch helper ─────────────────────────────────────────────────────
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// ── Toast ────────────────────────────────────────────────────────────
const toastEl = document.querySelector('[data-toast]');
let toastTimer;
function toast(message) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

// ── Shared bits ──────────────────────────────────────────────────────
function paintCartCount(totals) {
  for (const el of document.querySelectorAll('[data-cart-count]')) {
    el.textContent = totals.itemCount;
  }
}

function renderTotals(host, totals) {
  if (!host) return;
  const shipping =
    totals.shippingCents === 0
      ? totals.subtotalCents === 0
        ? '—'
        : 'Free'
      : usd(totals.shippingCents);

  host.innerHTML = `
    <div class="row"><span>Subtotal</span><span>${usd(totals.subtotalCents)}</span></div>
    <div class="row"><span>Tax (8.81%)</span><span>${usd(totals.taxCents)}</span></div>
    <div class="row"><span>Shipping</span><span>${shipping}</span></div>
    <div class="row grand"><span>Total</span><span>${usd(totals.totalCents)}</span></div>
  `;
}

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

// ═════════════════════════════════════════════════════════════════════
// Catalog
// ═════════════════════════════════════════════════════════════════════
const productsHost = document.querySelector('[data-products]');
if (productsHost) {
  const { body } = await api('/api/products');

  productsHost.innerHTML = body.products
    .map(
      (p) => `
      <article class="card">
        <div class="art">${p.art}</div>
        <div class="sku">${esc(p.sku)}</div>
        <h3>${esc(p.name)}</h3>
        <p>${esc(p.tagline)}</p>
        <div class="price">${usd(p.priceCents)}</div>
        <button class="btn-primary" data-add="${esc(p.sku)}">Add to cart</button>
      </article>`,
    )
    .join('');

  productsHost.addEventListener('click', async (event) => {
    const sku = event.target.closest('[data-add]')?.dataset.add;
    if (!sku) return;

    const { body: totals } = await api('/api/cart', {
      method: 'POST',
      body: JSON.stringify({ sku, qty: 1 }),
    });
    paintCartCount(totals);
    toast('Added to cart');
  });

  const { body: totals } = await api('/api/cart');
  paintCartCount(totals);
}

// ═════════════════════════════════════════════════════════════════════
// Cart
// ═════════════════════════════════════════════════════════════════════
const cartHost = document.querySelector('[data-cart-lines]');
if (cartHost) {
  const summaryHost = document.querySelector('[data-cart-summary]');
  const totalsHost = document.querySelector('[data-totals]');

  const paint = (totals) => {
    paintCartCount(totals);

    const free = document.querySelector('[data-free-shipping]');
    if (free) free.textContent = usd(totals.freeShippingOverCents);

    if (totals.itemCount === 0) {
      cartHost.innerHTML = `
        <div class="empty">
          <div class="art">🏔️</div>
          <p>Your cart is empty.</p>
          <a href="/"><button class="btn-ghost">Browse the catalog</button></a>
        </div>`;
      if (summaryHost) summaryHost.hidden = true;
      return;
    }

    cartHost.innerHTML = totals.items
      .map(
        (i) => `
        <div class="line">
          <div class="art">${i.art}</div>
          <div class="line-main">
            <strong>${esc(i.name)}</strong>
            <div class="sku">${esc(i.sku)} · ${usd(i.priceCents)} each</div>
          </div>
          <div class="qty">
            <button data-qty="${esc(i.sku)}" data-to="${i.qty - 1}" aria-label="Decrease">−</button>
            <span>${i.qty}</span>
            <button data-qty="${esc(i.sku)}" data-to="${i.qty + 1}" aria-label="Increase">+</button>
          </div>
          <div class="line-total">
            ${usd(i.lineTotalCents)}
            <div><button class="btn-link" data-qty="${esc(i.sku)}" data-to="0">Remove</button></div>
          </div>
        </div>`,
      )
      .join('');

    if (summaryHost) summaryHost.hidden = false;
    renderTotals(totalsHost, totals);
  };

  cartHost.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-qty]');
    if (!button) return;

    const { body: totals } = await api('/api/cart', {
      method: 'PATCH',
      body: JSON.stringify({ sku: button.dataset.qty, qty: Number(button.dataset.to) }),
    });
    paint(totals);
  });

  const { body } = await api('/api/cart');
  paint(body);
}

// ═════════════════════════════════════════════════════════════════════
// Checkout
// ═════════════════════════════════════════════════════════════════════
const form = document.querySelector('[data-checkout-form]');
if (form) {
  const linesHost = document.querySelector('[data-checkout-lines]');
  const totalsHost = document.querySelector('[data-totals]');
  const centsHost = document.querySelector('[data-total-cents]');
  const payBtn = document.querySelector('[data-pay-btn]');
  const payAmount = document.querySelector('[data-pay-amount]');
  const placeOrderBtn = document.querySelector('[data-place-order-btn]');
  const paymentFieldset = document.querySelector('[data-payment-fieldset]');

  const { body: totals } = await api('/api/cart');
  paintCartCount(totals);

  if (totals.itemCount === 0) {
    document.querySelector('main').innerHTML = `
      <div class="empty">
        <div class="art">🏔️</div>
        <p>There is nothing to check out.</p>
        <a href="/"><button class="btn-ghost">Browse the catalog</button></a>
      </div>`;
  } else {
    linesHost.innerHTML = totals.items
      .map(
        (i) => `
        <div class="line">
          <div class="art">${i.art}</div>
          <div class="line-main">
            <strong>${esc(i.name)}</strong>
            <div class="sku">${esc(i.sku)} × ${i.qty}</div>
          </div>
          <div class="line-total">${usd(i.lineTotalCents)}</div>
        </div>`,
      )
      .join('');

    renderTotals(totalsHost, totals);
    centsHost.textContent = `totalCents = ${totals.totalCents} (${totals.currencyCode})`;
    if (payAmount) payAmount.textContent = usd(totals.totalCents);

    // ── The integration branch ─────────────────────────────────────
    // Fires the moment a provider is actually wired up: card fields and
    // the Pay button come alive, and the demo-only bypass steps aside.
    const { body: caps } = await api('/api/payment-capabilities');

    if (caps.integrated) {
      for (const input of paymentFieldset.querySelectorAll('input')) {
        input.disabled = false;
        input.required = true;
      }
      payBtn.disabled = false;

      const note = paymentFieldset.querySelector('p');
      if (note) note.remove();

      const warning = document.querySelector('.notice-warn');
      if (warning) warning.remove();

      // Demo bypass is not appropriate once real payment works.
      placeOrderBtn?.remove();
      document.querySelectorAll('[data-pay-actions] p').forEach((p) => p.remove());
    }

    const collect = () => Object.fromEntries(new FormData(form).entries());

    // Creates the order record, then pays it. Order first so the 22-char
    // reference exists before the processor is told about it.
    const createOrder = async () => {
      const { ok, status, body } = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify(collect()),
      });
      if (!ok) {
        toast(
          status === 400 && body.missing
            ? `Missing: ${body.missing.join(', ')}`
            : (body.error ?? 'Could not create the order'),
        );
        return null;
      }
      return body;
    };

    // Pay: create the order, then charge it. Handles the 501 honestly.
    payBtn?.addEventListener('click', async () => {
      if (!form.reportValidity()) return;

      payBtn.disabled = true;
      const order = await createOrder();
      if (!order) {
        payBtn.disabled = false;
        return;
      }

      const fields = collect();
      const { ok, status, body } = await api('/api/payments', {
        method: 'POST',
        body: JSON.stringify({
          orderNumber: order.orderNumber,
          card: {
            accountNumber: fields.cardNumber,
            expiry: { month: Number(fields.expMonth), year: Number(fields.expYear) },
            cvv: fields.cvv,
          },
        }),
      });

      if (!ok) {
        toast(
          status === 501
            ? 'Payments are not integrated yet'
            : (body.message ?? body.error ?? 'Payment failed'),
        );
        payBtn.disabled = false;
        return;
      }

      location.href = `/confirmation.html?order=${encodeURIComponent(order.orderNumber)}`;
    });

    // Demo bypass: record the order unpaid so the flow stays complete.
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      placeOrderBtn.disabled = true;

      const order = await createOrder();
      if (!order) {
        placeOrderBtn.disabled = false;
        return;
      }
      location.href = `/confirmation.html?order=${encodeURIComponent(order.orderNumber)}`;
    });
  }
}

// ═════════════════════════════════════════════════════════════════════
// Confirmation
// ═════════════════════════════════════════════════════════════════════
const confirmationHost = document.querySelector('[data-confirmation]');
if (confirmationHost) {
  const orderNumber = new URLSearchParams(location.search).get('order');
  const { ok, body: order } = orderNumber
    ? await api(`/api/orders/${encodeURIComponent(orderNumber)}`)
    : { ok: false, body: {} };

  if (!ok) {
    confirmationHost.innerHTML = `
      <div class="empty">
        <div class="art">🧭</div>
        <p>That order could not be found.</p>
        <a href="/"><button class="btn-ghost">Back to the catalog</button></a>
      </div>`;
  } else {
    const paid = order.paymentStatus === 'paid';

    // Never trust the browser's word that a payment settled — ask the
    // server. While unintegrated this returns 501 and says so plainly.
    const { ok: verified, body: status } = await api(
      `/api/payment-status/${encodeURIComponent(order.orderNumber)}`,
    );

    const verification = verified
      ? `<div class="notice notice-ok">
           <h2>Payment verified</h2>
           <p>The processor confirms this transaction settled.</p>
         </div>`
      : `<div class="notice notice-info">
           <h2>Payment not verified</h2>
           <p>${esc(status.message ?? 'Verification is unavailable.')}</p>
         </div>`;

    confirmationHost.innerHTML = `
      <h1>Order received</h1>
      <p class="lede">
        Thanks, ${esc(order.customer.fullName.split(' ')[0] || 'friend')}. A copy
        is on its way to ${esc(order.customer.email)}.
      </p>

      ${
        paid
          ? ''
          : `<div class="notice notice-warn">
               <h2>This order is unpaid</h2>
               <p>
                 It was placed with the demo bypass because no payment provider
                 is integrated. No card was collected and no money moved.
               </p>
             </div>`
      }

      ${verification}

      <div class="split">
        <section class="panel">
          <h2>Items</h2>
          ${order.items
            .map(
              (i) => `
            <div class="line">
              <div class="art">${i.art}</div>
              <div class="line-main">
                <strong>${esc(i.name)}</strong>
                <div class="sku">${esc(i.sku)} × ${i.qty}</div>
              </div>
              <div class="line-total">${usd(i.lineTotalCents)}</div>
            </div>`,
            )
            .join('')}
          <div class="totals" data-confirm-totals></div>
        </section>

        <aside class="panel">
          <h2>Details</h2>
          <span class="pill ${paid ? 'pill-paid' : 'pill-unpaid'}">${esc(order.paymentStatus)}</span>
          <dl class="kv">
            <dt>Order</dt><dd>${esc(order.orderNumber)}</dd>
            <dt>Reference length</dt><dd>${order.orderNumber.length} chars</dd>
            <dt>Transaction</dt><dd>${order.transactionId ? esc(order.transactionId) : '—'}</dd>
            <dt>Total</dt><dd>${order.totalCents} ${esc(order.currencyCode)}</dd>
          </dl>
          <div style="margin-top: 1.25rem">
            <a href="/"><button class="btn-ghost" style="width: 100%">Keep shopping</button></a>
          </div>
        </aside>
      </div>`;

    renderTotals(document.querySelector('[data-confirm-totals]'), order);

    const { body: cart } = await api('/api/cart');
    paintCartCount(cart);
  }
}
