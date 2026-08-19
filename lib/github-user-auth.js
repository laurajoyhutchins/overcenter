import { config, db } from 'hatchable';
import { getGitHubAppIdentity } from 'lib/github-app-auth.js';

const CAPABILITY = 'github.repository.create';
const EXPECTED_LOGIN = 'laurajoyhutchins';
const API_VERSION = '2026-03-10';
const USER_AGENT = 'Hatchable-Portfolio-Control-Plane/1.0';
const WRAP_CONTEXT = 'portfolio-control-plane/github-user-token-wrap/v1\u0000';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlToBytes(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(value).length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concatBytes(...arrays) {
  const length = arrays.reduce((sum, item) => sum + item.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const item of arrays) { out.set(item, offset); offset += item.length; }
  return out;
}

function counterBytes(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

async function hmacKey(bytes) {
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function hmac(key, bytes) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
}

async function wrappingKeys(rootSecret) {
  const root = await hmacKey(encoder.encode(String(rootSecret || '')));
  const encBytes = await hmac(root, encoder.encode(`${WRAP_CONTEXT}enc`));
  const macBytes = await hmac(root, encoder.encode(`${WRAP_CONTEXT}mac`));
  return { enc: await hmacKey(encBytes), mac: await hmacKey(macBytes) };
}

async function xorHmacStream(input, key, nonce) {
  const out = new Uint8Array(input.length);
  const context = encoder.encode(`${WRAP_CONTEXT}stream\u0000`);
  for (let offset = 0, counter = 0; offset < input.length; offset += 32, counter += 1) {
    const block = await hmac(key, concatBytes(context, nonce, counterBytes(counter)));
    const take = Math.min(32, input.length - offset);
    for (let i = 0; i < take; i++) out[offset + i] = input[offset + i] ^ block[i];
  }
  return out;
}

async function sealSecret(value, rootSecret) {
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const keys = await wrappingKeys(rootSecret);
  const plaintext = encoder.encode(String(value));
  const ciphertext = await xorHmacStream(plaintext, keys.enc, nonce);
  const authenticated = concatBytes(encoder.encode(`${WRAP_CONTEXT}v2\u0000`), nonce, ciphertext);
  const tag = await hmac(keys.mac, authenticated);
  return `v2.${bytesToBase64Url(nonce)}.${bytesToBase64Url(ciphertext)}.${bytesToBase64Url(tag)}`;
}

async function openSecret(value, rootSecret) {
  const [version, nonceText, cipherText, tagText] = String(value || '').split('.');
  if (version !== 'v2' || !nonceText || !cipherText || !tagText) throw Object.assign(new Error('Stored GitHub user credential is invalid.'), { code: 'GITHUB_USER_AUTH_CONFIGURATION_ERROR' });
  try {
    const nonce = base64UrlToBytes(nonceText);
    const ciphertext = base64UrlToBytes(cipherText);
    const tag = base64UrlToBytes(tagText);
    const keys = await wrappingKeys(rootSecret);
    const authenticated = concatBytes(encoder.encode(`${WRAP_CONTEXT}v2\u0000`), nonce, ciphertext);
    const valid = await crypto.subtle.verify('HMAC', keys.mac, tag, authenticated);
    if (!valid) throw new Error('credential authentication failed');
    return decoder.decode(await xorHmacStream(ciphertext, keys.enc, nonce));
  } catch {
    throw Object.assign(new Error('Stored GitHub user credential cannot be authenticated with the current GitHub App key.'), { code: 'GITHUB_USER_AUTH_CONFIGURATION_ERROR' });
  }
}

async function rootSecret() {
  const value = await config.get('GITHUB_APP_PRIVATE_KEY');
  if (!value) throw Object.assign(new Error('GitHub App private key is required for user-token wrapping.'), { code: 'GITHUB_APP_SETUP_REQUIRED' });
  return value;
}

async function oauthForm(url, params, fetchImpl = fetch) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) if (value !== undefined && value !== null) body.set(key, String(value));
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: body.toString(),
  });
  const text = await response.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed };
}

