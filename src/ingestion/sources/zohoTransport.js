// Zoho Books TRANSPORT — HTTP concerns only.
//
// This module knows about tokens, URLs, timeouts, retries and pagination.
// It knows NOTHING about invoices, financial meaning, normalization or data
// quality. Everything it returns is raw Zoho JSON.
//
// Fixes the transport defects the audit found in zohoBooksClient.js:
//   * pagination hard-stopped at 20 pages (4,000 records) and silently dropped
//     the remainder — truncation is now reported, never silent;
//   * no timeout — a hung socket held the request open indefinitely;
//   * no retry — a single transient 5xx failed the whole sync;
//   * `.catch(() => [])` on bank transactions turned an outage into
//     "everything is reconciled" (that lives in zohoSource now, and reports).

const config = require("../../config");

const DEFAULTS = Object.freeze({
  timeoutMs: 20000,
  maxRetries: 3,
  baseBackoffMs: 400,
  perPage: 200,
  // A guard against an unbounded loop if a server misreports has_more_page.
  // Unlike the old fixed cap this is reported to the caller when hit.
  maxPages: 500
});

class ZohoAuthError extends Error {
  constructor(message) { super(message); this.name = "ZohoAuthError"; this.code = "zoho_auth_failed"; this.retryable = false; }
}
class ZohoRequestError extends Error {
  constructor(message, status, retryable) {
    super(message);
    this.name = "ZohoRequestError";
    this.code = "zoho_request_failed";
    this.status = status;
    this.retryable = Boolean(retryable);
  }
}

function toNumber(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 429 and 5xx are transient; 4xx (except 429) are not. */
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}
function isRetryableNetworkError(err) {
  const code = (err && err.cause && err.cause.code) || err.code || "";
  return ["UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "UND_ERR_SOCKET"].includes(code)
    || err.name === "AbortError";
}

/**
 * Create a transport bound to one tenant's Zoho profile.
 *
 * @param {object} profile  mutated in place on token refresh (as before)
 * @param {object} opts
 *   httpFetch  injected for tests; defaults to global fetch
 *   now        injected clock
 *   timeoutMs / maxRetries / perPage / maxPages
 */
function createZohoTransport(profile, opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const httpFetch = opts.httpFetch || ((...a) => fetch(...a));
  const now = () => (opts.now == null ? Date.now() : opts.now);

  // ── Token lifecycle ───────────────────────────────────────────
  async function refreshAccessToken() {
    if (!profile.zohoRefreshToken) {
      throw new ZohoAuthError("No Zoho refresh token on file. Reconnect Zoho Books in Settings.");
    }
    const body = new URLSearchParams({
      refresh_token: profile.zohoRefreshToken,
      client_id: config.zohoOauthClientId,
      client_secret: config.zohoOauthClientSecret,
      grant_type: "refresh_token"
    });
    const res = await httpFetch(config.zohoOauthTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw new ZohoAuthError(`Could not refresh the Zoho access token (${data.error || res.status}). Reconnect Zoho Books in Settings.`);
    }
    profile.zohoApiKey = data.access_token;
    profile.zohoTokenExpiresAt = now() + toNumber(data.expires_in, 3600) * 1000;
    if (data.api_domain) profile.zohoApiDomain = data.api_domain;
    return data;
  }

  /** Refresh when absent or within 60s of expiry. */
  async function ensureFreshToken(force = false) {
    const valid = profile.zohoApiKey && profile.zohoTokenExpiresAt && now() < profile.zohoTokenExpiresAt - 60000;
    if (valid && !force) return false;
    await refreshAccessToken();
    return true;
  }

  function apiBase() {
    return `${profile.zohoApiDomain || "https://www.zohoapis.com"}/books/v3`;
  }

  // ── Single request: timeout + retry + one re-auth on 401 ──────
  async function request(path, params = {}, attempt = 1, reauthed = false) {
    await ensureFreshToken();

    const url = new URL(apiBase() + path);
    if (profile.zohoOrgId) url.searchParams.set("organization_id", profile.zohoOrgId);
    Object.entries(params).forEach(([k, v]) => {
      if (v != null && v !== "") url.searchParams.set(k, v);
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs);
    let res;
    try {
      res = await httpFetch(url.toString(), {
        headers: { authorization: `Zoho-oauthtoken ${profile.zohoApiKey}` },
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (isRetryableNetworkError(err) && attempt <= o.maxRetries) {
        await sleep(o.baseBackoffMs * Math.pow(2, attempt - 1));
        return request(path, params, attempt + 1, reauthed);
      }
      throw new ZohoRequestError(`Network failure calling ${path}: ${err.message}`, null, false);
    }
    clearTimeout(timer);

    // An expired token mid-sync: refresh once, then retry the same call.
    if (res.status === 401 && !reauthed) {
      await ensureFreshToken(true);
      return request(path, params, attempt, true);
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const retryable = isRetryableStatus(res.status);
      if (retryable && attempt <= o.maxRetries) {
        // Honour Retry-After when the server provides it.
        const retryAfter = toNumber(res.headers && res.headers.get && res.headers.get("retry-after"), 0);
        const wait = retryAfter > 0 ? retryAfter * 1000 : o.baseBackoffMs * Math.pow(2, attempt - 1);
        await sleep(wait);
        return request(path, params, attempt + 1, reauthed);
      }
      throw new ZohoRequestError(
        data.message || `Zoho Books API error (${res.status}) on ${path}`, res.status, retryable);
    }
    return data;
  }

  /**
   * Follow pagination to exhaustion.
   *
   * Returns { items, pages, truncated }. `truncated` is TRUE only if the safety
   * bound was reached while the server still reported more pages — the caller
   * must surface that rather than treating the result as complete.
   */
  async function paginate(path, listKey, params = {}) {
    const items = [];
    let page = 1;
    let truncated = false;

    for (;;) {
      const data = await request(path, Object.assign({}, params, { page, per_page: o.perPage }));
      const list = Array.isArray(data[listKey]) ? data[listKey] : [];
      items.push(...list);

      const ctx = data.page_context || {};
      if (!ctx.has_more_page) break;
      if (page >= o.maxPages) { truncated = true; break; }
      page += 1;
    }
    return { items, pages: page, truncated };
  }

  async function resolveOrganizationId() {
    if (profile.zohoOrgId) return profile.zohoOrgId;
    const data = await request("/organizations", {});
    const orgs = data.organizations || [];
    const org = orgs.find((x) => x.is_default_org) || orgs[0];
    if (!org) throw new ZohoAuthError("No Zoho Books organization is available for this account.");
    profile.zohoOrgId = org.organization_id;
    return profile.zohoOrgId;
  }

  return { request, paginate, ensureFreshToken, resolveOrganizationId, options: o };
}

module.exports = { createZohoTransport, ZohoAuthError, ZohoRequestError, DEFAULTS };
