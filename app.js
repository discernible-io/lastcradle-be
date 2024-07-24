const express   = require('express');
const path      = require('path');
const cors      = require('cors');
const nacl      = require('tweetnacl');
nacl.util       = require('tweetnacl-util');
const config     = require('config');
const ratelimitmw = require("./middleware/ratelimit");
const { SignJWT, jwtVerify } = require('jose');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

const { verify_hasrodit_getit, verify_rodit_isamatch, verify_rodit_islive, verify_rodit_isactive,
  verify_rodit_istrusted_issuingsmartcontract,generate_jwt_token,roditconfig
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
  // The variables roditid, roditid_base64url_signature must match in name 
  // with the variables used in the client side
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
      console.info('Warning: Unable to update rate limit due to missing data');
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

    /*
    4 HTTPS it dinamically
    6 SRV it?
    7 Geographic restrictions
    8 SLA
    */

    const token = await generate_jwt_token(peer_rodit,own_rodit,own_rodit_bytes_private_key,own_roditid_base64url_signature);
    
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