async function githubUserRawRequest(path, { token, method = 'GET', body, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
  return { status: response.status, body: parsed, headers: Object.fromEntries(response.headers.entries()) };
}

function oauthError(body) {
  const code = String(body?.error || '');
  if (!code) return null;
  if (code === 'authorization_pending') return { ok: true, state: 'pending', retry_after_seconds: Number(body?.interval || 5) };
  if (code === 'slow_down') return { ok: true, state: 'pending', retry_after_seconds: Number(body?.interval || 10) };
  if (code === 'device_flow_disabled') return { ok: false, error: 'GITHUB_USER_AUTH_DEVICE_FLOW_DISABLED', message: 'Enable Device Flow for the Portfolio Control Plane GitHub App, then start authorization again.' };
  if (code === 'access_denied') return { ok: false, error: 'GITHUB_USER_AUTH_REQUIRED', message: 'GitHub user authorization was denied.' };
  if (code === 'expired_token' || code === 'token_expired') return { ok: false, error: 'GITHUB_USER_AUTH_REQUIRED', message: 'GitHub user authorization expired; start it again.' };
  if (code === 'bad_refresh_token') return { ok: false, error: 'GITHUB_USER_AUTH_REQUIRED', message: 'GitHub user authorization must be renewed.' };
  return { ok: false, error: 'GITHUB_USER_AUTH_ERROR', message: String(body?.error_description || body?.error || 'GitHub OAuth failed.'), oauth_error: code };
}

async function row(dbBinding = db) {
  const result = await dbBinding.query('SELECT * FROM github_user_authorizations WHERE capability = $1 LIMIT 1', [CAPABILITY]);
  return result.rows?.[0] || null;
}

function isoAfter(seconds, nowMs = Date.now()) {
  return new Date(nowMs + Math.max(0, Number(seconds || 0)) * 1000).toISOString();
}

export async function startGitHubRepositoryAuthorization(options = {}) {
  try {
    const identity = options.identity || await getGitHubAppIdentity();
    const clientId = String(identity?.client_id || '').trim();
    if (!clientId) return { ok: false, error: 'GITHUB_USER_AUTH_CONFIGURATION_ERROR', message: 'GitHub App identity did not expose a client_id.' };
    const response = await oauthForm('https://github.com/login/device/code', { client_id: clientId }, options.fetchImpl || fetch);
    const mapped = oauthError(response.body);
    if (mapped) return mapped;
    if (response.status < 200 || response.status >= 300 || !response.body?.device_code || !response.body?.user_code || !response.body?.verification_uri) {
      return { ok: false, error: 'GITHUB_USER_AUTH_ERROR', message: String(response.body?.error_description || `GitHub device authorization returned HTTP ${response.status}`) };
    }
    const secret = options.rootSecret || await rootSecret();
    const sealedDeviceCode = await sealSecret(response.body.device_code, secret);
    const expiresAt = isoAfter(response.body.expires_in, options.nowMs ?? Date.now());
    const interval = Math.max(5, Number(response.body.interval || 5));
    const dbBinding = options.db || db;
    await dbBinding.query(`INSERT INTO github_user_authorizations (
      capability, app_client_id, pending_device_code_ciphertext, pending_user_code,
      pending_verification_uri, pending_expires_at, pending_interval_seconds, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,now())
    ON CONFLICT (capability) DO UPDATE SET
      app_client_id = EXCLUDED.app_client_id,
      pending_device_code_ciphertext = EXCLUDED.pending_device_code_ciphertext,
      pending_user_code = EXCLUDED.pending_user_code,
      pending_verification_uri = EXCLUDED.pending_verification_uri,
      pending_expires_at = EXCLUDED.pending_expires_at,
      pending_interval_seconds = EXCLUDED.pending_interval_seconds,
      updated_at = now()`, [CAPABILITY, clientId, sealedDeviceCode, response.body.user_code, response.body.verification_uri, expiresAt, interval]);
    return { ok: true, state: 'authorization_required', user_code: response.body.user_code, verification_uri: response.body.verification_uri, expires_at: expiresAt, interval_seconds: interval, expected_login: EXPECTED_LOGIN };
  } catch (error) {
    return { ok: false, error: error?.code || 'GITHUB_USER_AUTH_ERROR', message: String(error?.message || error) };
  }
}

export async function completeGitHubRepositoryAuthorization(options = {}) {
  try {
    const dbBinding = options.db || db;
    const current = await row(dbBinding);
    if (!current?.pending_device_code_ciphertext) return { ok: false, error: 'GITHUB_USER_AUTH_REQUIRED', message: 'No GitHub repository authorization is pending.' };
    if (current.pending_expires_at && new Date(current.pending_expires_at).getTime() <= (options.nowMs ?? Date.now())) {
      return { ok: false, error: 'GITHUB_USER_AUTH_REQUIRED', message: 'Pending GitHub repository authorization expired; start it again.' };
    }
    const secret = options.rootSecret || await rootSecret();
    const deviceCode = await openSecret(current.pending_device_code_ciphertext, secret);
    const response = await oauthForm('https://github.com/login/oauth/access_token', {
      client_id: current.app_client_id,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }, options.fetchImpl || fetch);
    const mapped = oauthError(response.body);
    if (mapped) return { ...mapped, user_code: current.pending_user_code, verification_uri: current.pending_verification_uri, expires_at: current.pending_expires_at };
    const accessToken = String(response.body?.access_token || '');
    if (!accessToken) return { ok: false, error: 'GITHUB_USER_AUTH_ERROR', message: 'GitHub did not return a user access token.' };
    const me = await githubUserRawRequest('/user', { token: accessToken, fetchImpl: options.fetchImpl || fetch });
    if (me.status !== 200) return { ok: false, error: 'GITHUB_USER_AUTH_ERROR', message: 'GitHub user identity verification failed.', upstream_status: me.status };
    const login = String(me.body?.login || '');
    if (login.toLowerCase() !== EXPECTED_LOGIN.toLowerCase()) return { ok: false, error: 'GITHUB_USER_IDENTITY_MISMATCH', message: `Authorization belongs to ${login || 'an unknown user'}, not ${EXPECTED_LOGIN}.`, actual_login: login, expected_login: EXPECTED_LOGIN };
    const accessCiphertext = await sealSecret(accessToken, secret);
    const refreshToken = response.body?.refresh_token ? String(response.body.refresh_token) : null;
    const refreshCiphertext = refreshToken ? await sealSecret(refreshToken, secret) : null;
    const nowMs = options.nowMs ?? Date.now();
    const accessExpiresAt = response.body?.expires_in ? isoAfter(response.body.expires_in, nowMs) : null;
    const refreshExpiresAt = response.body?.refresh_token_expires_in ? isoAfter(response.body.refresh_token_expires_in, nowMs) : null;
    await dbBinding.query(`UPDATE github_user_authorizations SET
      github_login = $2, access_token_ciphertext = $3, access_token_expires_at = $4,
      refresh_token_ciphertext = $5, refresh_token_expires_at = $6,
      pending_device_code_ciphertext = NULL, pending_user_code = NULL,
      pending_verification_uri = NULL, pending_expires_at = NULL, pending_interval_seconds = NULL,
      authorized_at = now(), updated_at = now()
      WHERE capability = $1`, [CAPABILITY, login, accessCiphertext, accessExpiresAt, refreshCiphertext, refreshExpiresAt]);
    return { ok: true, state: 'authorized', github_login: login, access_token_expires_at: accessExpiresAt, refresh_token_expires_at: refreshExpiresAt };
  } catch (error) {
    return { ok: false, error: error?.code || 'GITHUB_USER_AUTH_ERROR', message: String(error?.message || error) };
  }
}

export async function githubRepositoryAuthorizationStatus(options = {}) {
  try {
    const current = await row(options.db || db);
    if (!current) return { ok: true, state: 'not_authorized', authorized: false, expected_login: EXPECTED_LOGIN };
    const nowMs = options.nowMs ?? Date.now();
    const accessValid = Boolean(current.access_token_ciphertext) && (!current.access_token_expires_at || new Date(current.access_token_expires_at).getTime() > nowMs);
    const refreshValid = Boolean(current.refresh_token_ciphertext) && (!current.refresh_token_expires_at || new Date(current.refresh_token_expires_at).getTime() > nowMs);
    const pending = Boolean(current.pending_device_code_ciphertext) && (!current.pending_expires_at || new Date(current.pending_expires_at).getTime() > nowMs);
    return {
      ok: true,
      state: accessValid || refreshValid ? 'authorized' : (pending ? 'authorization_required' : 'not_authorized'),
      authorized: accessValid || refreshValid,
      github_login: current.github_login || null,
      access_token_expires_at: current.access_token_expires_at || null,
      refresh_token_expires_at: current.refresh_token_expires_at || null,
      ...(pending ? { user_code: current.pending_user_code, verification_uri: current.pending_verification_uri, pending_expires_at: current.pending_expires_at, interval_seconds: current.pending_interval_seconds } : {}),
      expected_login: EXPECTED_LOGIN,
    };
  } catch (error) {
    return { ok: false, error: error?.code || 'GITHUB_USER_AUTH_ERROR', message: String(error?.message || error) };
  }
}

async function refreshedCredential(current, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const secret = options.rootSecret || await rootSecret();
  if (current.access_token_ciphertext && (!current.access_token_expires_at || new Date(current.access_token_expires_at).getTime() > nowMs + 120000)) {
    return { token: await openSecret(current.access_token_ciphertext, secret), row: current };
  }
  if (!current.refresh_token_ciphertext || (current.refresh_token_expires_at && new Date(current.refresh_token_expires_at).getTime() <= nowMs)) {
    throw Object.assign(new Error('GitHub repository creation authorization is required.'), { code: 'GITHUB_USER_AUTH_REQUIRED' });
  }
  const refreshToken = await openSecret(current.refresh_token_ciphertext, secret);
  const response = await oauthForm('https://github.com/login/oauth/access_token', {
    client_id: current.app_client_id,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }, options.fetchImpl || fetch);
  const mapped = oauthError(response.body);
  if (mapped?.ok === false) throw Object.assign(new Error(mapped.message), { code: mapped.error });
  const accessToken = String(response.body?.access_token || '');
  if (!accessToken) throw Object.assign(new Error('GitHub did not return a refreshed user access token.'), { code: 'GITHUB_USER_AUTH_ERROR' });
  const nextRefresh = response.body?.refresh_token ? String(response.body.refresh_token) : refreshToken;
  const accessCiphertext = await sealSecret(accessToken, secret);
  const refreshCiphertext = await sealSecret(nextRefresh, secret);
  const accessExpiresAt = response.body?.expires_in ? isoAfter(response.body.expires_in, nowMs) : null;
  const refreshExpiresAt = response.body?.refresh_token_expires_in ? isoAfter(response.body.refresh_token_expires_in, nowMs) : current.refresh_token_expires_at;
  const dbBinding = options.db || db;
  const updated = await dbBinding.query(`UPDATE github_user_authorizations SET
    access_token_ciphertext = $3, access_token_expires_at = $4,
    refresh_token_ciphertext = $5, refresh_token_expires_at = $6, updated_at = now()
    WHERE capability = $1 AND refresh_token_ciphertext = $2
    RETURNING *`, [CAPABILITY, current.refresh_token_ciphertext, accessCiphertext, accessExpiresAt, refreshCiphertext, refreshExpiresAt]);
  if (updated.rows?.[0]) return { token: accessToken, row: updated.rows[0] };
  const winner = await row(dbBinding);
  if (!winner?.access_token_ciphertext) throw Object.assign(new Error('Concurrent GitHub token refresh could not be reconciled.'), { code: 'GITHUB_USER_AUTH_ERROR' });
  return { token: await openSecret(winner.access_token_ciphertext, secret), row: winner };
}

export async function withGitHubUserApiClient(callback, options = {}) {
  const current = await row(options.db || db);
  if (!current) throw Object.assign(new Error('GitHub repository creation authorization is required.'), { code: 'GITHUB_USER_AUTH_REQUIRED' });
  const credential = await refreshedCredential(current, options);
  const fetchImpl = options.fetchImpl || fetch;
  const me = await githubUserRawRequest('/user', { token: credential.token, fetchImpl });
  if (me.status !== 200) throw Object.assign(new Error('GitHub user access token is no longer valid.'), { code: 'GITHUB_USER_AUTH_REQUIRED', status: me.status });
  const login = String(me.body?.login || '');
  if (login.toLowerCase() !== EXPECTED_LOGIN.toLowerCase()) throw Object.assign(new Error(`GitHub authorization belongs to ${login || 'an unknown user'}, not ${EXPECTED_LOGIN}.`), { code: 'GITHUB_USER_IDENTITY_MISMATCH' });
  const client = {
    async call(name, callOptions = {}) {
      if (name !== 'github') throw new Error(`GitHub user client cannot call API ${name}.`);
      return githubUserRawRequest(callOptions.path, { token: credential.token, method: callOptions.method || 'GET', body: callOptions.body, fetchImpl });
    },
  };
  return callback(client, { login, token_expires_at: credential.row?.access_token_expires_at || null });
}

export async function runGitHubUserAuthRegressionTests() {
  const results = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  async function test(name, fn) { try { await fn(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error: String(error?.message || error) }); } }
  await test('credential wrapping round-trips without plaintext persistence', async () => {
    const sealed = await sealSecret('ghu_test_secret', 'fixture-private-key');
    check(!sealed.includes('ghu_test_secret'), 'plaintext leaked into ciphertext');
    check(await openSecret(sealed, 'fixture-private-key') === 'ghu_test_secret', 'wrapped secret did not round-trip');
  });
  await test('credential wrapping fails closed under a different root key', async () => {
    const sealed = await sealSecret('ghu_test_secret', 'fixture-private-key');
    let failed = false;
    try { await openSecret(sealed, 'different-key'); } catch { failed = true; }
    check(failed, 'wrong key unexpectedly decrypted credential');
  });
  await test('device authorization pending is a non-error state', async () => {
    const mapped = oauthError({ error: 'authorization_pending', interval: 7 });
    check(mapped?.ok === true && mapped?.state === 'pending' && mapped?.retry_after_seconds === 7, 'pending response mapped incorrectly');
  });
  await test('disabled device flow fails with explicit setup code', async () => {
    const mapped = oauthError({ error: 'device_flow_disabled' });
    check(mapped?.ok === false && mapped?.error === 'GITHUB_USER_AUTH_DEVICE_FLOW_DISABLED', 'device flow setup failure mapped incorrectly');
  });
  const failed = results.filter((item) => !item.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results };
}