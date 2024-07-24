const logger = require('../config/logger');

const loggingmiddleware = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info({
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration,
      userIP: req.ip,
      userId: req.user ? req.user.id : 'anonymous', // Assuming you have user info in req.user
      action: req.body.action || 'unknown', // You can add an 'action' field to your requests
    });
  });
  next();
};

module.exports = loggingmiddleware;