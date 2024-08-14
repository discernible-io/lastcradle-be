const { decodeJwt } = require("jose");

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
    console.debug(`Info: Endpoint reached: ${req.path}`);
    const permissionedRoutes = JSON.parse(
      decodedToken.rodit_permissionedroutes
    );
    const { endpoints } = permissionedRoutes;
    const currentPath = req.path;
    let isPermitted = false;
    let commentsRate = null;

    // Verify Rate and sign (+ for entity and property, - for property only, nada for entity only) to each route for internal processing
    for (const endpoint of endpoints) {
      const { url, _, entities } = endpoint;
      console.debug(`url: ${url}`);
      if (url === currentPath) {
        const method = url.split("/").pop();
        console.debug(`method: ${method}`);
        switch (method) {
          case "create":
            isPermitted = entities.some((entity) => {
              if (entity.R && entity.R.startsWith("+")) {
                commentsRate = entity.R;
                return true;
              }
              return false;
            });
            break;
          case "read":
            isPermitted = entities.some((entity) => {
              if (
                entity.R &&
                (entity.R.startsWith("+") || !entity.R.startsWith("-"))
              ) {
                commentsRate = entity.R;
                return true;
              }
              return false;
            });
            break;
          case "update":
            isPermitted = entities.some((entity) => {
              if (
                entity.R &&
                (entity.R.startsWith("+") || !entity.R.startsWith("-"))
              ) {
                commentsRate = entity.R;
                return true;
              }
              return false;
            });
            break;
          case "destroy":
            isPermitted = entities.some((entity) => {
              if (entity.R && entity.R.startsWith("+")) {
                commentsRate = entity.R;
                return true;
              }
              return false;
            });
            break;
          // CG TEST LIST OK
          case "list":
            isPermitted = entities.some((entity) => {
              if (entity.R && entity.R.startsWith("+")) {
                commentsRate = entity.R;
                return true;
              }
              return true;
            });
            break;
          default:
            console.debug(`Unknown method type: ${method}`);
        }
        if (isPermitted) break; // Exit the loop if permission is granted
      }
    }

    if (!isPermitted) {
      return res.status(403).json({ message: "Permission denied" });
    }

    // If we've made it this far, permissions are valid
    if (commentsRate) {
      req.commentsRate = commentsRate; // Pass the value to the next middleware
    }
    next();
  } catch (error) {
    console.error("Error 108: checking permissions:", error);
    return res.status(400).json({ message: "Error 109: Invalid token or permissions." });
  }
}

module.exports = validatepermissions;
