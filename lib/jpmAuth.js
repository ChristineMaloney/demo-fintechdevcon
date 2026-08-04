// J.P. Morgan Payments — OAuth (IDAnywhere) access tokens.
//
// OAuth 2.0 client credentials with a signed JWT as the client assertion
// (RFC 7523). Call `getAccessToken()` once per outbound request; it caches
// the access token in memory and only re-exchanges when the token is within
// REFRESH_BUFFER_SEC of expiry. Do NOT sign a fresh JWT per API call.
//
// Every secret is read from the environment at runtime — nothing is inlined.

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { request } from 'undici';

// IDAnywhere token endpoint. Same URL for CAT and PROD — the environment is
// encoded in the resource_id and credentials, not the URL. Override only if
// you're pointing at a mock/stub token endpoint.
const DEFAULT_TOKEN_URL = 'https://idag2.jpmorganchase.com/adfs/oauth2/token';

// Base URL for the payments APIs themselves (not the token endpoint).
// Defaults to the mock environment; swap via env for CAT or PROD.
const DEFAULT_API_BASE_URL = 'https://api-mock.payments.jpmorgan.com';

// JWT lifetime when JPM_JWT_TTL_SEC is unset: 6 months, matching the JPM
// Bruno sample. JPM guidance for PROD is 8 hours (28800).
const DEFAULT_JWT_TTL_SEC = 15552000;

// Clock-skew cushion: refresh this many seconds before the server-set expiry.
const REFRESH_BUFFER_SEC = 30;

export const TOKEN_URL = process.env.JPM_OAUTH_TOKEN_URL || DEFAULT_TOKEN_URL;
export const API_BASE_URL = process.env.JPM_API_BASE_URL || DEFAULT_API_BASE_URL;

// { accessToken, expiresAt } — expiresAt is epoch seconds. Per-process.
let cache = null;

// In-flight exchange, so a cold cache hit by N callers does one exchange.
let inFlight = null;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

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
    throw new Error(`Missing JPM env vars: ${missing.join(', ')}. See .env.example.`);
  }

  const jwtTtlSec = ttlStr ? Number.parseInt(ttlStr, 10) : DEFAULT_JWT_TTL_SEC;
  if (!Number.isFinite(jwtTtlSec) || jwtTtlSec <= 0) {
    throw new Error(`JPM_JWT_TTL_SEC must be a positive integer (seconds), got: ${ttlStr}`);
  }

  return {
    clientId,
    keyPath,
    // IDAnywhere expects uppercase hex with no separators. Tooling often
    // emits colon-separated lowercase — normalize both away.
    thumbprint: rawThumbprint.replace(/:/g, '').trim().toUpperCase(),
    resourceId,
    jwtTtlSec,
  };
}

function buildJWT(c) {
  const iat = nowSec();
  const payload = {
    iss: c.clientId,
    sub: c.clientId,
    aud: TOKEN_URL,
    iat,
    exp: iat + c.jwtTtlSec,
    jti: `${iat}-${randomBytes(6).toString('hex')}`,
  };

  const privateKey = readFileSync(c.keyPath);
  const signingKey = process.env.JPM_KEY_PASSPHRASE
    ? { key: privateKey, passphrase: process.env.JPM_KEY_PASSPHRASE }
    : privateKey;

  return jwt.sign(payload, signingKey, {
    algorithm: 'RS256',
    header: { typ: 'JWT', alg: 'RS256', kid: c.thumbprint },
  });
}

async function exchange(assertion, c) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: c.clientId,
    resource: c.resourceId,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
  }).toString();

  const res = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = await res.body.text();
    // 400 / invalid_grant (ADFS MSIS9622) → bad JWT. Usually a wrong `kid`
    // (colons left in, lowercase, or the wrong cert) or a wrong `aud`.
    // 401 / 403 → entitlements not granted; the RM has to finish that ticket.
    throw new Error(`JPM token exchange failed (${res.statusCode}): ${text}`);
  }

  const json = await res.body.json();
  if (!json.access_token || typeof json.expires_in !== 'number') {
    throw new Error('JPM token response missing access_token or expires_in.');
  }

  // expires_in is authoritative — JPM sets it and it can change. Never hardcode.
  return { accessToken: json.access_token, expiresAt: nowSec() + json.expires_in };
}

/**
 * Returns a valid JPM access token, reusing the cached one until it is
 * within REFRESH_BUFFER_SEC of expiry.
 *
 * @returns {Promise<string>}
 */
export async function getAccessToken() {
  if (cache && cache.expiresAt - REFRESH_BUFFER_SEC > nowSec()) {
    return cache.accessToken;
  }
  if (inFlight) return inFlight;

  const c = readConfig();
  inFlight = (async () => {
    try {
      cache = await exchange(buildJWT(c), c);
      return cache.accessToken;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Drops the cached token. Mainly for tests, or after a 401 from an API call. */
export function clearTokenCache() {
  cache = null;
}

// ── Usage ────────────────────────────────────────────────────────────
//
// import { getAccessToken, API_BASE_URL } from './lib/jpmAuth.js';
// import { request } from 'undici';
//
// const token = await getAccessToken();
// const res = await request(`${API_BASE_URL}/api/v2/payments`, {
//   method: 'POST',
//   headers: {
//     authorization: `Bearer ${token}`,
//     'content-type': 'application/json',
//     'request-id': crypto.randomUUID(),
//   },
//   body: JSON.stringify({
//     // lib/store.js keeps amounts as integer cents, which is what the
//     // payments APIs expect — pass totalCents straight through.
//     amount: cart.totalCents,
//     currency: 'USD',
//   }),
// });
//
// Call getAccessToken() per request — the cache makes it nearly free.
// If an API call returns 401, call clearTokenCache() and retry once.
