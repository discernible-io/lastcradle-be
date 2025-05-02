class PermissionValidator {
  constructor() {
    this.methodPermissionMap = {
      create: ["entityAndProperties"],
      destroy: ["entityAndProperties"],
      read: ["entityAndProperties", "entityOnly"],
      update: ["entityAndProperties", "entityOnly"],
      list: ["entityAndProperties", "entityOnly"],
      list_all: ["entityAndProperties", "entityOnly"],
    };
  }

  getPermissionScope(rateValue) {
    if (rateValue.startsWith("+")) {
      return "entityAndProperties";
    } else if (rateValue.startsWith("-")) {
      return "propertiesOnly";
    }
    return "entityOnly";
  }

  isMethodAllowed(method, permissionScope) {
    const startTime = Date.now();

    if (!this.methodPermissionMap[method]) {
      logger.error("Unknown method type detected", {
        component: "PermissionValidator",
        method: "isMethodAllowed",
        requestedMethod: method,
        error: `Unknown method type: ${method}`,
        duration: Date.now() - startTime,
      });
      return false;
    }

    const isAllowed =
      this.methodPermissionMap[method].includes(permissionScope);

    logger.debug("Method permission check completed", {
      component: "PermissionValidator",
      method: "isMethodAllowed",
      requestedMethod: method,
      permissionScope,
      isAllowed,
      duration: Date.now() - startTime,
    });

    return isAllowed;
  }

  // New method to normalize path for permission checking
  normalizePath(req) {
    // Get the base URL (the mounted path prefix) and the route-specific path
    const baseUrl = req.baseUrl || '';
    const path = req.path || '';
    
    // Combine them to get the full path from the root
    let fullPath = baseUrl + path;
    
    // Remove trailing slash if present (unless it's the root path)
    if (fullPath.length > 1 && fullPath.endsWith('/')) {
      fullPath = fullPath.slice(0, -1);
    }
    
    // Extract the relevant parts for permission checking
    // If the path is like /api/cruda/create, we want to extract /cruda/create
    const pathParts = fullPath.split('/').filter(part => part.length > 0);
    
    if (pathParts.length >= 2) {
      // Take the first two meaningful parts of the path
      // This would give us "cruda/operation" from "/api/cruda/operation"
      return '/' + pathParts.slice(0, 2).join('/');
    } else if (pathParts.length === 1) {
      // Just one path segment
      return '/' + pathParts[0];
    }
    
    // Default to root
    return '/';
  }

  findMatchingEntity(entities, normalizedPath, requestId) {
    const startTime = Date.now();

    // Handle entities as an object with name and methods
    const entity = entities.name;
    const methods = entities.methods;
    
    logger.debug("Checking permission for path", {
      component: "PermissionValidator",
      method: "findMatchingEntity",
      requestId,
      normalizedPath,
      availableMethods: Object.keys(methods),
    });

    if (methods.hasOwnProperty(normalizedPath)) {
      const rateValue = methods[normalizedPath];
      const method = normalizedPath.split("/").pop();

      logger.info("Processing permission request", {
        component: "PermissionValidator",
        method: "findMatchingEntity",
        url: normalizedPath,
        requestedMethod: method,
        entity,
        requestId,
      });

      const permissionScope = this.getPermissionScope(rateValue);
      const isPermitted = this.isMethodAllowed(method, permissionScope);

      logger.debug("Permission check result", {
        component: "PermissionValidator",
        method: "findMatchingEntity",
        url: normalizedPath,
        requestedMethod: method,
        entity,
        permissionScope,
        rateValue,
        isPermitted,
        duration: Date.now() - startTime,
        requestId,
      });

      if (isPermitted) {
        return {
          isPermitted: true,
          commentsRate: rateValue,
          permissionScope,
        };
      }
    }

    logger.warn("No matching permission found", {
      component: "PermissionValidator",
      method: "findMatchingEntity",
      url: normalizedPath,
      duration: Date.now() - startTime,
      requestId,
    });

    return {
      isPermitted: false,
      commentsRate: null,
      permissionScope: null,
    };
  }

  async validate(req) {
    const requestId = req.headers["x-request-id"] || crypto.randomUUID();
    const startTime = Date.now();

    const token = req.header("Authorization");
    if (!token) {
      logger.warn("Authorization token missing", {
        component: "PermissionValidator",
        method: "validate",
        path: req.path,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        duration: Date.now() - startTime,
        requestId,
      });

      return {
        isValid: false,
        status: 401,
        message: "Access denied. No token provided.",
      };
    }

    try {
      const decodedToken = decodeJwt(token);

      logger.info("Endpoint access attempt", {
        component: "PermissionValidator",
        method: "validate",
        endpoint: req.path,
        userId: decodedToken.sub || "unknown",
        requestId,
      });

      const permissionedRoutes = JSON.parse(
        decodedToken.rodit_permissionedroutes
      );

      // Add debug logging for permission routes content
      logger.debug("Permission routes content", {
        component: "PermissionValidator",
        method: "validate",
        permissionedRoutes: JSON.stringify(permissionedRoutes),
        entitiesType: typeof permissionedRoutes.entities,
        requestId,
      });

      // Get normalized path for permission checking
      const normalizedPath = this.normalizePath(req);
      
      logger.debug("Normalized path for permission check", {
        component: "PermissionValidator",
        method: "validate",
        requestId,
        originalPath: req.path,
        baseUrl: req.baseUrl,
        fullPath: req.baseUrl + req.path,
        normalizedPath,
      });

      // Use entities directly, assuming it's an object
      const entities = permissionedRoutes.entities;

      const { isPermitted, commentsRate, permissionScope } =
        this.findMatchingEntity(entities, normalizedPath, requestId);

      if (!isPermitted) {
        logger.warn("Permission denied", {
          component: "PermissionValidator",
          method: "validate",
          path: req.path,
          userId: decodedToken.sub || "unknown",
          duration: Date.now() - startTime,
          requestId,
        });

        return {
          isValid: false,
          status: 403,
          message: "Permission denied",
        };
      }

      logger.info("Authorization successful", {
        component: "PermissionValidator",
        method: "validate",
        path: req.path,
        userId: decodedToken.sub || "unknown",
        permissionScope,
        rateValue: commentsRate,
        duration: Date.now() - startTime,
        requestId,
      });

      return {
        isValid: true,
        commentsRate,
        permissionScope,
      };
    } catch (error) {
      logger.error("Permission check failed", {
        component: "PermissionValidator",
        method: "validate",
        path: req.path,
        error: error.message,
        errorCode: "112",
        stack: error.stack,
        duration: Date.now() - startTime,
        requestId,
      });

      return {
        isValid: false,
        status: 400,
        message: "Error 119: Invalid token or permissions.",
      };
    }
  }
}

