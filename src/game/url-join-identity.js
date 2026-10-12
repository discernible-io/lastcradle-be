/**
 * Non-passport URL join: mint synthetic peer identity + rodit-auth-be JWT,
 * persist webhook URL, and satisfy JWT renewal chain lookups for guest_* ids.
 */

const dns = require("dns").promises;
const net = require("net");
const nacl = require("tweetnacl");
const { ulid } = require("ulid");
const {
  RoditClient,
  blockchainService,
  generate_jwt_token,
  stateManager,
  utils
} = require("@rodit/rodit-auth-be");
const repo = require("./repository");
const { isUrlJoinRoditId, normalizeRoditId } = require("./rodit-id");
const { WEBHOOK_URL_MAX_LEN } = require("./input-limits");

const sdkClient = new RoditClient();
const logger = sdkClient.getLogger();

/**
 * Guest JWT TTL for join-by-url: generous wall-clock for a long casual game
 * (55 × 9 min turns ≈ 8.25h) plus a 10-minute buffer.
 */
const GUEST_JWT_DURATION_SECONDS = String(55 * 9 * 60 + 10 * 60);
const GUEST_MAX_REQUESTS = "100000";
const GUEST_MAXRQ_WINDOW = "3600";
/** ~10 years from join — session/credential caps still apply via server config. */
const GUEST_VALIDITY_YEARS = 10;

let chainLookupWrapped = false;
const ORIGINAL_TOKEN_LOOKUP = blockchainService.nearorg_rpc_tokenfromroditid.bind(blockchainService);

function ensureChainLookupWrapped() {
  if (chainLookupWrapped) {
    return;
  }
  blockchainService.nearorg_rpc_tokenfromroditid = async function urlJoinAwareTokenLookup(roditid) {
    const normalized = normalizeRoditId(roditid);
    if (isUrlJoinRoditId(normalized)) {
      const peer = await loadSyntheticPeerRodit(normalized);
      if (peer?.token_id) {
        return peer;
      }
      return new blockchainService.RODiT();
    }
    return ORIGINAL_TOKEN_LOOKUP(roditid);
  };
  chainLookupWrapped = true;
}

function invalidWebhookUrl(message) {
  const err = new Error(message);
  err.code = "INVALID_WEBHOOK_URL";
  err.statusCode = 400;
  return err;
}

/**
 * Reject loopback / RFC1918 / link-local / ULA / CGNAT / cloud-metadata destinations.
 * Self-signed TLS for public webhook hosts remains allowed (WEBHOOK_TLS_SKIP_VERIFY).
 */
function isBlockedIpAddress(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const parts = ip.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (version === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === "::" || normalized === "::1") return true;
    // IPv4-mapped IPv6 (:ffff:x.x.x.x)
    const mapped = normalized.match(/:ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isBlockedIpAddress(mapped[1]);
    // Expand first hextet for prefix checks (link-local fe80::/10, ULA fc00::/7, multicast ff00::/8)
    const first = normalized.split(":")[0] || "";
    const firstVal = Number.parseInt(first, 16);
    if (Number.isFinite(firstVal)) {
      if ((firstVal & 0xffc0) === 0xfe80) return true; // fe80::/10
      if ((firstVal & 0xfe00) === 0xfc00) return true; // fc00::/7
      if ((firstVal & 0xff00) === 0xff00) return true; // ff00::/8
    }
    return false;
  }
  return true;
}

function isBlockedHostname(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "metadata.google.internal" || host.endsWith(".metadata.google.internal")) {
    return true;
  }
  if (host === "metadata" || host.endsWith(".internal")) return true;
  if (net.isIP(host)) return isBlockedIpAddress(host);
  return false;
}

function validateWebhookUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw invalidWebhookUrl("webhookUrl is required");
  }
  const trimmed = raw.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw invalidWebhookUrl("webhookUrl must be an absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw invalidWebhookUrl("webhookUrl must use http or https");
  }
  if (trimmed.length > WEBHOOK_URL_MAX_LEN) {
    throw invalidWebhookUrl("webhookUrl is too long");
  }
  if (parsed.username || parsed.password) {
    throw invalidWebhookUrl("webhookUrl must not contain userinfo");
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw invalidWebhookUrl("webhookUrl must not target a private, loopback, or metadata host");
  }
  return trimmed;
}

async function assertWebhookUrlResolvesPublic(rawUrl) {
  const parsed = new URL(rawUrl);
  const hostname = String(parsed.hostname || "").replace(/^\[|\]$/g, "");
  if (net.isIP(hostname)) {
    if (isBlockedIpAddress(hostname)) {
      throw invalidWebhookUrl("webhookUrl must not target a private, loopback, or metadata host");
    }
    return;
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw invalidWebhookUrl("webhookUrl hostname could not be resolved");
  }
  if (!records.length) {
    throw invalidWebhookUrl("webhookUrl hostname could not be resolved");
  }
  for (const record of records) {
    if (isBlockedIpAddress(record.address)) {
      throw invalidWebhookUrl("webhookUrl must not resolve to a private, loopback, or metadata address");
    }
  }
}

