/**
 * Server-side enrollment / activation funnel events for Loki.
 *
 * Product ladder (step): land → mint → verify → play → complete.
 * Domain is metadata — manage conversion by step, not by host.
 *
 * Join across domains with tokenIdHash / accountId (and optional funnel_id
 * before a Passport exists). Attribution is query / JSON body / request
 * headers only — never Set-Cookie, never document.cookie, never localStorage
 * identifiers for stitching. Privacy policy: API does not use cookies;
 * do not plant cookies (or cookie-like identifiers) without prior user
 * permission / consent. Plausible is optional on marketing sites only and
 * must stay cookieless (or gated behind consent); it is not required for
 * stitching and must not be loaded on this API / verify UI.
 */

const crypto = require("crypto");

let _logger;
function getLogger() {
  if (!_logger) {
    _logger = require("@rodit/rodit-auth-be").logger;
  }
  return _logger;
}

/** Primary conversion steps — chart these adjacent ratios. */
const STEPS = Object.freeze({
  LAND: "land",
  MINT: "mint",
  VERIFY: "verify",
  PLAY: "play",
  COMPLETE: "complete"
});

/** Canonical event names for the product ladder (home + sibling surfaces). */
const EVENTS = Object.freeze({
  LAND: "funnel.land",
  MINT_ATTEMPT: "funnel.mint_attempt",
  MINT_SUCCESS: "funnel.mint_success",
  MINT_FAILED: "funnel.mint_failed",
  VERIFY_RESULT: "funnel.verify_result",
  PLAY: "funnel.play",
  COMPLETE: "funnel.complete",
  // Supporting / mid-funnel (not adjacent ladder rungs)
  DISCOVERY: "funnel.discovery",
  MCP_RESOURCE: "funnel.mcp_resource",
  LOGIN_CHALLENGE: "funnel.login_challenge",
  LOGIN_RESULT: "funnel.login_result",
  IDENTITY_CONFIRMED: "funnel.identity_confirmed"
});

/** Default domain for emitters in this repo (api.lastcradle.io). */
const DEFAULT_DOMAIN = "api.lastcradle.io";

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];

/**
 * Pre-Passport hop stitch — land surfaces mint this and forward it on links /
 * API calls. Must remain a URL/body/header param — never persist in a cookie
 * without explicit user permission.
 */
const FUNNEL_ID_KEYS = ["funnel_id", "vid"];

const CAMPAIGN_HEADER_MAP = {
  "x-campaign-source": "utm_source",
  "x-campaign-medium": "utm_medium",
  "x-campaign-campaign": "utm_campaign",
  "x-campaign-content": "utm_content",
  "x-campaign-term": "utm_term",
  "x-utm-source": "utm_source",
  "x-utm-medium": "utm_medium",
  "x-utm-campaign": "utm_campaign",
  "x-utm-content": "utm_content",
  "x-utm-term": "utm_term",
  "x-funnel-id": "funnel_id",
  "x-visitor-id": "funnel_id"
};

const ACCOUNT_ID_BODY_KEYS = [
  "accountid",
  "account_id",
  "accountId",
  "owneraccount_id",
  "owner_id",
  "implicit_account_id"
];

/**
 * SHA-256 hex truncated for join keys without logging raw Passport ids in funnel fields.
 * @param {string|null|undefined} tokenId
 * @returns {string|null}
 */
function hashTokenId(tokenId) {
  if (typeof tokenId !== "string" || !tokenId.trim()) {
    return null;
  }
  return crypto.createHash("sha256").update(tokenId.trim()).digest("hex").slice(0, 16);
}

function pickString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Resolve NEAR account id from common purchase / login body field names.
 * @param {import('express').Request|null|undefined} req
 * @returns {string|null}
 */
