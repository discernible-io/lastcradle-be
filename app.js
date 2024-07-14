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
const { SignJWT, jwtVerify, generateKeyPair } = require('jose');
const app = express();

// Generate key pair for the token
let privateKey, publicKey;

(async () => {
  const keyPair = await generateKeyPair('EdDSA');
  privateKey = keyPair.privateKey;
  publicKey = keyPair.publicKey;
})();


// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const peer_rodit_id = '01J21A0SCBQVF7RSKMQ945ET57';
const base64_rodit_signature = 'kWtnUDj6AmnhJqJQ2eHJTcopnsis8HH7rGOgPc6gy2Ipv2zFgMmxTR/gZp+fgwRIiyIKHLzAtDmpQnnHw9+BDg==';

// const peer_account_id = '7fa445b786f8358c5125801cc914364668fed057d9ef80f814c60deedbabc9f2';
// const rodit_signature = nacl.sign.detached(bytes_rodit_id, bytes_private_key);
// console.debug(`Info: rodit_signature ${base64_rodit_signature}`);
// {"roditid":"01J21A0SCBQVF7RSKMQ945ET57","roditsignature":"kWtnUDj6AmnhJqJQ2eHJTcopnsis8HH7rGOgPc6gy2Ipv2zFgMmxTR/gZp+fgwRIiyIKHLzAtDmpQnnHw9+BDg=="}

// Custom middleware for JWT authentication
const authenticateJWT = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader) {
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
  } else {
    res.status(401).json({ message: 'No token provided' });
  }
};

// Function to create a URL-safe base64 encoded string
function urlSafeBase64(string) {
  return string.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Routes
app.get('/', (req, res) => {
  res.send('Welcome! Use /login to get a token.');
});

app.post('/login', async (req, res) => {
  const { peer_rodit_id, base64_peer_rodit_id_signature } = req.body;
  let own_account_id;
  let own_base58_private_key;
  try {
    const accountFileName = path.join(
      os.homedir(),
      '.near-credentials',
      'testnet',
      '231f6501834fd10e4829e0ba2124efd55e7a1f2507c56bfb6442a588c557cfbd.json'
    );
    let result = await processAccountFile(accountFileName);
    console.log('Own Account ID:', result.accountId);
    console.log('Private Key:', result.own_base58_private_key);
    own_account_id = result.accountId;
    own_base58_private_key = result.own_base58_private_key;

  } catch (err) {
    console.error('An error occurred fetching Account ID and Private Key:', err);
    process.exit(1);
  }

  try {
    try {
      const result = await nearorg_rpc_state(CONSTANTS.BLOCKCHAIN_NETWORK, CONSTANTS.SMART_CONTRACT, own_account_id);
      if ( result === false ) { 
        console.error(`Error: The NEAR account has no balance in ${CONSTANTS.BLOCKCHAIN_NETWORK}`);
        process.exit(1);
        }
    } catch (err) {
      console.error(`Error: The NEAR account has no balance in ${CONSTANTS.BLOCKCHAIN_NETWORK}, ${err.message}`);
      process.exit(1);
    }

    // CG: All following checks need to be passed before the JSON token is issued
  const own_rodit = await nearorg_rpc_tokensfromaccountid(CONSTANTS.BLOCKCHAIN_NETWORK, CONSTANTS.SMART_CONTRACT, own_account_id);

  console.debug('app.js Own Rodit is:', JSON.stringify(own_rodit));

  console.debug('app.js peer_rodit_id', peer_rodit_id);
  const peer_rodit = await verify_isthererodit_getit(peer_rodit_id, base64_peer_rodit_id_signature);

  console.debug('app.js Peer Rodit:', JSON.stringify(peer_rodit));
  
  const IsVerified = await verify_rodit_isamatch(own_rodit.metadata.serviceproviderid, peer_rodit.metadata.serviceprovidersignature, peer_rodit_id);

  console.debug('app.s Rodit matches result is:', IsVerified );

  const IsLive = await verify_rodit_islive(peer_rodit.metadata.notafter, peer_rodit.metadata.notbefore);

  console.debug('app.js Rodit is live result is:', IsLive );

  const IsActive = await verify_rodit_isactive(peer_rodit_id, own_rodit.metadata.subjectuniqueidentifierurl)

  console.debug('app.js Rodit is active result is:', IsActive );

  const IsTrusted = await verify_rodit_istrusted_issuingsmartcontract(own_rodit.metadata.subjectuniqueidentifierurl)

  console.debug('app.js Rodit smartcontract is trusted result is:', IsTrusted );

    const now = Math.floor(Date.now() / 1000);

    const account_id_private_key = bs58.decode(own_base58_private_key);
    const buffer_account_id_private_key = Buffer.from(account_id_private_key);
    const bytes_account_id_private_key = new Uint8Array(buffer_account_id_private_key);

    const buffer_own_rodit_id = Buffer.from(own_rodit.token_id);
    const bytes_own_rodit_id = new Uint8Array(buffer_own_rodit_id);
    const ownrodit_signature = nacl.sign.detached(bytes_own_rodit_id, bytes_account_id_private_key);
    const base64_ownrodit_signature = Buffer.from(ownrodit_signature).toString('base64');

    const token = await new SignJWT({
      iss: 'your-app-name',
      sub: JSON.stringify(peer_rodit.token_id),
      aud: 'your-app-client',
      exp: now + 3600,
      nbf: now,
      iat: now,
      jti: ulid(),
      roditid: own_rodit.token_id,
      roditidsignature: base64_ownrodit_signature
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .sign(privateKey);

    res.json({ token });

  } catch (error) {
    console.error('Failed to verify or retrieve Rodit object:', error);
    res.status(401).json({ message: 'Invalid credentials' });
  }
});

app.get('/protected', authenticateJWT, (req, res) => {
  res.json({ message: 'This is a protected route', user: req.user });
});


async function processAccountFile(accountFileName) {
  try {
    // Read the file contents
    const accountFileContents = await fs.readFile(accountFileName, 'utf8');

    // Parse the JSON
    const json = JSON.parse(accountFileContents);

    // Obtain the value of the "account_id" field
    const accountId = json.implicit_account_id;

    if (accountId === undefined) {
      console.warn(`Warning: implicit_account_id is undefined. JSON keys:`, Object.keys(json));
    }

    if (typeof accountId !== 'string') {
      throw new Error('Invalid or missing account_id value');
    }

    // Obtain the value of the "private_key" field and trim the "ed25519:" prefix
    let own_string_private_key = json.private_key;
    
    if (typeof own_string_private_key !== 'string') {
      throw new Error('Invalid private_key value');
    }
    const own_base58_private_key = own_string_private_key.split(':')[1];
    console.debug(`Debug: own_base58_private_key`, own_base58_private_key);
    return { accountId, own_base58_private_key };
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`Error: Failed to open the file with the accountId: ${err.message}`);
    } else if (err instanceof SyntaxError) {
      console.error(`Error: Failed to parse JSON of the file with the accountId: ${err.message}`);
    } else {
      console.error(`Error: ${err.message}`);
    }
    throw err;
  }
}

// Start server
app.listen(3000, () => console.log('Server started on port 3000'));