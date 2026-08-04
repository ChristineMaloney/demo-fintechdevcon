// J.P. Morgan Payments — IDAnywhere OAuth (client credentials + signed JWT).
//
// Exchanges an RS256-signed JWT assertion for an access token, then caches
// that token in memory until just before JPM's own expiry. Callers do not
// need to know any of that: call getAccessToken() once per outbound request
// and let the cache decide whether a round trip is actually needed.
//
// Nothing here is configured in source. Every credential is read from the
// environment at call time — server.js loads .env at boot, so the values
// land on process.env with no code change. See .env.example for the shape.

import { readFileSync } from 'node:fs';

import jwt from 'jsonwebtoken';

// Same endpoint for CAT and PROD. The environment distinction lives in the
// resource_id and the credentials, not the URL.
const TOKEN_URL = 'https://idag2.jpmorganchase.com/adfs/oauth2/token';

const CLIENT_ASSERTION_TYPE =
  'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

// Refresh this many seconds before the server-stated expiry, to absorb clock
// skew and request latency.
const REFRESH_BUFFER_SEC = 30;

// JWT lifetime, in seconds. 6 months — matches the JPM Bruno CAT sample.
// JPM's guidance for PROD is 8 hours (28800); override with JPM_JWT_TTL_SEC.
const DEFAULT_JWT_TTL_SEC = 15552000;

// { accessToken, expiresAt } where expiresAt is epoch seconds. Per-process and
// deliberately so — see the note at the bottom of this file.
let cache = null;

// Single in-flight exchange, shared by every caller that arrives on a cold
// cache. Without this, N concurrent checkouts would trigger N token requests.
let inFlight = null;

function readConfig() {
  const {
    JPM_CLIENT_ID: clientId,
    JPM_PRIVATE_KEY_PATH: keyPath,
    JPM_CERT_THUMBPRINT: rawThumbprint,
    JPM_RESOURCE_ID: resourceId,
    JPM_JWT_TTL_SEC: ttlStr,
  } = process.env;

  const missing = [];
  if (!clientId) missing.push('JPM_CLIENT_ID');
  if (!keyPath) missing.push('JPM_PRIVATE_KEY_PATH');
  if (!rawThumbprint) missing.push('JPM_CERT_THUMBPRINT');
  if (!resourceId) missing.push('JPM_RESOURCE_ID');
  if (missing.length) {
    throw new Error(
      `Missing JPM env vars: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill them in.',
    );
  }

  return {
    clientId,
    keyPath,
    // IDAnywhere wants the SHA-1 fingerprint as bare uppercase hex. Tooling
    // that emits E6:B8:4D:... would otherwise fail with invalid_grant.
    thumbprint: rawThumbprint.replace(/:/g, '').toUpperCase(),
    resourceId,
    jwtTtlSec: ttlStr ? Number.parseInt(ttlStr, 10) : DEFAULT_JWT_TTL_SEC,
  };
}

function buildAssertion(config) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: config.clientId,
    sub: config.clientId,
    aud: TOKEN_URL,
    iat: now,
    exp: now + config.jwtTtlSec,
    jti: `${now}-${Math.random().toString(36).slice(2, 10)}`,
  };

  // Read the key per signature rather than at import time, so rotating the
  // file on disk doesn't require a restart.
  const privateKey = readFileSync(config.keyPath);

  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    header: { typ: 'JWT', alg: 'RS256', kid: config.thumbprint },
  });
}

async function exchange(assertion, config) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    resource: config.resourceId,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: assertion,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const detail = await res.text();
    // 400/invalid_grant (ADFS MSIS9622) almost always means a bad `kid` — the
    // thumbprint still has colons, is lowercase, or names the wrong cert — or
    // a private key that doesn't pair with that cert.
    // 401/403 means entitlements were never granted; that's an RM ticket, not
    // a code bug.
    throw new Error(`JPM token exchange failed (${res.status}): ${detail}`);
  }

  const json = await res.json();
  return {
    accessToken: json.access_token,
    // expires_in is authoritative and set by JPM. Never hardcode it.
    expiresAt: Math.floor(Date.now() / 1000) + json.expires_in,
  };
}

/**
 * Returns a valid JPM access token, reusing the cached one when possible.
 *
 * @returns {Promise<string>} bearer token for the Authorization header
 */
export async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cache && cache.expiresAt - REFRESH_BUFFER_SEC > now) {
    return cache.accessToken;
  }

  if (inFlight) return inFlight;

  const config = readConfig();
  inFlight = (async () => {
    try {
      cache = await exchange(buildAssertion(config), config);
      return cache.accessToken;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Drops the cached token so the next getAccessToken() re-exchanges. Useful
 * after a 401 from a JPM API, and in tests.
 */
export function resetTokenCache() {
  cache = null;
}

// ─────────────────────────────────────────────────────────────────────
// Usage
//
//   import { getAccessToken } from './lib/jpmAuth.js';
//
//   const token = await getAccessToken();
//   const res = await fetch(
//     'https://api-ms-test.payments.jpmorgan.com/api/v2/payments',
//     {
//       method: 'POST',
//       headers: {
//         Authorization: `Bearer ${token}`,
//         'Content-Type': 'application/json',
//       },
//       body: JSON.stringify({ amount: order.totalCents, currency: 'USD' }),
//     },
//   );
//
// Call getAccessToken() per request, not per process start — it is cheap on a
// warm cache and correct on a cold one.
//
// The cache lives in module scope, so it is per Node process. Under a forked
// cluster each worker holds its own token; that is expected and needs no
// cross-process coordination.
// ─────────────────────────────────────────────────────────────────────
