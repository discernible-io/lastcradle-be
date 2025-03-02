const { decodeJwt } = require("jose");
const logger = require("../config/logger");

class PermissionValidator {
  constructor() {
    this.methodPermissionMap = {
      create: ['entityAndProperties'],
      destroy: ['entityAndProperties'],
      read: ['entityAndProperties', 'entityOnly'],
      update: ['entityAndProperties', 'entityOnly'],
      list: ['entityAndProperties', 'entityOnly'],
      list_all: ['entityAndProperties', 'entityOnly']
    };
  }

  getPermissionScope(rateValue) {
    if (rateValue.startsWith('+')) {
      return 'entityAndProperties';
    } else if (rateValue.startsWith('-')) {
      return 'propertiesOnly';
    }
    return 'entityOnly';
  }

  isMethodAllowed(method, permissionScope) {
    if (!this.methodPermissionMap[method]) {
      logger.error(`Error: Unknown method type: ${method}`);
      return false;
    }
    return this.methodPermissionMap[method].includes(permissionScope);
  }

  findMatchingEntity(entities, currentPath) {
    for (const entityObj of entities) {
      const entity = entityObj.entity || entityObj.name;
      const methods = entityObj.methods;

      if (methods.hasOwnProperty(currentPath)) {
        const rateValue = methods[currentPath];
        const method = currentPath.split("/").pop();

        logger.info(`url: ${currentPath}`);
        logger.info(`method: ${method}`);

        const permissionScope = this.getPermissionScope(rateValue);
        const isPermitted = this.isMethodAllowed(method, permissionScope);

        if (isPermitted) {
          return {
            isPermitted: true,
            commentsRate: rateValue,
            permissionScope
          };
        }
      }
    }

    return {
      isPermitted: false,
      commentsRate: null,
      permissionScope: null
    };
  }

  async validate(req) {
    const token = req.header("Authorization");
    
    if (!token) {
      return {
        isValid: false,
        status: 401,
        message: "Access denied. No token provided."
      };
    }

    try {
      const decodedToken = decodeJwt(token);
      logger.info(`Info: Endpoint reached: ${req.path}`);

      const permissionedRoutes = JSON.parse(decodedToken.rodit_permissionedroutes);
      const { entities } = permissionedRoutes;
      const currentPath = req.path;

      const {
        isPermitted,
        commentsRate,
        permissionScope
      } = this.findMatchingEntity(entities, currentPath);

      if (!isPermitted) {
        return {
          isValid: false,
          status: 403,
          message: "Permission denied"
        };
      }

      return {
        isValid: true,
        commentsRate,
        permissionScope
      };

    } catch (error) {
      logger.error("Error 112: checking permissions:", error);
      return {
        isValid: false,
        status: 400,
        message: "Error 119: Invalid token or permissions."
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
  const result = await permissionValidator.validate(req);

  if (!result.isValid) {
    return res.status(result.status).json({ message: result.message });
  }

  if (result.commentsRate) {
    req.commentsRate = result.commentsRate;
    req.permissionScope = result.permissionScope;
  }

  next();
}

module.exports = validatepermissions;