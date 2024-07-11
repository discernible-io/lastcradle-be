const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const crypto = require('crypto');
const { ulid } = require('ulid');
const bs58 = require('bs58');
const nacl = require('tweetnacl');
nacl.util = require('tweetnacl-util');
const { verify_isthererodit_getit, verify_rodit_isamatch,verify_rodit_islive,Rodit} = require('./middleware/rodit');
const app = express();

// Generate key pair for the token
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const rodit_id = '01J21A0SCBQVF7RSKMQ945ET57';
const ownServiceProviderId = 'bc=near.org;sc=09313-cableguard-org.testnet;id=01J21A0S9NJCFXHZ3VA53K097M';
// const buffer_rodit_id = Buffer.from(rodit_id);
// const bytes_rodit_id = new Uint8Array(buffer_rodit_id);
// const pk = bs58.decode('2y5B1239V6KeB4sbgBJEmzn8r1zHd6XwDhDZCEkLJdAJWj5ttyezLRsqoGJ7RcTgJTBxJDQYTuUjinETTXoYMs85');
// const buffer_private_key = Buffer.from(pk);
// const bytes_private_key = new Uint8Array(buffer_private_key);
// const rodit_signature = nacl.sign.detached(bytes_rodit_id, bytes_private_key);
// const base64_rodit_signature = Buffer.from(rodit_signature).toString('base64');

const base64_rodit_signature = 'kWtnUDj6AmnhJqJQ2eHJTcopnsis8HH7rGOgPc6gy2Ipv2zFgMmxTR/gZp+fgwRIiyIKHLzAtDmpQnnHw9+BDg==';
// console.debug(`Info: rodit_signature ${base64_rodit_signature}`);
// {"roditid":"01J21A0SCBQVF7RSKMQ945ET57","roditsignature":"kWtnUDj6AmnhJqJQ2eHJTcopnsis8HH7rGOgPc6gy2Ipv2zFgMmxTR/gZp+fgwRIiyIKHLzAtDmpQnnHw9+BDg=="}

// Custom middleware for JWT authentication
const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.split(' ')[1];
    jwt.verify(token, publicKey, { algorithms: ['EdDSA'] }, (err, payload) => {
      if (err) {
        return res.status(403).json({ message: 'Invalid or expired token' });
      }
      req.user = payload;
      next();
    });
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
  const { roditid, roditsignature } = req.body;

  try {
    const rodit = await verify_isthererodit_getit(roditid, roditsignature);

    console.debug('app.js Rodit existence check is:', JSON.stringify(rodit));
    
    const IsVerified = await verify_rodit_isamatch(ownServiceProviderId, rodit.metadata.serviceprovidersignature, roditid);

    console.debug('app.s Rodit matches result is:', IsVerified );

    const IsLive = await verify_rodit_islive(rodit.metadata.notafter, rodit.metadata.notbefore);

    console.debug('app.js Rodit is live result is:', IsLive );

    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({
      iss: 'your-app-name',
      sub: JSON.stringify(rodit),
      aud: 'your-app-client',
      exp: now + 3600,
      nbf: now,
      iat: now,
      jti: ulid(),
      roditid: rodit.token_id  // Assuming 'token_id' is the correct property
    }, privateKey, {
      algorithm: 'ES256',
      header: {
        typ: 'JWT',
        alg: 'ES256'
      }
    });

    // Ensure the entire token is URL-safe
    const urlSafeToken = token.split('.').map(urlSafeBase64).join('.');
    res.json({ token: urlSafeToken });

  } catch (error) {
    console.error('Failed to verify or retrieve Rodit object:', error);
    res.status(401).json({ message: 'Invalid credentials' });
  }
});

app.get('/protected', authenticateJWT, (req, res) => {
  res.json({ message: 'This is a protected route', user: req.user });
});

// Start server
app.listen(3000, () => console.log('Server started on port 3000'));