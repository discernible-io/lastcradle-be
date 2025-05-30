/**
 * Metrics routes for performance monitoring
 * Copyright (c) 2024 Ayayai, Inc. All rights reserved.
 */

const express = require('express');
const router = express.Router();
const performanceService = require('../../config/performanceservice');
const { authenticate_apicall } = require('../../sdk/lib/middleware/authenticationmw');

/**
 * GET /api/metrics
 * 
 * Get current performance metrics
 * Protected: Requires authentication
 */
router.get('/', authenticate_apicall, (req, res) => {
  const metrics = performanceService.getMetrics();
  
  res.json({
    metrics,
    timestamp: Date.now(),
    requestId: req.requestId
  });
});

/**
 * GET /api/metrics/system
 * 
 * Get system resource metrics (CPU, memory, etc.)
 * Protected: Requires authentication
 */
router.get('/system', authenticate_apicall, (req, res) => {
  const systemMetrics = performanceService.getSystemMetrics();
  
  res.json({
    metrics: systemMetrics,
    timestamp: Date.now(),
    requestId: req.requestId
  });
});

/**
 * POST /api/metrics/reset
 * 
 * Reset performance metrics counters
 * Protected: Requires authentication and admin permissions
 */
router.post('/reset', authenticate_apicall, (req, res) => {
  // Check if user has admin permissions
  if (!req.user || !req.user.permissions || !req.user.permissions.includes('admin')) {
    return res.status(403).json({
      error: {
        code: 'PERMISSION_DENIED',
        message: 'Admin permission required to reset metrics',
        requestId: req.requestId
      }
    });
  }
  
  performanceService.resetMetrics();
  
  res.json({
    message: 'Performance metrics reset successfully',
    timestamp: Date.now(),
    requestId: req.requestId
  });
});

module.exports = router;
