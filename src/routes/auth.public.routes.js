const express = require("express");
const router = express.Router();
const { ulid } = require("ulid");
const { logger, errorResponse, login_client_withnep413 } = require("@rodit/rodit-auth-be");
const { sendError } = errorResponse;
const { validateContentType, validateJsonBody } = require("../middleware/requestvalidationmw");

/**
 * mintserver-style NEP-413 wallet login body (signature over RODiT token id).
 * Agents still use timestamp challenge login; operators use this path.
 */
function isNep413LoginBody(body) {
  if (!body || typeof body !== "object") {
    return false;
  }
  return Boolean(
    body.signature &&
      body.message &&
      body.nonce != null &&
      body.recipient
  );
}

function parseCanonicalTimestampIsoToUnixSeconds(timestampIso) {
  if (typeof timestampIso !== "string") {
    return null;
  }
  const trimmed = timestampIso.trim();
  if (!trimmed) {
    return null;
  }

  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms) || ms <= 0 || ms % 1000 !== 0) {
    return null;
  }

  if (new Date(ms).toISOString() !== trimmed) {
    return null;
  }

  const unixSeconds = Math.floor(ms / 1000);
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds <= 0) {
    return null;
  }
  return unixSeconds;
}

function resolveLoginTimestampFromBody(body) {
  const hasTimestamp =
    body.timestamp !== undefined &&
    body.timestamp !== null &&
    !(typeof body.timestamp === "string" && body.timestamp.trim() === "");
  const hasTimestampIso =
    body.timestamp_iso !== undefined &&
    body.timestamp_iso !== null &&
    !(typeof body.timestamp_iso === "string" && body.timestamp_iso.trim() === "");

  if (hasTimestamp && hasTimestampIso) {
    return {
      value: null,
      error: "LOGIN_TIMESTAMP_AMBIGUOUS",
      message: "Send exactly one timestamp format: timestamp OR timestamp_iso, not both."
    };
  }

  if (hasTimestampIso) {
    const parsed = parseCanonicalTimestampIsoToUnixSeconds(body.timestamp_iso);
    if (parsed === null) {
      return {
        value: null,
        error: "INVALID_LOGIN_TIMESTAMP",
        message:
          "Invalid timestamp_iso. Use the canonical ISO string from the same GET /api/login/timestamp login challenge you are using for this attempt."
      };
    }
    return { value: parsed, error: null, message: null };
  }

  if (hasTimestamp) {
    if (
      typeof body.timestamp !== "number" ||
      !Number.isSafeInteger(body.timestamp) ||
      body.timestamp <= 0
    ) {
      return {
        value: null,
        error: "INVALID_LOGIN_TIMESTAMP",
        message:
          "Invalid timestamp. Use the Unix-seconds value from the same GET /api/login/timestamp login challenge as your login signing payload."
      };
    }
    return { value: body.timestamp, error: null, message: null };
  }

  return {
    value: null,
    error: "INVALID_LOGIN_TIMESTAMP",
    message:
      "Provide exactly one of timestamp or timestamp_iso from GET /api/login/timestamp (the login challenge pair for this attempt)."
  };
}

const authenticateLogout = (req, res, next) => {
  const client = req.app?.locals?.roditClient;
  if (!client) {
    const requestId = req.requestId || ulid();
    return sendError(res, {
      statusCode: 503,
      requestId,
      code: "AUTH_SERVICE_UNAVAILABLE",
      message: "Authentication service unavailable"
    });
  }

  if (typeof client.authenticateForLogout === "function") {
    return client.authenticateForLogout(req, res, next);
  }

  return client.authenticate(req, res, next);
};

router.post("/login", validateContentType, validateJsonBody, async (req, res) => {
  const requestId = req.requestId || ulid();
  req.logAction = "login-attempt";

  const client = req.app.locals.roditClient;
  if (!client) {
    return sendError(res, {
      statusCode: 503,
      requestId,
      code: "AUTH_SERVICE_UNAVAILABLE",
      message: "Authentication service unavailable"
    });
  }

  if (!req.headers) {
    req.headers = {};
  }
  if (!req.headers["user-agent"]) {
    req.headers["user-agent"] = req.get("User-Agent");
  }

  const body = req.body || {};

  if (isNep413LoginBody(body)) {
    logger.infoWithContext("NEP-413 login request received", {
      component: "AuthRoutes",
      method: "login_client_withnep413",
      requestId,
      path: req.originalUrl,
      ip: req.ip,
      userAgent: req.get("User-Agent"),
      recipient: body.recipient,
      messageLength: typeof body.message === "string" ? body.message.length : 0
    });

    const config_own_rodit = client.getStateManager?.()?.getConfigOwnRodit?.();
    if (!config_own_rodit) {
      return sendError(res, {
        statusCode: 500,
        requestId,
        code: "SERVER_CONFIG_NOT_INITIALIZED",
        message: "Server configuration not initialized"
      });
    }

    await login_client_withnep413(req, res, config_own_rodit);
    return;
  }

  logger.infoWithContext("Login request received", {
    component: "AuthRoutes",
    method: "login_client",
    requestId,
    path: req.originalUrl,
    ip: req.ip,
    userAgent: req.get("User-Agent")
  });

  const timestampResolution = resolveLoginTimestampFromBody(body);
  if (timestampResolution.value === null) {
    return sendError(res, {
      statusCode: 400,
      requestId,
      code: timestampResolution.error,
      message: timestampResolution.message
    });
  }

  req.body.timestamp = timestampResolution.value;
  if (Object.prototype.hasOwnProperty.call(req.body, "timestamp_iso")) {
    delete req.body.timestamp_iso;
  }

  await client.login_client(req, res);
});

router.post("/logout", validateContentType, authenticateLogout, async (req, res) => {
  req.logAction = "logout-attempt";
  const requestId = req.requestId || ulid();

  const client = req.app?.locals?.roditClient;
  if (!client) {
    return sendError(res, {
      statusCode: 503,
      requestId,
      code: "AUTH_SERVICE_UNAVAILABLE",
      message: "Authentication service not configured"
    });
  }

  try {
    await client.logout_client(req, res);
  } catch (error) {
    logger.logErrorWithMetrics(
      "Error calling logout_client",
      { component: "AuthRoutes", requestId },
      error,
      "logout_error",
      { operation: "logout", result: "error" }
    );
    return sendError(res, {
      statusCode: 500,
      requestId,
      code: "LOGOUT_FAILED",
      message: error.message
    });
  }
});

module.exports = router;
