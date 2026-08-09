/**
 * Per-game sticky login method lock by client IP.
 * Methods: rodit_ed25519 | nep413 | guest
 */

const repo = require("./repository");
const { canonicalRoditId } = require("./rodit-id");

const METHODS = Object.freeze({
  RODIT_ED25519: "rodit_ed25519",
  NEP413: "nep413",
  GUEST: "guest"
});

const DEFAULT_PASSPORT_METHOD = METHODS.RODIT_ED25519;

function loginMethodError(code, message, statusCode = 400, details = null) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  err.details = details;
  return err;
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
 * Bind (ip, gameId) to method or throw LOGIN_METHOD_LOCKED.
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
    method
  });
  if (!result.ok) {
    throw loginMethodError(
      "LOGIN_METHOD_LOCKED",
      "This IP is already bound to a different login method for this game",
      409,
      {
        gameId,
        lockedMethod: result.lockedMethod,
        attemptedMethod: method
      }
    );
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
 */
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
      const rawId =
        req.body?.roditid ||
        req.body?.roditId ||
        req.body?.recipient ||
        body.roditid ||
        body.roditId ||
        null;
      const roditId = canonicalRoditId(rawId);
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
  normalizeClientIp,
  clientIpFromReq,
  resolvePassportLoginMethod,
  assertAndBindIpLoginMethod,
  assertPassportIpLoginMethod,
  assertGuestIpLoginMethod,
  stampRoditLoginMethodOnSuccess
};