function isoYearsFromNow(years) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString();
}

function isoNow() {
  return new Date().toISOString();
}

function toPrivateKeyBytes(key) {
  if (key instanceof Uint8Array) {
    return key;
  }
  if (Buffer.isBuffer(key)) {
    return new Uint8Array(key);
  }
  if (Array.isArray(key) || (key && typeof key.length === "number")) {
    return new Uint8Array(Array.from(key));
  }
  throw new Error("Server RODiT private key unavailable for URL-join JWT mint");
}

function signGuestServiceProviderSignature(peerRodit, privateKeyBytes) {
  const hashInput = {
    token_id: peerRodit.token_id,
    openapijson_url: peerRodit.metadata.openapijson_url,
    not_after: peerRodit.metadata.not_after,
    not_before: peerRodit.metadata.not_before,
    max_requests: String(peerRodit.metadata.max_requests),
    maxrq_window: String(peerRodit.metadata.maxrq_window),
    webhook_cidr: peerRodit.metadata.webhook_cidr,
    allowed_cidr: peerRodit.metadata.allowed_cidr,
    allowed_iso3166list: peerRodit.metadata.allowed_iso3166list,
    jwt_duration: peerRodit.metadata.jwt_duration,
    permissioned_routes: peerRodit.metadata.permissioned_routes,
    serviceprovider_id: peerRodit.metadata.serviceprovider_id,
    subjectuniqueidentifier_url: peerRodit.metadata.subjectuniqueidentifier_url
  };
  const hashHex = utils.calculateCanonicalHash(hashInput);
  const hashBytes = new Uint8Array(Buffer.from(hashHex, "hex"));
  const signature = nacl.sign.detached(hashBytes, privateKeyBytes);
  return Buffer.from(signature).toString("base64url");
}

function buildSyntheticPeerRodit({
  roditId,
  webhookUrl,
  ownRodit,
  privateKeyBytes,
  displayName = null
}) {
  const ownMeta = ownRodit.metadata || {};
  const peer = new blockchainService.RODiT();
  peer.token_id = roditId;
  // Guest owner is ephemeral; JWT is signed by the server key, not this owner.
  peer.owner_id = Buffer.from(nacl.sign.keyPair().publicKey).toString("hex");
  peer.metadata = {
    openapijson_url: ownMeta.openapijson_url || "",
    not_after: isoYearsFromNow(GUEST_VALIDITY_YEARS),
    not_before: isoNow(),
    max_requests: GUEST_MAX_REQUESTS,
    maxrq_window: GUEST_MAXRQ_WINDOW,
    webhook_url: webhookUrl,
    webhook_cidr: "",
    userselected_dn: displayName || "",
    allowed_cidr: "",
    allowed_iso3166list: "",
    jwt_duration: GUEST_JWT_DURATION_SECONDS,
    permissioned_routes: "",
    subjectuniqueidentifier_url: ownMeta.subjectuniqueidentifier_url || "",
    serviceprovider_id: ownMeta.serviceprovider_id || "",
    serviceprovider_signature: ""
  };
  peer.metadata.serviceprovider_signature = signGuestServiceProviderSignature(
    peer,
    privateKeyBytes
  );
  return peer;
}

function peerFromStoredRow(row) {
  if (!row) {
    return null;
  }
  const peer = new blockchainService.RODiT();
  peer.token_id = row.rodit_id;
  peer.owner_id = row.owner_id;
  peer.metadata = {
    openapijson_url: row.openapijson_url || "",
    not_after: row.not_after,
    not_before: row.not_before,
    max_requests: row.max_requests,
    maxrq_window: row.maxrq_window,
    webhook_url: row.webhook_url,
    webhook_cidr: row.webhook_cidr || "",
    userselected_dn: row.display_name || "",
    allowed_cidr: row.allowed_cidr || "",
    allowed_iso3166list: row.allowed_iso3166list || "",
    jwt_duration: row.jwt_duration,
    permissioned_routes: row.permissioned_routes || "",
    subjectuniqueidentifier_url: row.subjectuniqueidentifier_url || "",
    serviceprovider_id: row.serviceprovider_id || "",
    serviceprovider_signature: row.serviceprovider_signature || ""
  };
  return peer;
}

async function loadSyntheticPeerRodit(roditId) {
  const row = await repo.getUrlJoinIdentity(roditId);
  return peerFromStoredRow(row);
}

