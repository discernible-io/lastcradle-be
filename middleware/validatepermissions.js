const { decodeJwt } = require("jose");
const logger = require("../config/logger");

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
  const token = req.header("Authorization");
  if (!token) {
    return res
      .status(401)
      .json({ message: "Access denied. No token provided." });
  }

  try {
    const decodedToken = decodeJwt(token);
    logger.info(`Info: Endpoint reached: ${req.path}`);
    const permissionedRoutes = JSON.parse(
      decodedToken.rodit_permissionedroutes
    );
    const { entities } = permissionedRoutes;
    const currentPath = req.path;
    let isPermitted = false;
    let commentsRate = null;
    let permissionScope = null;

    // Find the entity that has the current path in its methods
    for (const entityObj of entities) {
      const entity = entityObj.entity || entityObj.name; // Handle both "entity" and "name" keys
      const methods = entityObj.methods;

      if (methods.hasOwnProperty(currentPath)) {
        const rateValue = methods[currentPath];
        const method = currentPath.split("/").pop();

        logger.info(`url: ${currentPath}`);
        logger.info(`method: ${method}`);

        // Determine permission scope based on rate sign
        if (rateValue.startsWith("+")) {
          permissionScope = "entityAndProperties";
        } else if (rateValue.startsWith("-")) {
          permissionScope = "propertiesOnly";
        } else {
          permissionScope = "entityOnly";
        }

        switch (method) {
            case "create":
            case "destroy":
              isPermitted = permissionScope === "entityAndProperties";
              break;
            case "read":
            case "update":
              isPermitted = permissionScope !== "propertiesOnly";
              break;
            case "list":
            case "list_all":
              // Only permitted if explicitly included in the JSON
              isPermitted = permissionScope !== "propertiesOnly";
              break;
            default:
              logger.error(`Error: Unknown method type: ${method}`);
              isPermitted = false;
          }

        if (isPermitted) {
          commentsRate = rateValue;
          break; // Exit the loop if permission is granted
        }
      }
    }

    if (!isPermitted) {
      return res.status(403).json({ message: "Permission denied" });
    }

    // If we've made it this far, permissions are valid
    if (commentsRate) {
      req.commentsRate = commentsRate; // Pass the value to the next middleware
      req.permissionScope = permissionScope; // Pass the permission scope to the next middleware
    }
    next();
  } catch (error) {
    console.error("Error 108: checking permissions:", error);
    return res.status(400).json({ message: "Error 109: Invalid token or permissions." });
  }
}

module.exports = validatepermissions;