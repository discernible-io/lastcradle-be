const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({ secret: 'your_session_secret', resave: false, saveUninitialized: false }));

// Mock user database
const users = [
  { id: 1, username: 'user', password: '$2b$10$ClcGRFpXxKjZ.9TngFwA9OSAQXdL7b.8oDVoNu.xazsOq9nO5mgga' } // hashed 'password'
];

// Custom middleware
const authenticateUser = (req, res, next) => {
  if (req.session.userId) {
    next();
  } else {
    res.status(401).json({ message: 'Unauthorized' });
  }
};

// Custom login middleware
const loginMiddleware = async (req, res, next) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);

  if (user && await bcrypt.compare(password, user.password)) {
    req.session.userId = user.id;
    next();
  } else {
    res.status(401).json({ message: 'Invalid credentials' });
  }
};

// Routes
app.get('/', (req, res) => {
  res.send(req.session.userId ? 'Welcome! <a href="/logout">Logout</a>' : 'Please <a href="/login">login</a>');
});

app.get('/login', (req, res) => {
  res.send('<form action="/login" method="post"><input type="text" name="username"><input type="password" name="password"><input type="submit" value="Login"></form>');
});

app.post('/login', loginMiddleware, (req, res) => {
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ message: 'Could not log out, please try again' });
    }
    res.redirect('/');
  });
});

app.get('/protected', authenticateUser, (req, res) => {
  res.json({ message: 'This is a protected route' });
});

// Start server
app.listen(3000, () => console.log('Server started on port 3000'));