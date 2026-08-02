/**
 * Privileged operator helpers.
 *
 * After mintserver-style NEP-413 login with a privileged server RODiT, clients
 * call the existing privileged endpoints (`/api/sessions/*`, `/api/metrics*`).
 * This router only exposes identity / capability inspection so UIs can verify
 * the JWT was issued for a privileged RODiT before offering those actions.
 *
 * Copyright (c) 2026 Discernible, Inc. All rights reserved.
 */

const express = require("express");
const router = express.Router();
const { ulid } = require("ulid");
const { logger, errorResponse } = require("@rodit/rodit-auth-be");
const { sendError } = errorResponse;
const { getUserRateLimiter } = require("../middleware/userratelimitmw");
const {
  isPrivilegedRoditId,
  getPrivilegedRoditId,
  resolveRequestRoditId
} = require("../game/permissions");

/** Paths that define a session-admin privileged RODiT (see mintserver permissioned_routes). */
const SESSION_ADMIN_ROUTES = [
  "/api/sessions/list_all",
  "/api/sessions/cleanup",
  "/api/sessions/revoke"
];

const METRICS_ADMIN_ROUTES = [
  "/api/metrics",
  "/api/metrics/system",
  "/api/metrics/reset",
  "/api/metrics/debug"
];

function getClient(req) {
  return req.app?.locals?.roditClient || null;
}

function authenticate_apicall(req, res, next) {
  const client = getClient(req);
  if (!client) {
    return sendError(res, {
      statusCode: 503,
      requestId: req.requestId || ulid(),
      code: "AUTH_SERVICE_UNAVAILABLE",
      message: "Authentication service unavailable"
    });
  }
  return client.authenticate(req, res, (authErr) => {
    if (authErr) {
      return next(authErr);
    }
    const userRateLimiter = getUserRateLimiter(req);
    if (!userRateLimiter) {
      return next();
    }
    return userRateLimiter(req, res, next);
  });
}

function parsePermissionedMethods(user) {
  const raw =
    user?.rodit_permissionedroutes ||
    user?.permissioned_routes ||
    user?.permissionedRoutes ||
    user?.metadata?.permissioned_routes;
  if (!raw) {
    return null;
  }
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const methods = parsed?.entities?.methods;
  if (!methods || typeof methods !== "object") {
    return null;
  }
  return methods;
}

function methodsAllow(methods, routePath) {
  if (!methods) {
    return null;
  }
  const entry = methods[routePath];
  if (entry == null) {
    return false;
  }
  if (typeof entry === "string") {
    return entry.startsWith("+") || entry === "allow" || entry === "*";
  }
  return Boolean(entry);
}

function routeAllows(methods, routes) {
  if (methods == null) {
    return null;
  }
  return routes.every((r) => methodsAllow(methods, r));
}

/**
 * GET /api/operator/me
 * Confirm JWT identity and whether this RODiT looks privileged for admin actions.
 */
router.get("/me", authenticate_apicall, async (req, res) => {
  const requestId = req.requestId || ulid();
  try {
    const methods = parsePermissionedMethods(req.user || {});
    const sessionAdmin = routeAllows(methods, SESSION_ADMIN_ROUTES);
    const metricsAdmin = routeAllows(methods, METRICS_ADMIN_ROUTES);
    const gameOperator = isPrivilegedRoditId(req);
    const privileged =
      gameOperator || sessionAdmin === true || metricsAdmin === true;

    res.json({
      requestId,
      timestamp: new Date().toISOString(),
      authenticated: true,
      roditId: resolveRequestRoditId(req),
      privileged,
      privileges: {
        gameOperator,
        configuredGamePrivilegedRoditId: getPrivilegedRoditId(),
        sessionAdmin,
        metricsAdmin,
        privilegeSource:
          methods == null ? "jwt_claims_incomplete" : "permissioned_routes"
      },
      privilegedEndpoints: {
        sessions: {
          list_all: { method: "GET", path: "/api/sessions/list_all" },
          cleanup: { method: "POST", path: "/api/sessions/cleanup" },
          revoke: { method: "POST", path: "/api/sessions/revoke" }
        },
        metrics: {
          current: { method: "GET", path: "/api/metrics" },
          system: { method: "GET", path: "/api/metrics/system" },
          reset: { method: "POST", path: "/api/metrics/reset" },
          debug: { method: "GET", path: "/api/metrics/debug" }
        }
      }
    });
  } catch (error) {
    logger.errorWithContext(
      "operator/me failed",
      { component: "OperatorRoutes", requestId },
      error instanceof Error ? error : new Error(String(error))
    );
    return sendError(res, {
      statusCode: 500,
      requestId,
      code: "OPERATOR_ME_FAILED",
      message: "Failed to resolve operator identity"
    });
  }
});

module.exports = router;
module.exports.SESSION_ADMIN_ROUTES = SESSION_ADMIN_ROUTES;
module.exports.METRICS_ADMIN_ROUTES = METRICS_ADMIN_ROUTES;
