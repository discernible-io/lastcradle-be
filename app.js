const express = require('express');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { ulid } = require('ulid');
const bs58 = require('bs58');
const fs = require('fs').promises;
const nacl = require('tweetnacl');
nacl.util = require('tweetnacl-util');
const { verify_isthererodit_getit, verify_rodit_isamatch, verify_rodit_islive, verify_rodit_isactive,
  verify_rodit_istrusted_issuingsmartcontract, nearorg_rpc_state, nearorg_rpc_tokensfromaccountid,
  CONSTANTS, Rodit } = require('./middleware/rodit');
const { SignJWT, jwtVerify, generateKeyPair, importJWK  } = require('jose');

// Configuration
const config = {
  PORT: process.env.PORT || 3000,
  JWT_EXPIRATION: 3600, // 1 hour
  ACCOUNT_FILE_PATH: path.join(
    os.homedir(),
    '.near-credentials',
    'testnet',
    '231f6501834fd10e4829e0ba2124efd55e7a1f2507c56bfb6442a588c557cfbd.json'
  ),
  APP_NAME: 'your-app-name',
  APP_CLIENT: 'your-app-client'
};

const app = express();

// Generate key pair for the token
let privateKey, publicKey;

(async () => {
  try {
    const keyPair = await generateKeyPair('EdDSA');
    privateKey = keyPair.privateKey;
    publicKey = keyPair.publicKey;
  } catch (error) {
    console.error('Failed to generate key pair:', error);
    process.exit(1);
  }
})();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Custom middleware for JWT authentication
const authenticateJWT = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ message: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: ['EdDSA']
    });
    req.user = payload;
    next();
  } catch (err) {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
};

// Routes
app.get('/', (req, res) => {
  res.send('Welcome! Use /login to get a token.');
});

app.post('/login', async (req, res) => {
  const { peer_rodit_id, base64_peer_rodit_id_signature } = req.body;

  if (!peer_rodit_id || !base64_peer_rodit_id_signature) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  try {
    const { accountId: own_account_id, own_base58_private_key } = await processAccountFile(config.ACCOUNT_FILE_PATH);

    const result = await nearorg_rpc_state(CONSTANTS.BLOCKCHAIN_NETWORK, CONSTANTS.SMART_CONTRACT, own_account_id);
    if (result === false) {
      throw new Error(`The NEAR account has no balance in ${CONSTANTS.BLOCKCHAIN_NETWORK}`);
    }

    const own_rodit = await nearorg_rpc_tokensfromaccountid(CONSTANTS.BLOCKCHAIN_NETWORK, CONSTANTS.SMART_CONTRACT, own_account_id);
    const peer_rodit = await verify_isthererodit_getit(peer_rodit_id, base64_peer_rodit_id_signature);
    
    const isVerified = await verify_rodit_isamatch(own_rodit.metadata.serviceproviderid, peer_rodit.metadata.serviceprovidersignature, peer_rodit_id);
    const isLive = await verify_rodit_islive(peer_rodit.metadata.notafter, peer_rodit.metadata.notbefore);
    const isActive = await verify_rodit_isactive(peer_rodit_id, own_rodit.metadata.subjectuniqueidentifierurl);
    const isTrusted = await verify_rodit_istrusted_issuingsmartcontract(own_rodit.metadata.subjectuniqueidentifierurl);

    if (!isVerified || !isLive || !isActive || !isTrusted) {
      throw new Error('Rodit verification failed');
    }

    const now = Math.floor(Date.now() / 1000);
    const account_id_private_key = bs58.decode(own_base58_private_key);
    const bytes_account_id_private_key = new Uint8Array(Buffer.from(account_id_private_key));
    const bytes_own_rodit_id = new Uint8Array(Buffer.from(own_rodit.token_id));
    const ownrodit_signature = nacl.sign.detached(bytes_own_rodit_id, bytes_account_id_private_key);
    const base64_ownrodit_signature = Buffer.from(ownrodit_signature).toString('base64');

    // Make sure that the token will not last beyond the expiration date of the Rodit
    const notafter = await dateStringToUnixTime(peer_rodit.metadata.notafter); 
    let expiresat=now;
    if ((now + config.JWT_EXPIRATION) < notafter) {
      expiresat = now + config.JWT_EXPIRATION;
    } else {
      throw new Error('Rodit duration check failed');
    }

    const notbefore = await dateStringToUnixTime(own_rodit.metadata.notbefore); 
    
    const token = await new SignJWT({
      iss: own_rodit.metadata.subjectuniqueidentifierurl, // App name 
      sub: JSON.stringify(peer_rodit.metadata.serviceproviderid + peer_rodit.token_id), // Unique Id of the client
      aud: JSON.stringify(peer_rodit.metadata.serviceproviderid), // App Client
      exp: expiresat, // CG: Calculate exp as a function of the peer rodit expiration and the JWT session duration configured in the Rodit
      nbf: notbefore,
      iat: now,
      jti: ulid(),
      roditid: own_rodit.token_id,
      roditidsignature: base64_ownrodit_signature
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .sign(privateKey);

    res.json({ token });

  } catch (error) {
    console.error('Login failed:', error);
    res.status(401).json({ message: 'Authentication failed', error: error.message });
  }
});

app.get('/protected', authenticateJWT, (req, res) => {
  res.json({ message: 'This is a protected route', user: req.user });
});

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
    const own_base58_private_key = own_string_private_key.split(':')[1];

    return { accountId, own_base58_private_key };
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