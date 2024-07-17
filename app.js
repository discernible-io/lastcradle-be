const express   = require('express');
const { ulid }  = require('ulid');
const path      = require('path');
const os        = require('os');
const bs58      = require('bs58');
const fs        = require('fs').promises;
const crypto    = require('crypto');
const nacl      = require('tweetnacl');
nacl.util       = require('tweetnacl-util');
const { SignJWT, jwtVerify } = require('jose');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

const { CONSTANTS, Rodit, verify_isthererodit_getit, verify_rodit_isamatch, verify_rodit_islive, verify_rodit_isactive,
  verify_rodit_istrusted_issuingsmartcontract, nearorg_rpc_state, nearorg_rpc_tokensfromaccountid,
   } = require('./middleware/rodit');

// Configuration for Dev environment
const config = {
  PORT: process.env.PORT || 3000,
  JWT_EXPIRATION: 3600, // 1 hour
  ACCOUNT_FILE_PATH: path.join(
    os.homedir(),
    '.near-credentials',
    'testnet',
    '231f6501834fd10e4829e0ba2124efd55e7a1f2507c56bfb6442a588c557cfbd.json'
  ),
  APP_NAME: 'your-app-name', // Not is use atm
  APP_CLIENT: 'your-app-client' // Not in use atm
};

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
        url: 'http://localhost:3000/home.js',
      },
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'RODiT Development server',
      },
    ],
  },
  apis: ['./app.js', './routes/*.js'],
};

const swaggerSpec = swaggerJsdoc(options);

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Rodit middleware for JWT authentication

// Verify token if available
const authenticateJWT = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ message: 'Error: No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const { payload } = await jwtVerify(token, ownrodit_keyobject_public_key, {
      algorithms: ['EdDSA']
    });
    req.user = payload;
    next();
  } catch (err) {
    return res.status(403).json({ message: 'Error: Invalid or expired token' });
  }
};

// Serve static page
// app.use(express.static(path.join(__dirname, 'public')));

// Routes
// Static Page Route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * @swagger
 * /login:
 *   post:
 *     summary: Authenticate user
 *     description: Authenticate a user using their Rodit ID and signature
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               peer_roditid:
 *                 type: string
 *                 description: The Rodit ID of the user
 *               peer_roditid_base64url_signature:
 *                 type: string
 *                 description: The base64url signature of the Rodit ID
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
 *         description: Missing Rodit ID or Signature
 *       401:
 *         description: Authentication failed
 */
