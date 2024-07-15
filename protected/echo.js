const express = require('express');
const router = express.Router();

// Protected route that echoes the input
router.post('/echo', (req, res) => {
  // Your echo logic here
  const inputString = req.body.message;
  if (!inputString) {
    return res.status(400).json({ error: 'No message provided' });
  }
  res.json({ echo: inputString });
});

module.exports = router;