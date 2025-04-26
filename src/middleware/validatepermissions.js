const { decodeJwt } = require("jose");
const logger = require("../../config/logger");
const crypto = require("crypto");

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
      const errorCode = "113";
      logger.error("Unknown method type detected", {
        component: "PermissionValidator",
        method: "isMethodAllowed",
        requestedMethod: method,
        error: `Unknown method type: ${method}`,
        errorCode,
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

  findRelativeMatchingEntity(entities, currentPath, requestId) {
    const startTime = Date.now();

    // Validate entities structure
    if (!entities || typeof entities !== 'object') {
      logger.warn("Invalid entities structure", {
        component: "PermissionValidator",
        method: "findRelativeMatchingEntity",
        error: "Received invalid entities structure",
        entitiesType: typeof entities,
        errorCode: "114",
        requestId,
      });
      return {
        isPermitted: false,
        commentsRate: null,
        permissionScope: null,
        errorCode: "114"
      };
    }

    // Normalize the path by removing the /api prefix if present
    let normalizedPath = currentPath;
    if (normalizedPath.startsWith("/api")) {
      normalizedPath = normalizedPath.substring(4); // Remove '/api'
    }

    // Ensure the path starts with a slash for consistency
    if (!normalizedPath.startsWith("/")) {
      normalizedPath = "/" + normalizedPath;
    }

    logger.debug("Path normalization for permission check", {
      component: "PermissionValidator",
      method: "findRelativeMatchingEntity",
      originalPath: currentPath,
      normalizedPath: normalizedPath,
      requestId,
    });

    try {
      // Safely access entity properties with validation
      if (!entities.name) {
        logger.warn("Entity name missing", {
          component: "PermissionValidator",
          method: "findRelativeMatchingEntity",
          errorCode: "115",
          requestId,
        });
        return {
          isPermitted: false,
          commentsRate: null,
          permissionScope: null,
          errorCode: "115"
        };
      }
      
      const entity = entities.name;
      
      // Validate methods property exists and is an object
      if (!entities.methods || typeof entities.methods !== 'object') {
        logger.warn("Invalid methods structure in entity", {
          component: "PermissionValidator",
          method: "findRelativeMatchingEntity",
          entity,
          error: "methods is not defined or not an object",
          errorCode: "116",
          requestId,
        });
        return {
          isPermitted: false,
          commentsRate: null,
          permissionScope: null,
          errorCode: "116"
        };
      }
      
      const methods = entities.methods;

      // Check for match using the normalized path
      if (Object.prototype.hasOwnProperty.call(methods, normalizedPath)) {
        const rateValue = methods[normalizedPath];
        const method = normalizedPath.split("/").pop();

        logger.info("Processing permission request", {
          component: "PermissionValidator",
          method: "findRelativeMatchingEntity",
          url: currentPath,
          normalizedPath: normalizedPath,
          requestedMethod: method,
          entity,
          requestId,
        });

        const permissionScope = this.getPermissionScope(rateValue);
        const isPermitted = this.isMethodAllowed(method, permissionScope);

        logger.debug("Permission check result", {
          component: "PermissionValidator",
          method: "findRelativeMatchingEntity",
          url: currentPath,
          normalizedPath: normalizedPath,
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
      
      const errorCode = "117";
      logger.warn("No matching permission found", {
        component: "PermissionValidator",
        method: "findRelativeMatchingEntity",
        url: currentPath,
        normalizedPath: normalizedPath,
        errorCode,
        duration: Date.now() - startTime,
        requestId,
      });

      return {
        isPermitted: false,
        commentsRate: null,
        permissionScope: null,
        errorCode
      };
    } catch (error) {
      const errorCode = "118";
      logger.error("Error during permission matching", {
        component: "PermissionValidator",
        method: "findRelativeMatchingEntity",
        url: currentPath,
        normalizedPath,
        error: error.message,
        errorCode,
        stack: error.stack,
        duration: Date.now() - startTime,
        requestId,
      });
      
      return {
        isPermitted: false,
        commentsRate: null,
        permissionScope: null,
        errorCode
      };
    }
  }

  async validate(req) {
    const requestId = req.headers["x-request-id"] || crypto.randomUUID();
    const startTime = Date.now();
  
    const token = req.header("Authorization");
    if (!token) {
      const errorCode = "401";
      logger.warn("Authorization token missing", {
        component: "PermissionValidator",
        method: "validate",
        path: req.path,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        errorCode,
        duration: Date.now() - startTime,
        requestId,
      });
  
      return {
        isValid: false,
        status: 401,
        message: `Error ${errorCode}: Access denied. No token provided.`,
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
      
      // Check if required JWT field exists
      if (!decodedToken.rodit_permissionedroutes) {
        const errorCode = "119";
        logger.warn("Missing permissions in token", {
          component: "PermissionValidator",
          method: "validate",
          userId: decodedToken.sub || "unknown",
          errorCode,
          requestId,
        });
        
        return {
          isValid: false,
          status: 403,
          message: `Error ${errorCode}: Token is missing required permission fields.`,
        };
      }
  
      let permissionedRoutes;
      try {
        permissionedRoutes = JSON.parse(
          decodedToken.rodit_permissionedroutes
        );
      } catch (parseError) {
        const errorCode = "120";
        logger.error("Failed to parse permissions JSON", {
          component: "PermissionValidator",
          method: "validate",
          userId: decodedToken.sub || "unknown",
          error: parseError.message,
          errorCode,
          requestId,
        });
        
        return {
          isValid: false,
          status: 400,
          message: `Error ${errorCode}: Invalid permission format in token.`,
        };
      }
  
      // Add debug logging for permission routes content
      logger.debug("Permission routes content", {
        component: "PermissionValidator",
        method: "validate",
        permissionedRoutes: JSON.stringify(permissionedRoutes),
        entitiesType: typeof permissionedRoutes.entities,
        requestId,
      });
  
      // Validate entities structure
      if (!permissionedRoutes.entities) {
        const errorCode = "121";
        logger.warn("Missing entities in permission routes", {
          component: "PermissionValidator",
          method: "validate",
          userId: decodedToken.sub || "unknown",
          errorCode,
          requestId,
        });
        
        return {
          isValid: false,
          status: 403,
          message: `Error ${errorCode}: Token contains invalid permission structure.`,
        };
      }
      
      const entities = permissionedRoutes.entities;
      const currentPath = req.path;
  
      const result = this.findRelativeMatchingEntity(entities, currentPath, requestId);
      
      if (!result.isPermitted) {
        const errorCode = result.errorCode || "122";
        logger.warn("Permission denied", {
          component: "PermissionValidator",
          method: "validate",
          path: req.path,
          userId: decodedToken.sub || "unknown",
          errorCode,
          duration: Date.now() - startTime,
          requestId,
        });
  
        return {
          isValid: false,
          status: 403,
          message: `Error ${errorCode}: Permission denied for this resource.`,
        };
      }
  
      logger.info("Authorization successful", {
        component: "PermissionValidator",
        method: "validate",
        path: req.path,
        userId: decodedToken.sub || "unknown",
        permissionScope: result.permissionScope,
        rateValue: result.commentsRate,
        duration: Date.now() - startTime,
        requestId,
      });
  
      return {
        isValid: true,
        commentsRate: result.commentsRate,
        permissionScope: result.permissionScope,
      };
    } catch (error) {
      const errorCode = "123";
      logger.error("Permission check failed", {
        component: "PermissionValidator",
        method: "validate",
        path: req.path,
        error: error.message,
        errorCode,
        stack: error.stack,
        duration: Date.now() - startTime,
        requestId,
      });
  
      return {
        isValid: false,
        status: 400,
        message: `Error ${errorCode}: Invalid token or permissions.`,
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