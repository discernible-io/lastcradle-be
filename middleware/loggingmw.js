const logger = require('../config/logger');

const loggingmw = (req, res, next) => {
    const start = Date.now();
    
    // Capture the original end function
    const originalEnd = res.end;
    
    // Override the end function
    res.end = function(chunk, encoding) {
      // Call the original end function
      originalEnd.call(this, chunk, encoding);
      
      // Now log after the response has been sent
      const duration = Date.now() - start;
      logger.info({
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        duration,
        timestamp: new Date().toISOString(),
        clientendpointIP: req.ip,
        roditID: req.user ? req.user.id : 'unauthenticated',
        action: req.logAction || 'unspecified',
        service: req.logService || 'api-service'
      });
    };
  
    next();
  };

module.exports = loggingmw;

