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
  verify_rodit_istrusted_issuingsmartcontract,generate_jwt_token,roditconfig,get_session_jwk_public_key,
  base64url2jwk_public_key,hex2base64url,set_session_jwk_public_key
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
    let {own_rodit, own_roditid_base64url_signature, own_rodit_bytes_private_key, own_rodit_hex_accountid} = await roditconfig(config.CONFIGURATION_FILE_PATH);   

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

    const session_base64url_jwk_public_key = hex2base64url(own_rodit_hex_accountid);
    set_session_jwk_public_key(session_base64url_jwk_public_key);
    console.debug('get_session_jwk_public_key():', get_session_jwk_public_key());
  
    const token = await generate_jwt_token(peer_rodit, own_rodit, own_rodit_bytes_private_key, own_roditid_base64url_signature);
   
    logger.warn(`Info: Login attempt succeeded:`, peer_rodit.token_id);
    res.json({ token });

  } catch (error) {
    logger.error(`Error: Login failed: ${error}`);
    res.status(401).json({ message: 'Authentication failed', error: error.message });
  }
});

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
async function checkpermissions(req, res, next) {
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
    let commentsRate = null;

    for (const endpoint of endpoints) {
      const { url, _, entities } = endpoint;
      if (url === currentPath) {
        const operation = url.split("/").pop();
        console.debug(`operation: ${operation}`);
        switch (operation) {
          case 'create':
            isPermitted = entities.some(entity => {
              if (entity.R && entity.R.startsWith('+')) {
                commentsRate = entity.R;
                return true;
              }
              return false;
            });
            break;
          case 'read':
            isPermitted = entities.some(entity => {
              if (entity.R && (entity.R.startsWith('+') || !entity.R.startsWith('-'))) {
                commentsRate = entity.R;
                return true;
              }
              return false;
            });
            break;
          case 'update':
            isPermitted = entities.some(entity => {
              if (entity.R && (entity.R.startsWith('+') || !entity.R.startsWith('-'))) {
                commentsRate = entity.R;
                return true;
              }
              return false;
            });
            break;
          case 'destroy':
            isPermitted = entities.some(entity => {
              if (entity.R && entity.R.startsWith('+')) {
                commentsRate = entity.R;
                return true;
              }
              return false;
            });
            break;
          default:
            console.warn(`Unknown operation type: ${operation}`);
        }
        // if (operation === `list`) { commentsRate = 2; isPermitted=true;}  // In this example lists is always allowed
        if (isPermitted) break;  // Exit the loop if permission is granted
      }
    }

    if (!isPermitted) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    // If we've made it this far, permissions are valid
    if (commentsRate) {
      req.commentsRate = commentsRate; // Pass the value to the next middleware
    }
    next();
  } catch (error) {
    console.error('Error checking permissions:', error);
    return res.status(400).json({ message: 'Invalid token or permissions.' });
  }
}

// CG: This needs to be synched
async function authenticatetoken(req, res, next) {
const authHeader = req.headers['authorization'];
console.debug('authHeader:', authHeader);

let token;
if (authHeader) {
    const parts = authHeader.split(' ');
    console.debug('authHeader parts:', parts);
    token = parts.length > 1 ? parts[1] : null;
  }

  if (token == null) return res.sendStatus(401);

  try {
    const jwk_public_key = await base64url2jwk_public_key(get_session_jwk_public_key());
    console.debug('get_session_jwk_public_key():', get_session_jwk_public_key());
    const { payload, protectedHeader } = await jwtVerify(token, jwk_public_key, {
        algorithms: ['EdDSA']
    });
    req.user = payload;
    next();
  } catch (error) {
    console.error('Token verification failed:', error);
    return res.sendStatus(403);
  }
}

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

// Mount CRUDA protected route, where token is authenticated and permissions vetted
app.use('/api', authenticatetoken, crudarotectedRoute);

// Mount CRUDA protected route, where token is authenticated and permissions vetted
app.use('/api', echoprotectedRoute);

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
