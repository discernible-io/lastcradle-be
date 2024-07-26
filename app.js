const express   = require('express');
const cors      = require('cors');
const nacl      = require('tweetnacl');
nacl.util       = require('tweetnacl-util');
const config    = require('config');
const ratelimitmw = require("./middleware/ratelimit");
const logger = require('./config/logger');
const loggingmw = require('./middleware/loggingmw');
const { importJWK, jwtVerify , decodeJwt , SignJWT}  = require('jose');
const swaggerUi  = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

const { verify_hasrodit_getit, verify_rodit_isamatch, verify_rodit_islive, verify_rodit_isactive,
  verify_rodit_istrusted_issuingsmartcontract,generate_jwt_token,roditconfig
   } = require('./middleware/rodit');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'RODiT prototype API',
      version: '1.0.0',
      description:
        'This is a REST API application made with Express. It just echoes whatever string you send to it.',
      // license: {
      //  name: 'Licensed Under MIT',
      //  url: 'https://spdx.org/licenses/MIT.html',
      //},
      contact: {
        name: 'JSONPlaceholder for the contact name',
        url: 'https://localhost:3000/home.js',
      },
    },
    servers: [
      {
        url: 'https://localhost:3000',
        description: 'RODiT Development server',
      },
    ],
  },
  apis: ['./app.js', './routes/*.js'],
};

const swaggerSpec = swaggerJsdoc(options);
const app = express();

