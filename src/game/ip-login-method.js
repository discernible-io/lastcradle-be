/**
 * Per-game guest seat limit by client IP (10-minute cool-down).
 * One join-by-url guest per IP per gameId during the TTL.
 * Passport methods (rodit_ed25519, nep413) are not limited and may share that IP.
 */

const repo = require("./repository");
const { canonicalRoditId, roditIdFromUser } = require("./rodit-id");

const METHODS = Object.freeze({
  RODIT_ED25519: "rodit_ed25519",
  NEP413: "nep413",
  GUEST: "guest"
});

const DEFAULT_PASSPORT_METHOD = METHODS.RODIT_ED25519;

/** How long one guest seat stays reserved for an IP on a gameId. */
const IP_LOGIN_METHOD_LOCK_TTL_MS = 10 * 60 * 1000;

function loginMethodError(code, message, statusCode = 400, details = null) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  err.details = details;
  return err;
}

function lockedLoginMethodError({
  gameId,
  lockedMethod,
  attemptedMethod,
  retryAfterSeconds = null,
  lockedUntil = null
}) {
  return loginMethodError(
    "LOGIN_METHOD_LOCKED",
    "This IP already has a guest seat for this game",
    409,
    {
      gameId,
      lockedMethod,
      attemptedMethod,
      retryAfterSeconds,
      lockedUntil
    }
  );
}

function normalizeClientIp(ip) {
  if (typeof ip !== "string") {
    return "";
  }
  const trimmed = ip.trim();
  if (!trimmed) {
    return "";
  }
  // Express trust-proxy may yield :ffff:127.0.0.1
  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice(7);
  }
  return trimmed;
}

function clientIpFromReq(req) {
  return normalizeClientIp(req?.ip || req?.socket?.remoteAddress || "");
}

async function resolvePassportLoginMethod(roditId) {
  const id = canonicalRoditId(roditId);
  if (!id) {
    return DEFAULT_PASSPORT_METHOD;
  }
  const row = await repo.getRoditLoginMethod(id);
  if (row?.method === METHODS.NEP413 || row?.method === METHODS.RODIT_ED25519) {
    return row.method;
  }
  return DEFAULT_PASSPORT_METHOD;
}

/**
 * Reserve a guest seat for (ip, gameId), or accept a passport method without reserving.
 * A second unexpired guest seat throws LOGIN_METHOD_LOCKED.
 */
async function assertAndBindIpLoginMethod({ ip, gameId, method }) {
  const normalizedIp = normalizeClientIp(ip);
  if (!normalizedIp) {
    throw loginMethodError(
      "LOGIN_METHOD_IP_REQUIRED",
      "Client IP is required to enforce per-game login method lock",
      400
    );
  }
  if (!gameId) {
    throw loginMethodError("GAME_NOT_FOUND", "Game not found", 404);
  }
  if (
    method !== METHODS.RODIT_ED25519 &&
    method !== METHODS.NEP413 &&
    method !== METHODS.GUEST
  ) {
    throw loginMethodError("INVALID_LOGIN_METHOD", "Unknown login method", 400, { method });
  }

  const result = await repo.bindGameIpLoginMethod({
    gameId,
    ip: normalizedIp,
    method,
    ttlMs: IP_LOGIN_METHOD_LOCK_TTL_MS
  });
  if (!result.ok) {
    throw lockedLoginMethodError({
      gameId,
      lockedMethod: result.lockedMethod,
      attemptedMethod: method,
      retryAfterSeconds: result.retryAfterSeconds ?? null,
      lockedUntil: result.lockedUntil ?? null
    });
  }
  return result.lockedMethod;
}

async function assertPassportIpLoginMethod(req, gameId, roditId) {
  const method = await resolvePassportLoginMethod(roditId);
  await assertAndBindIpLoginMethod({
    ip: clientIpFromReq(req),
    gameId,
    method
  });
  return method;
}

function parseSqliteUtcMs(raw) {
  if (!raw) {
    return null;
  }
  const s = String(raw);
  const iso = s.includes("T") ? s : `${s.replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Read-only check: guest join allowed for this IP (does not bind).
 */
async function ensureGuestIpLoginMethodAllowed(req, gameId) {
  const normalizedIp = normalizeClientIp(clientIpFromReq(req));
  if (!normalizedIp) {
    throw loginMethodError(
      "LOGIN_METHOD_IP_REQUIRED",
      "Client IP is required to enforce per-game login method lock",
      400
    );
  }
  if (!gameId) {
    throw loginMethodError("GAME_NOT_FOUND", "Game not found", 404);
  }

  const existing = await repo.getGameIpLoginMethod(gameId, normalizedIp);
  if (!existing || existing.method !== METHODS.GUEST) {
    return METHODS.GUEST;
  }

  const createdMs = parseSqliteUtcMs(existing.createdAt);
  const expiresAtMs = createdMs != null ? createdMs + IP_LOGIN_METHOD_LOCK_TTL_MS : null;
  const expired = expiresAtMs != null && Date.now() >= expiresAtMs;
  if (expired) {
    return METHODS.GUEST;
  }

  throw lockedLoginMethodError({
    gameId,
    lockedMethod: existing.method,
    attemptedMethod: METHODS.GUEST,
    retryAfterSeconds:
      expiresAtMs != null ? Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 1000)) : null,
    lockedUntil: expiresAtMs != null ? new Date(expiresAtMs).toISOString() : null
  });
}

async function assertGuestIpLoginMethod(req, gameId) {
  await assertAndBindIpLoginMethod({
    ip: clientIpFromReq(req),
    gameId,
    method: METHODS.GUEST
  });
  return METHODS.GUEST;
}

/**
 * After a successful POST /api/login, stamp rodit → method for later join resolution.
 * Identity MUST come from the SDK-issued JWT (authenticated sub), never from
 * attacker-controlled req.body fields (CC-0008).
 */
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

function stampRoditLoginMethodOnSuccess(req, res, method) {
  const originalJson = res.json.bind(res);
  let stamped = false;
  res.json = function stampedJson(body) {
    if (
      !stamped &&
      res.statusCode >= 200 &&
      res.statusCode < 300 &&
      body &&
      typeof body === "object" &&
      body.jwt_token
    ) {
      stamped = true;
      const payload = decodeJwtPayload(body.jwt_token);
      const roditId = roditIdFromUser(payload);
      if (roditId) {
        repo
          .upsertRoditLoginMethod({
            roditId,
            method,
            ip: clientIpFromReq(req) || null
          })
          .catch(() => {
            /* best-effort; join defaults to rodit_ed25519 */
          });
      }
    }
    return originalJson(body);
  };
}

module.exports = {
  METHODS,
  DEFAULT_PASSPORT_METHOD,
  IP_LOGIN_METHOD_LOCK_TTL_MS,
  normalizeClientIp,
  clientIpFromReq,
  resolvePassportLoginMethod,
  assertAndBindIpLoginMethod,
  assertPassportIpLoginMethod,
  ensureGuestIpLoginMethodAllowed,
  assertGuestIpLoginMethod,
  stampRoditLoginMethodOnSuccess
};
