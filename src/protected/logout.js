/**
 * logout.js - API routes for user logout
 * 
 * This module provides Express routes for user logout, delegating to
 * the centralized session management in sessionroutes.js.
 * 
 * Copyright (c) 2025 Discernible, Inc. All rights reserved.
 */

const express = require("express");
const router = express.Router();
const { ulid } = require("ulid");

// Helper to get logger from the singleton client
const getLogger = (req) => {
  const client = req.app?.locals?.roditClient;
  if (!client) {
    throw new Error('RoditClient not available in app.locals');
  }
  return client.getLogger();
};

// Helper to get authentication middleware from singleton
const getAuthMiddleware = (req) => {
  const client = req.app?.locals?.roditClient;
  if (!client) {
    throw new Error('RoditClient not available in app.locals');
  }
  return (req, res, next) => client.authenticate(req, res, next);
};

// Handling logout request - now processes logout directly instead of redirecting
router.post("/logout", (req, res, next) => {
  // Apply authentication middleware from singleton
  const authMiddleware = getAuthMiddleware(req);
  authMiddleware(req, res, (err) => {
    if (err) return next(err);
    
    const requestId = req.headers['x-request-id'] || ulid();
    const startTime = Date.now();
    req.logAction = "logout-attempt";
    
    const logger = getLogger(req);
    
    logger.debugWithContext("Processing logout request directly", {
      requestId,
      component: 'LogoutRoutes',
      event: 'logout',
      endpoint: '/api/logout',
      httpMethod: req.method,
      userId: req.user?.id,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
    });
  
    try {
      // Check if the logout_client method exists on the centralized client
      if (!req.app.locals.roditClient) {
        logger.errorWithContext("Authentication service unavailable", {
          requestId,
          component: 'LogoutRoutes',
          event: 'logout',
        });
        return res.status(503).json({ 
          error: 'Authentication service unavailable',
          requestId
        });
      }
      
      if (typeof req.app.locals.roditClient.logout_client !== 'function') {
        logger.errorWithContext("logout_client method not available", {
          requestId,
          component: 'LogoutRoutes',
          event: 'logout',
          availableMethods: Object.getOwnPropertyNames(req.app.locals.roditClient).filter(name => typeof req.app.locals.roditClient[name] === 'function')
        });
        return res.status(503).json({ 
          error: 'Logout service unavailable',
          details: 'logout_client method not found on authentication service',
          requestId
        });
      }
      
      // Process logout directly using the centralized RoditClient
      logger.infoWithContext("Delegating to centralized logout_client", {
        requestId,
        component: 'LogoutRoutes',
        event: 'logout',
      });
      return req.app.locals.roditClient.logout_client(req, res);
      
    } catch (error) {
      const duration = Date.now() - startTime;
      
      logger.logErrorWithMetrics(
        'Error processing logout request',
        {
          requestId,
          component: 'LogoutRoutes',
          event: 'logout',
          duration
        },
        error,
        'auth_error',
        {
          operation: 'logout_direct',
          result: 'error',
          duration
        }
      );
      
      res.status(500).json({
        error: 'Failed to process logout request',
        message: error.message,
        requestId
      });
    }
  });
});

module.exports = router;