// Delayed starting of port needs to be obtained from elsewhere (file, etc)
async function get_own_port() {  
  return 3000;
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Routes

// Log in route
/**
 * @swagger
 * /login:
 *   post:
 *     summary: Authenticate user
 *     description: Authenticate a user using their RODiT ID and signature
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               peer_roditid:
 *                 type: string
 *                 description: The RODiT ID of the user
 *               peer_roditid_base64url_signature:
 *                 type: string
 *                 description: The base64url signature of the RODiT ID
 *     responses:
 *       200:
 *         description: Successful authentication
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                   description: JWT token for authenticated session
 *       400:
 *         description: Missing RODiT ID or Signature
 *       401:
 *         description: Authentication failed
 */
app.post('/login', async (req, res, next) => {
  // Log the action
  req.logAction = 'login-attempt';
  next();
}, async (req, res) => {
  const { roditid, roditid_base64url_signature } = req.body;
  
  let peer_roditid = roditid;
  let peer_roditid_base64url_signature = roditid_base64url_signature;
  console.debug('Info: Client RODiT ID:', peer_roditid);
  console.debug('Info: Client RODiT ID Signature:', peer_roditid_base64url_signature);

  if (!peer_roditid || !peer_roditid_base64url_signature) {
    return res.status(400).json({ message: 'Error: Missing RODiT ID and Signature' });
  }

  try {
    let {own_rodit, own_roditid_base64url_signature, own_rodit_bytes_private_key} = await roditconfig(config.CONFIGURATION_FILE_PATH);   

    console.debug('Info: own_rodit:', own_rodit);

    if (own_rodit.metadata.maxrequests && own_rodit.metadata.maxrqwindow) {
      updateratelimit(own_rodit.metadata.maxrequests, own_rodit.metadata.maxrqwindow);
    } else {
      console.debug('Warning: Unable to update rate limit due to missing data');
    }

    const peer_rodit = await verify_hasrodit_getit(peer_roditid, peer_roditid_base64url_signature);

    const [isVerified, isLive, isActive, isTrusted] = await Promise.all([
      verify_rodit_isamatch(own_rodit.metadata.serviceproviderid, peer_rodit.metadata.serviceprovidersignature, peer_rodit.token_id),
      verify_rodit_islive(peer_rodit.metadata.notafter, peer_rodit.metadata.notbefore),
      verify_rodit_isactive(peer_rodit.token_id, own_rodit.metadata.subjectuniqueidentifierurl),
      verify_rodit_istrusted_issuingsmartcontract(own_rodit.metadata.subjectuniqueidentifierurl)
    ]);

    if (!isVerified || !isLive || !isActive || !isTrusted) {
      throw new Error('Error: RODiT verification failed');
    }

    const token = await generate_jwt_token(peer_rodit, own_rodit, own_rodit_bytes_private_key, own_roditid_base64url_signature);
    logger.warn(`Info: Login attempt succeeded:`, peer_rodit.token_id);
    res.json({ token });

  } catch (error) {
    logger.error(`Error: Login failed: ${error}`);
    res.status(401).json({ message: 'Authentication failed', error: error.message });
  }
});

// Using validateloginrequest_producetoken does not work yet
/*
app.post('/login', async (req, res) => {
  const { roditid, roditid_base64url_signature } = req.body;

  try {
    const { own_rodit, token } = await validateloginrequest_producetoken(roditid, roditid_base64url_signature);

    if (own_rodit.metadata.maxrequests && own_rodit.metadata.maxrqwindow) {
      updateratelimit(own_rodit.metadata.maxrequests, own_rodit.metadata.maxrqwindow);
    } else {
      console.debug('Warning: Unable to update rate limit due to missing data');
    }

    res.json(token);
  } catch (error) {
    res.status(401).json({ message: error.message });
  }
});
*/

app.use((req, res, next) => {
  if (req.logAction) {
    logger.info(`Action logged: ${req.logAction}`);
  }
  next();
});

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
function checkpermissions(req, res, next) {
  const token = req.header('Authorization');
  if (!token) {
    return res.status(401).json({ message: 'Access denied. No token provided.' });
  }

  try {
    const decodedToken = decodeJwt(token);
    console.debug("decoded token:", decodedToken.rodit_permissionedroutes);
    console.debug(`Endpoint reached: ${req.path}`);

    const permissionedRoutes = JSON.parse(decodedToken.rodit_permissionedroutes);
    const { endpoints } = permissionedRoutes;
    const currentPath = req.path;
    let isPermitted = false;

    for (const endpoint of endpoints) {
      const { url, _, entities } = endpoint;
      if (url === currentPath) {
        const operation = url.split("/").pop();
        console.debug(`operation: ${operation}`);
        switch (operation) {
          case 'create':
            isPermitted = entities.some(entity => entity.R && entity.R.startsWith('+'));
            break;
          case 'read':
            isPermitted = entities.some(entity => entity.R && (entity.R.startsWith('+') || !entity.R.startsWith('-')));
            break;
          case 'update':
            isPermitted = entities.some(entity => entity.R && (entity.R.startsWith('+') || !entity.R.startsWith('-')));
            break;
          case 'destroy':
            isPermitted = entities.some(entity => entity.R && entity.R.startsWith('+'));
            break;
          default:
            console.warn(`Unknown operation type: ${operation}`);
        }

        if (isPermitted) break;  // Exit the loop if permission is granted
      }
    }

    if (!isPermitted) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    // If we've made it this far, permissions are valid
    next();
  } catch (error) {
    console.error('Error checking permissions:', error);
    return res.status(400).json({ message: 'Invalid token or permissions.' });
  }
}

/*
app.get('/authorize', checkpermissions, (req, res) => {
  const { token_id, notafter, notbefore } = req.user;

  // Check if required fields are present
  if (!token_id || !notafter || !notbefore) {
    return res.status(401).json({ message: 'Missing required fields in token' });
  }

  // Check if token is still valid (not expired)
  const currentTime = Math.floor(Date.now() / 1000); // Current time in seconds
  if (currentTime < notbefore || currentTime > notafter) {
    return res.status(401).json({ message: 'Token is not valid at this time' });
  }

  // If all checks pass, send success response
  res.json({ message: 'Authorization successful', user: req.user });
});
*/

/*
function checkpermissions(req, res, next) {
  const token = req.header('Authorization');
  if (!token) return res.status(401).json({ message: 'Access denied. No token provided.' });

  try {
    console.debug("decoded token:",decodeJwt(token).rodit_permissionedroutes);
    console.debug(`Endpoint reached: ${req.path}`);
    next();
  } catch (error) {
    res.status(400).json({ message: 'Invalid token.' });
  }
}
*/


// Import protected routes
const echoprotectedRoute = require('./protected/echo');
const crudarotectedRoute = require('./protected/cruda');

// Mount Logging middleware
app.use(loggingmw);

// Mount rate limiter route
app.use((req, res, next) => ratelimitmwph(req, res, next));

// CG: Logging error handling, to be improved
app.use((err, req, res, next) => {
  logger.error({
    message: err.message,
    stack: err.stack,
    method: req.method,
    url: req.originalUrl,
    userIP: req.ip,
    userId: req.user ? req.user.id : 'anonymous',
  });
  res.status(500).json({ error: 'Internal Server Error' });
});

// Mount CRUDA protected route
app.use('/api', checkpermissions, crudarotectedRoute);

// Mount ECHO protected route
app.use('/api', checkpermissions, echoprotectedRoute);

// Update rate limit once obtained config from RODiT
function updateratelimit(maxrequests, maxrqwindow) {
  ratelimitmwph = ratelimitmw(maxrequests, maxrqwindow);
}

// Start server
get_own_port().then((port) => {
  logger.info(`Server started on port ${port}`);
  app.listen(port, () => console.log(`Server started on port ${port}`));
}).catch(err => {
  logger.error('Error: Failed to get the listen port: ${err}');
});
