const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
const SECRET_KEY = crypto.randomBytes(64).toString('hex');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Mock user database
const users = [
  { id: 1, roditid: 'user', roditsignature: 'password' }
];

// Custom middleware for JWT authentication
const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (authHeader) {
    const token = authHeader.split(' ')[1];

    jwt.verify(token, SECRET_KEY, { algorithms: ['HS256'] }, (err, payload) => {
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

app.post('/login', (req, res) => {
  const { roditid, roditsignature } = req.body;
  const user = users.find(u => u.roditid === roditid && u.roditsignature === roditsignature);

  if (user) {
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({
      iss: 'your-app-name',
      sub: user.id.toString(),
      aud: 'your-app-client',
      exp: now + 3600,
      nbf: now,
      iat: now,
      jti: urlSafeBase64(crypto.randomBytes(16).toString('base64')),
      roditid: user.roditid
    }, SECRET_KEY, { 
      algorithm: 'HS256',
      encoding: 'utf8',
      header: { 
        typ: 'JWT',
        alg: 'HS256'
      }
    });

    // Ensure the entire token is URL-safe
    const urlSafeToken = token.split('.').map(urlSafeBase64).join('.');

    res.json({ token: urlSafeToken });
  } else {
    res.status(401).json({ message: 'Invalid credentials' });
  }
});

app.get('/protected', authenticateJWT, (req, res) => {
  res.json({ message: 'This is a protected route', user: req.user });
});

// Start server
app.listen(3000, () => console.log('Server started on port 3000'));