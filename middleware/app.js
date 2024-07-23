const express   = require('express');
const { ulid }  = require('ulid');
const path      = require('path');
const cors      = require('cors');
const crypto    = require('crypto');
const nacl      = require('tweetnacl');
nacl.util       = require('tweetnacl-util');
const config     = require('config');
const ratelimitmw = require("./middleware/ratelimit");
const { SignJWT, jwtVerify } = require('jose');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

const { CONSTANTS, RODiT, verify_hasrodit_getit, verify_rodit_isamatch, verify_rodit_islive, verify_rodit_isactive,
  verify_rodit_istrusted_issuingsmartcontract,dateStringToUnixTime,roditconfig
   } = require('./middleware/rodit');

// let own_rodit;

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

// RODiT middleware for JWT authentication
const authenticateJWT = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ message: 'Error: No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const { payload } = await jwtVerify(token, own_rodit_keyobject_public_key, {
      algorithms: ['EdDSA']
    });

    req.user = payload;
    next();
  } catch (err) {
    if (err.code === 'ERR_JWT_EXPIRED') {
      return res.status(401).json({ message: 'Error: Token has expired' });
    }
    return res.status(403).json({ message: 'Error: Invalid token' });
  }
};

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
app.post('/login', async (req, res) => {
  const { roditid, roditid_base64url_signature } = req.body;
  peer_roditid = roditid;
  peer_roditid_base64url_signature = roditid_base64url_signature;
  console.debug('Info: Client RODiT ID:', peer_roditid);
  console.debug('Info: Client RODiT ID Signature:', peer_roditid_base64url_signature);
  if (!peer_roditid || !peer_roditid_base64url_signature) {
    return res.status(400).json({ message: 'Error: Missing RODiT ID and Signature' });
  }

  try {
    let {own_rodit, own_roditid_base64url_signature, own_rodit_bytes_private_key} = await roditconfig(config.CONFIGURATION_FILE_PATH);   

    console.debug('Info: own_rodit:', own_rodit);

    // For private key
    const own_rodit_keyobject_private_key = crypto.createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'), // Ed25519 private key header
        own_rodit_bytes_private_key
      ]),
      format: 'der',
      type: 'pkcs8'
    });

    if (own_rodit.metadata.maxrequests && own_rodit.metadata.maxrqwindow) {
      updateratelimit(own_rodit.metadata.maxrequests, own_rodit.metadata.maxrqwindow);
    } else {
      console.warn('Warning: Unable to update rate limit due to missing data');
    }

    console.debug('Info: peer_roditid:', peer_roditid);
    console.debug('Info: peer_roditid_base64url_signature:', peer_roditid_base64url_signature);
    const peer_rodit = await verify_hasrodit_getit(peer_roditid, peer_roditid_base64url_signature);

    const isVerified = await verify_rodit_isamatch(own_rodit.metadata.serviceproviderid, peer_rodit.metadata.serviceprovidersignature, peer_roditid);
  
    const isLive = await verify_rodit_islive(peer_rodit.metadata.notafter, peer_rodit.metadata.notbefore);
    
    const isActive = await verify_rodit_isactive(peer_roditid, own_rodit.metadata.subjectuniqueidentifierurl);
    
    const isTrusted = await verify_rodit_istrusted_issuingsmartcontract(own_rodit.metadata.subjectuniqueidentifierurl);

    if (!isVerified || !isLive || !isActive || !isTrusted) {
      throw new Error('Error: RODiT verification failed');
    }

    const now = Math.floor(Date.now() / 1000);

    // Make sure that the token will not last beyond the expiration date of the RODiT
    const notafter = await dateStringToUnixTime(peer_rodit.metadata.notafter); 
    const duration = parseInt(peer_rodit.metadata.jwtduration, 10);
    let expiresat=now;
    
    if ((now + duration) < notafter) {
      expiresat = parseInt(now) + parseInt(peer_rodit.metadata.jwtduration);
    } else {
      throw new Error('RODiT duration check failed');
    }

    console.info('Info: This API endpoint Login of Client check passed');
    const notbefore = await dateStringToUnixTime(own_rodit.metadata.notbefore); 
    
    /*
    4 HTTPS it dinamically
    6 SRV it?
    7 Geographic restrictions
    8 SLA
    */

    const token = await new SignJWT({
      iss: own_rodit.metadata.subjectuniqueidentifierurl, // App Name
      sub: peer_rodit.metadata.serviceproviderid + ";sub=" +peer_rodit.token_id, // Unique Id of the client
      aud: peer_rodit.metadata.serviceproviderid, // App Client
      exp: expiresat,
      nbf: notbefore,
      iat: now,
      jti: "jti"+ulid(), // jti added to distinguish this quickly visually from the rodit_id
      // amr: "near.org/rodit" // field added to indicate which blockchain and authentication method version has been used
      rodit_id: own_rodit.token_id,
      rodit_idsignature: own_roditid_base64url_signature,
      rodit_maxrequests: own_rodit.metadata.maxrequests,
      rodit_maxrqwindow: own_rodit.metadata.maxrqwindow,
      rodit_permissionedroutes: own_rodit.metadata.permissionedroutes
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .sign(own_rodit_keyobject_private_key);

    res.json({ token });

  } catch (error) {
    console.error('Error: Login failed:', error);
    res.status(401).json({ message: 'Authentication failed', error: error.message });
  }
});

//
app.get('/protected', authenticateJWT, (req, res) => {
  res.json({ message: 'This is a protected route', user: req.user });
});

// Temporary protected route while config is obtained
let ratelimitmwph = (req, res, next) => {
  next();
};

// Mount rate limiter route
app.use((req, res, next) => ratelimitmwph(req, res, next));

// Import protected route
const protectedRoutes = require('./protected/echo');

// Mount protected route
app.use('/api', protectedRoutes);

// Update rate limit once obtained config from RODiT
function updateratelimit(maxrequests, maxrqwindow) {
  ratelimitmwph = ratelimitmw(maxrequests, maxrqwindow);
}

// Start server
get_own_port().then((port) => {
  app.listen(port, () => console.log(`Server started on port ${port}`));
}).catch(err => {
  console.error('Error: Failed to get the listen port:', err);
});
