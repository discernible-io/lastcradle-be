/**
 * sessionRoutes.js - API routes for session management
 * 
 * This module provides Express routes for administrative session management.
 * 
 * Copyright (c) 2024 Cableguard, Inc. All rights reserved.
 */

const express = require('express');
const router = express.Router();
const { ulid } = require('ulid');
const sessionManager = require('../middleware/sessionsanager');
const { authenticate_apicall } = require('./initialrodit');
const logger = require('../../config/logger');
const { runManualCleanup } = require('../features/sessioncleanup');

/**
 * GET /api/sessions - Get all sessions
 * 
 * Admin route - Get information about all active sessions
 */
router.get('/', authenticate_apicall, (req, res) => {
  const requestId = ulid();
  const startTime = Date.now();
  
  try {
    // Gather all sessions
    const sessions = [];
    for (const session of sessionManager.sessions.values()) {
      // Clone session object and strip any sensitive data
      const safeSession = { ...session };
      delete safeSession.metadata?.privateData;
      
      sessions.push(safeSession);
    }
    
    const duration = Date.now() - startTime;
    logger.info('Session list retrieved', {
      component: 'SessionRoutes',
      method: 'listSessions',
      requestId,
      duration,
      sessionCount: sessions.length
    });
    
    return res.json({
      sessions,
      count: sessions.length,
      activeCount: sessionManager.getActiveSessionCount()
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logger.error('Failed to retrieve sessions', {
      component: 'SessionRoutes',
      method: 'listSessions',
      requestId,
      duration,
      error: error.message,
      stack: error.stack
    });
    
    return res.status(500).json({
      error: 'Failed to retrieve sessions',
      message: error.message
    });
  }
});

/**
 * GET /api/sessions/:id - Get session details
 * 
 * Admin route - Get detailed information about a specific session
 */
router.get('/:id', authenticate_apicall, (req, res) => {
  const requestId = ulid();
  const startTime = Date.now();
  const sessionId = req.params.id;
  
  try {
    const session = sessionManager.getSession(sessionId);
    
    if (!session) {
      const duration = Date.now() - startTime;
      
      logger.warn('Session not found', {
        component: 'SessionRoutes',
        method: 'getSession',
        requestId,
        duration,
        sessionId
      });
      
      return res.status(404).json({
        error: 'Session not found',
        sessionId
      });
    }
    
    // Clone session object and strip any sensitive data
    const safeSession = { ...session };
    delete safeSession.metadata?.privateData;
    
    const duration = Date.now() - startTime;
    logger.info('Session details retrieved', {
      component: 'SessionRoutes',
      method: 'getSession',
      requestId,
      duration,
      sessionId
    });
    
    return res.json(safeSession);
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logger.error('Failed to retrieve session details', {
      component: 'SessionRoutes',
      method: 'getSession',
      requestId,
      duration,
      sessionId,
      error: error.message,
      stack: error.stack
    });
    
    return res.status(500).json({
      error: 'Failed to retrieve session details',
      message: error.message,
      sessionId
    });
  }
});

/**
 * DELETE /api/sessions/:id - Close a session
 * 
 * Admin route - Force close a specific session
 */
router.delete('/:id', authenticate_apicall, (req, res) => {
  const requestId = ulid();
  const startTime = Date.now();
  const sessionId = req.params.id;
  const reason = req.body.reason || 'admin_terminated';
  
  try {
    const success = sessionManager.closeSession(sessionId, reason);
    
    if (!success) {
      const duration = Date.now() - startTime;
      
      logger.warn('Failed to close session - not found', {
        component: 'SessionRoutes',
        method: 'closeSession',
        requestId,
        duration,
        sessionId,
        reason
      });
      
      return res.status(404).json({
        error: 'Session not found',
        sessionId
      });
    }
    
    const duration = Date.now() - startTime;
    logger.info('Session closed', {
      component: 'SessionRoutes',
      method: 'closeSession',
      requestId,
      duration,
      sessionId,
      reason
    });
    
    // Emit metrics for admin session closures
    logger.metric && logger.metric('admin_session_closures', 1, {
      component: 'SessionRoutes',
      reason
    });
    
    return res.json({
      message: 'Session closed successfully',
      sessionId,
      reason
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logger.error('Failed to close session', {
      component: 'SessionRoutes',
      method: 'closeSession',
      requestId,
      duration,
      sessionId,
      reason,
      error: error.message,
      stack: error.stack
    });
    
    return res.status(500).json({
      error: 'Failed to close session',
      message: error.message,
      sessionId
    });
  }
});

/**
 * POST /api/sessions/cleanup - Run a manual session cleanup
 * 
 * Admin route - Force cleanup of expired sessions
 */
router.post('/cleanup', authenticate_apicall, async (req, res) => {
  const requestId = ulid();
  const startTime = Date.now();
  
  try {
    const removedCount = await runManualCleanup();
    
    const duration = Date.now() - startTime;
    logger.info('Manual session cleanup completed', {
      component: 'SessionRoutes',
      method: 'manualCleanup',
      requestId,
      duration,
      removedCount,
      remainingSessions: sessionManager.getActiveSessionCount()
    });
    
    return res.json({
      message: 'Session cleanup completed',
      removedCount,
      remainingSessions: sessionManager.getActiveSessionCount()
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logger.error('Manual session cleanup failed', {
      component: 'SessionRoutes',
      method: 'manualCleanup',
      requestId,
      duration,
      error: error.message,
      stack: error.stack
    });
    
    return res.status(500).json({
      error: 'Failed to run session cleanup',
      message: error.message
    });
  }
});

module.exports = router;