function decodeJwtPayload(jwtToken) {
  if (typeof jwtToken !== "string" || !jwtToken) {
    return null;
  }
  const parts = jwtToken.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function guestJwtHints(jwtToken, identityRow = null) {
  const jwtLen = typeof jwtToken === "string" ? jwtToken.length : 0;
  const payload = decodeJwtPayload(jwtToken);
  let sessionExpiresAt = null;
  if (payload?.session_exp != null && Number.isFinite(Number(payload.session_exp))) {
    sessionExpiresAt = new Date(Number(payload.session_exp) * 1000).toISOString();
  } else if (typeof identityRow?.not_after === "string" && identityRow.not_after) {
    sessionExpiresAt = identityRow.not_after;
  } else if (payload?.exp != null && Number.isFinite(Number(payload.exp))) {
    sessionExpiresAt = new Date(Number(payload.exp) * 1000).toISOString();
  }
  return { jwtLen, sessionExpiresAt };
}

async function loadOwnRoditSigningMaterial() {
  const configOwn = await stateManager.getConfigOwnRodit();
  const ownRodit = configOwn?.own_rodit;
  const privateKeyBytes = toPrivateKeyBytes(configOwn?.own_rodit_bytes_private_key);
  if (!ownRodit?.token_id || !ownRodit?.metadata) {
    const err = new Error("Server RODiT not initialized for URL-join");
    err.code = "AUTH_SERVICE_UNAVAILABLE";
    err.statusCode = 503;
    throw err;
  }
  return { ownRodit, privateKeyBytes };
}

/**
 * Validate webhook + build in-memory guest peer. No DB row or JWT until join succeeds.
 */
async function prepareUrlJoinIdentity({ webhookUrl, displayName = null }) {
  ensureChainLookupWrapped();

  const validatedUrl = validateWebhookUrl(webhookUrl);
  await assertWebhookUrlResolvesPublic(validatedUrl);

  const { ownRodit, privateKeyBytes } = await loadOwnRoditSigningMaterial();
  const roditId = `guest_${ulid()}`;
  const peer = buildSyntheticPeerRodit({
    roditId,
    webhookUrl: validatedUrl,
    ownRodit,
    privateKeyBytes,
    displayName
  });

  return {
    roditId,
    webhookUrl: validatedUrl,
    displayName,
    peer,
    ownRodit,
    privateKeyBytes
  };
}

async function finalizeUrlJoinIdentity(prepared) {
  ensureChainLookupWrapped();
  const { roditId, webhookUrl, displayName, peer, ownRodit, privateKeyBytes } = prepared;

  await repo.insertUrlJoinIdentity({
    roditId: peer.token_id,
    ownerId: peer.owner_id,
    webhookUrl: peer.metadata.webhook_url,
    displayName: displayName || null,
    openapijsonUrl: peer.metadata.openapijson_url,
    notAfter: peer.metadata.not_after,
    notBefore: peer.metadata.not_before,
    maxRequests: peer.metadata.max_requests,
    maxrqWindow: peer.metadata.maxrq_window,
    webhookCidr: peer.metadata.webhook_cidr,
    allowedCidr: peer.metadata.allowed_cidr,
    allowedIso3166list: peer.metadata.allowed_iso3166list,
    jwtDuration: peer.metadata.jwt_duration,
    permissionedRoutes: peer.metadata.permissioned_routes,
    subjectuniqueidentifierUrl: peer.metadata.subjectuniqueidentifier_url,
    serviceproviderId: peer.metadata.serviceprovider_id,
    serviceproviderSignature: peer.metadata.serviceprovider_signature
  });

  const now = Math.floor(Date.now() / 1000);
  const jwtToken = await generate_jwt_token(
    peer,
    now,
    ownRodit,
    privateKeyBytes,
    "new"
  );

  logger.infoWithContext("URL-join identity minted", {
    component: "UrlJoinIdentity",
    roditId,
    hasWebhookUrl: Boolean(webhookUrl)
  });

  return {
    roditId,
    webhookUrl,
    jwtToken,
    peer
  };
}

async function createUrlJoinIdentity({ webhookUrl, displayName = null }) {
  const prepared = await prepareUrlJoinIdentity({ webhookUrl, displayName });
  return finalizeUrlJoinIdentity(prepared);
}

async function lookupUrlJoinWebhookUrl(roditId) {
  const normalized = normalizeRoditId(roditId);
  if (!isUrlJoinRoditId(normalized)) {
    return null;
  }
  const row = await repo.getUrlJoinIdentity(normalized);
  const url = typeof row?.webhook_url === "string" ? row.webhook_url.trim() : "";
  return url || null;
}

function installUrlJoinIdentitySupport() {
  ensureChainLookupWrapped();
}

module.exports = {
  validateWebhookUrl,
  assertWebhookUrlResolvesPublic,
  isBlockedHostname,
  isBlockedIpAddress,
  prepareUrlJoinIdentity,
  finalizeUrlJoinIdentity,
  createUrlJoinIdentity,
  guestJwtHints,
  decodeJwtPayload,
  lookupUrlJoinWebhookUrl,
  loadSyntheticPeerRodit,
  installUrlJoinIdentitySupport,
  isUrlJoinRoditId
};
