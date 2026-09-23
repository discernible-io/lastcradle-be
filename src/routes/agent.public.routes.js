const express = require("express");
const router = express.Router();
const { ulid } = require("ulid");
const { logger, errorResponse } = require("@rodit/rodit-auth-be");
const { sendError } = errorResponse;
const funnel = require("../lib/funnel");

/**
 * @route GET /api/login/timestamp
 * @desc Returns synchronized timestamp for API login signature generation
 * @access Public
 */
router.get("/login/timestamp", (req, res) => {
  const requestId = req.requestId || ulid();
  const startTime = Date.now();

  const context = logger.createLogContext("AgentRoutes", "getAuthParams", {
    requestId,
    endpoint: "/api/login/timestamp",
    ip: req.ip,
    userAgent: req.get("User-Agent")
  });

  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const timestampISO = new Date(timestamp * 1000).toISOString();
    const duration = Date.now() - startTime;

    logger.infoWithContext("Auth params generated", { ...context, duration, timestamp });
    logger.metric("agent_auth_params_generate", duration, {
      operation: "getAuthParams",
      result: "success"
    });
    funnel.track(funnel.EVENTS.LOGIN_CHALLENGE, {
      path: "/api/login/timestamp",
      result: "success",
      requestId,
      durationMs: duration,
      req
    });

    return res.status(200).json({
      timestamp,
      timestamp_iso: timestampISO,
      requestId
    });
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.logErrorWithMetrics(
      "Error generating auth params",
      { ...context, duration },
      error,
      "agent_auth_params_error",
      { operation: "getAuthParams", result: "error", duration }
    );
    funnel.track(funnel.EVENTS.LOGIN_CHALLENGE, {
      path: "/api/login/timestamp",
      result: "failed",
      errorCode: "AGENT_AUTH_PARAMS_FAILED",
      requestId,
      durationMs: duration,
      req
    });

    return sendError(res, {
      statusCode: 500,
      requestId,
      code: "AGENT_AUTH_PARAMS_FAILED",
      message: error.message
    });
  }
});

module.exports = router;