function resolveAccountId(req) {
  if (!req || !req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return null;
  }
  for (const key of ACCOUNT_ID_BODY_KEYS) {
    const value = pickString(req.body[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

/**
 * Collect optional attribution from query, JSON body, or X-Campaign-* / X-Utm-* / X-Funnel-Id headers.
 * Purchase portal and lastcradle can forward UTMs + funnel_id without cross-domain cookies.
 * @param {import('express').Request} req
 * @returns {Record<string, string>}
 */
function extractAttribution(req) {
  const attribution = {};
  const query = req.query && typeof req.query === "object" ? req.query : {};
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};

  for (const key of UTM_KEYS) {
    const fromQuery = pickString(query[key]);
    const fromBody = pickString(body[key]);
    if (fromQuery) {
      attribution[key] = fromQuery;
    } else if (fromBody) {
      attribution[key] = fromBody;
    }
  }

  for (const key of FUNNEL_ID_KEYS) {
    const fromQuery = pickString(query[key]);
    const fromBody = pickString(body[key]);
    if (fromQuery || fromBody) {
      attribution.funnel_id = fromQuery || fromBody;
      break;
    }
  }

  if (typeof req.get === "function") {
    for (const [headerName, attrKey] of Object.entries(CAMPAIGN_HEADER_MAP)) {
      if (attribution[attrKey]) {
        continue;
      }
      const headerValue = pickString(req.get(headerName));
      if (headerValue) {
        attribution[attrKey] = headerValue;
      }
    }
  }

  return attribution;
}

/**
 * Append attribution query params to a funnel URL (UTMs + optional funnel_id).
 * Skips empty values; does not overwrite existing query keys.
 * @param {string} baseUrl
 * @param {Record<string, string|null|undefined>} attribution
 * @returns {string}
 */
function appendAttribution(baseUrl, attribution = {}) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return baseUrl;
  }
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  const keys = [...UTM_KEYS, "funnel_id"];
  for (const key of keys) {
    const value = pickString(attribution[key]);
    if (value && !url.searchParams.has(key)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

/**
 * Emit a structured funnel event to Winston (and Loki when configured).
 * @param {string} event - e.g. funnel.discovery, funnel.mint_success, funnel.play
 * @param {object} [props]
 * @param {string} [props.step] - land | mint | verify | play | complete
 * @param {string} [props.stage] - legacy stage label (kept for existing LogQL)
 * @param {string} [props.domain] - emitting surface host (default api.lastcradle.io)
 * @param {string} [props.path]
 * @param {string} [props.uri]
 * @param {string} [props.result] - success | failed | attempt | error
 * @param {string|number} [props.errorCode]
 * @param {string} [props.tokenId] - hashed before log
 * @param {string} [props.accountId]
 * @param {string} [props.requestId]
 * @param {number} [props.durationMs]
 * @param {import('express').Request} [props.req] - used for attribution + requestId / accountId fallback
 * @param {Record<string, unknown>} [props.extra]
 */
function track(event, props = {}) {
  if (typeof event !== "string" || !event) {
    return;
  }

  const {
    step = null,
    stage = null,
    domain = DEFAULT_DOMAIN,
    path = null,
    uri = null,
    result = null,
    errorCode = null,
    tokenId = null,
    accountId = null,
    requestId = null,
    durationMs = null,
    req = null,
    extra = null
  } = props;

  const attribution = req ? extractAttribution(req) : {};
  const resolvedRequestId =
    requestId ||
    (req && req.requestId) ||
    null;
  const resolvedAccountId = pickString(accountId) || (req ? resolveAccountId(req) : null);

  const fields = {
    event,
    funnel: true,
    step,
    stage,
    domain: pickString(domain) || DEFAULT_DOMAIN,
    path,
    uri,
    result,
    errorCode: errorCode != null ? String(errorCode) : null,
    tokenIdHash: hashTokenId(tokenId),
    accountId: resolvedAccountId,
    requestId: resolvedRequestId,
    durationMs: typeof durationMs === "number" ? durationMs : null,
    ...attribution
  };

  if (extra && typeof extra === "object") {
    Object.assign(fields, extra);
  }

  // Drop null/undefined so Loki labels stay compact
  const cleaned = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined && value !== "") {
      cleaned[key] = value;
    }
  }

  const logger = getLogger();
  logger.infoWithContext(`funnel:${event}`, {
    component: "Funnel",
    method: "track",
    ...cleaned
  });

  if (typeof logger.metric === "function") {
    const metricTags = {
      operation: event,
      result: cleaned.result || "recorded"
    };
    if (cleaned.step) {
      metricTags.step = cleaned.step;
    }
    if (cleaned.stage) {
      metricTags.stage = cleaned.stage;
    }
    if (cleaned.domain) {
      metricTags.domain = cleaned.domain;
    }
    if (cleaned.uri) {
      metricTags.uri = cleaned.uri;
    }
    if (cleaned.errorCode) {
      metricTags.errorCode = cleaned.errorCode;
    }
    logger.metric(event, typeof durationMs === "number" ? durationMs : 1, metricTags);
  }
}

module.exports = {
  track,
  hashTokenId,
  extractAttribution,
  appendAttribution,
  resolveAccountId,
  UTM_KEYS,
  FUNNEL_ID_KEYS,
  STEPS,
  EVENTS,
  DEFAULT_DOMAIN
};