app.post('/login', async (req, res) => {
  const { peer_roditid, peer_roditid_base64url_signature } = req.body;

  if (!peer_roditid || !peer_roditid_base64url_signature) {
    return res.status(400).json({ message: 'Error: Missing Rodit ID and Signature' });
  }

  try {
    // A NEAR Protocol account id is also an Ed215519 public key
    // CG: We don´t need to do this for every login, only when starting the service
    const { accountId: ownrodit_hex_accountid, ownrodit_base58_private_key } = await processAccountFile(config.ACCOUNT_FILE_PATH);

    const result = await nearorg_rpc_state(CONSTANTS.BLOCKCHAIN_NETWORK, CONSTANTS.SMART_CONTRACT, ownrodit_hex_accountid);
    if (result === false) {
      throw new Error(`Error: The NEAR account has no balance in ${CONSTANTS.BLOCKCHAIN_NETWORK}`);
    }

    console.debug('Info: Client Rodit ID:', peer_roditid);
    console.debug('Info: Client Rodit ID Signature:', peer_roditid_base64url_signature);
    const own_rodit = await nearorg_rpc_tokensfromaccountid(CONSTANTS.BLOCKCHAIN_NETWORK, CONSTANTS.SMART_CONTRACT, ownrodit_hex_accountid);
    const peer_rodit = await verify_isthererodit_getit(peer_roditid, peer_roditid_base64url_signature);
    
    const isVerified = await verify_rodit_isamatch(own_rodit.metadata.serviceproviderid, peer_rodit.metadata.serviceprovidersignature, peer_roditid);
    const isLive = await verify_rodit_islive(peer_rodit.metadata.notafter, peer_rodit.metadata.notbefore);
    const isActive = await verify_rodit_isactive(peer_roditid, own_rodit.metadata.subjectuniqueidentifierurl);
    const isTrusted = await verify_rodit_istrusted_issuingsmartcontract(own_rodit.metadata.subjectuniqueidentifierurl);

    if (!isVerified || !isLive || !isActive || !isTrusted) {
      throw new Error('Error: Rodit verification failed');
    }

    const now = Math.floor(Date.now() / 1000);
    const ownrodit_private_key = bs58.decode(ownrodit_base58_private_key);
    const ownrodit_bytes_private_key = new Uint8Array(Buffer.from(ownrodit_private_key));
    const ownrodit_bytes_roditid = new Uint8Array(Buffer.from(own_rodit.token_id));
    const ownrodit_bytes_signature = nacl.sign.detached(ownrodit_bytes_roditid, ownrodit_bytes_private_key);
    const ownrodit_base64url_signature = Buffer.from(ownrodit_bytes_signature).toString('base64url');
    const ownrodit_bytes_public_key = new Uint8Array(Buffer.from(own_rodit.owner_id, 'hex'));

    const ownrodit_keyobject_public_key = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'), // Ed25519 public key header
        ownrodit_bytes_public_key
      ]),
      format: 'der',
      type: 'spki'
    });
    
    // For private key
    const ownrodit_keyobject_private_key = crypto.createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'), // Ed25519 private key header
        ownrodit_bytes_private_key
      ]),
      format: 'der',
      type: 'pkcs8'
    });

    // Make sure that the token will not last beyond the expiration date of the Rodit
    const notafter = await dateStringToUnixTime(peer_rodit.metadata.notafter); 
    let expiresat=now;
    if ((now + config.JWT_EXPIRATION) < notafter) {
      expiresat = now + config.JWT_EXPIRATION;
    } else {
      throw new Error('Rodit duration check failed');
    }

    console.debug('Info: This API endpoint Login of Client check passed');
    const notbefore = await dateStringToUnixTime(own_rodit.metadata.notbefore); 
    
    const token = await new SignJWT({
      iss: own_rodit.metadata.subjectuniqueidentifierurl, // App name, CG: change name to fit iss
      sub: peer_rodit.metadata.serviceproviderid + ";sub=" +peer_rodit.token_id, // Unique Id of the client
      aud: peer_rodit.metadata.serviceproviderid, // App Client
      exp: expiresat, 
      nbf: notbefore,
      iat: now,
      jti: "jti"+ulid(), // jti added to distinguish this quickly visually from the rodit_id
      // amr: "near.org/rodit" // field added to indicate which blockchain and authentication method version has been used
      roditid: own_rodit.token_id,
      roditidsignature: ownrodit_base64url_signature
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .sign(ownrodit_keyobject_private_key);

    res.json({ token });

  } catch (error) {
    console.error('Login failed:', error);
    res.status(401).json({ message: 'Authentication failed', error: error.message });
  }
});

app.get('/protected', authenticateJWT, (req, res) => {
  res.json({ message: 'This is a protected route', user: req.user });
});

// Import protected route
const protectedRoutes = require('./protected/echo');

// Mount protected route
app.use('/api', protectedRoutes);

async function processAccountFile(accountFileName) {
  try {
    const accountFileContents = await fs.readFile(accountFileName, 'utf8');
    const json = JSON.parse(accountFileContents);

    const accountId = json.implicit_account_id;
    if (typeof accountId !== 'string') {
      throw new Error('Invalid or missing account_id value');
    }

    let own_string_private_key = json.private_key;
    if (typeof own_string_private_key !== 'string') {
      throw new Error('Invalid private_key value');
    }
    const ownrodit_base58_private_key = own_string_private_key.split(':')[1];

    return { accountId, ownrodit_base58_private_key };
  } catch (err) {
    console.error(`Error processing account file: ${err.message}`);
    throw err;
  }
}

async function dateStringToUnixTime(dateString) {
  // Create a new Date object from the string
  const date = new Date(dateString);
  
  // Get the Unix timestamp (in milliseconds)
  const unixTimeMs = date.getTime();
  
  // Convert milliseconds to seconds and round down
  const unixTimeSec = Math.floor(unixTimeMs / 1000);
  
  return unixTimeSec;
}

// Start server
app.listen(config.PORT, () => console.log(`Server started on port ${config.PORT}`));