const permissionValidator = new PermissionValidator();

/**
 * @swagger
 * /authorize:
 *   get:
 *     summary: Authorize user and check JWT token fields
 *     description: Verify the JWT token and check specific fields before granting access
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Authorization successful
 *       401:
 *         description: Unauthorized - Invalid token or missing required fields
 */
async function validatepermissions(req, res, next) {
  const startTime = Date.now();
  const requestId = req.headers["x-request-id"] || crypto.randomUUID();

  if (!req.headers["x-request-id"]) {
    req.headers["x-request-id"] = requestId;
  }

  logger.debug("Permission validation started", {
    component: "validatepermissions",
    method: "middleware",
    path: req.path,
    baseUrl: req.baseUrl,
    requestId,
  });

  const result = await permissionValidator.validate(req);

  if (!result.isValid) {
    logger.warn("Permission validation failed", {
      component: "validatepermissions",
      method: "middleware",
      path: req.path,
      status: result.status,
      message: result.message,
      duration: Date.now() - startTime,
      requestId,
    });

    return res.status(result.status).json({ message: result.message });
  }

  if (result.commentsRate) {
    req.commentsRate = result.commentsRate;
    req.permissionScope = result.permissionScope;
  }

  logger.debug("Permission validation successful", {
    component: "validatepermissions",
    method: "middleware",
    path: req.path,
    permissionScope: result.permissionScope,
    duration: Date.now() - startTime,
    requestId,
  });

  next();
}

module.exports = validatepermissions;