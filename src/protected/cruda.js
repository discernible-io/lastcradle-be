// DESTROY - Destroy a comment (continued)
      // In the previous section, we ended at this point
      const response = {
        message: "Comment successfully deleted",
        deletedComment,
      };
      
      // If this is a test, include webhook result info
      if (req.isWebhookTest) {
        response.webhook_result = {
          success: webhookResult.isValid,
          correlation_id: webhookResult.requestId,
          error: webhookResult.error ? webhookResult.error.message : null
        };
      }
      
      if (req.new_jwt_token) {
        response.new_jwt_token = req.new_jwt_token;
        logger.debugWithContext(
          "Added JWT token to response", 
          {
            ...destroyContext,
            tokenAdded: true
          }
        );
      }
      
      res.status(200).json(response);
    } catch (error) {
      logger.errorWithContext(
        "Error destroying comment", 
        destroyContext,
        error
      );
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Test webhook connectivity directly
router.post(
  "/webhook-test",
  async (req, res) => {
    const requestId = req.headers['x-request-id'] || ulid();
    
    const testContext = {
      operation: "webhook_direct_test",
      requestId,
      method: req.method,
      path: req.path,
      ip: req.ip,
      userId: req.user ? req.user.id : "anonymous"
    };
    
    logger.infoWithContext("Processing direct webhook test request", testContext);
    
    try {
      // Get webhook URL configuration
      const config = await stateManager.getConfigOwnRodit();
      if (!config || !config.own_rodit || !config.own_rodit.metadata || !config.own_rodit.metadata.webhook_url) {
        logger.warnWithContext(
          "No webhook URL configured", 
          {
            ...testContext,
            status: "no_webhook_url"
          }
        );
        
        return res.status(400).json({
          success: false,
          error: "No webhook URL configured in system"
        });
      }
      
      // Create test payload
      const testPayload = {
        event: "webhook_connectivity_test",
        timestamp: new Date().toISOString(),
        test_id: requestId,
        origin: "direct_test",
        data: {
          message: "This is a webhook connectivity test"
        }
      };
      
      // Send a test webhook - pass the request object
      const webhookResult = await logAndSendWebhook("webhook_test", testPayload, false, true, req);
      
      // Record the test in the database
      try {
        await db.run(
          `INSERT INTO webhook_tests (correlation_id, event_type, payload, success, timestamp, error_message) 
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            requestId,
            "webhook_test",
            JSON.stringify(testPayload),
            webhookResult.isValid ? 1 : 0,
            new Date().toISOString(),
            webhookResult.error ? webhookResult.error.message || JSON.stringify(webhookResult.error) : null
          ]
        );
        
        logger.infoWithContext("Direct webhook test recorded in database", {
          ...testContext,
          status: "database_record_created"
        });
      } catch (dbError) {
        logger.errorWithContext(
          "Failed to record webhook test in database", 
          {
            ...testContext,
            status: "database_error"
          },
          dbError
        );
      }
      
      // Use a clean webhook URL for display (don't show duplicated https://)
      const displayWebhookUrl = config.own_rodit.metadata.webhook_url.replace(/^(https?:\/\/)/, "");
      
      res.json({
        success: webhookResult.isValid,
        webhookUrl: displayWebhookUrl,
        correlation_id: requestId,
        timestamp: new Date().toISOString(),
        error: webhookResult.error ? webhookResult.error.message : null
      });
    } catch (error) {
      logger.errorWithContext(
        "Error in direct webhook test", 
        testContext,
        error
      );
      
      res.status(500).json({
        success: false,
        error: "Failed to execute webhook test: " + error.message
      });
    }
  }
);

// Get webhook test results
router.get(
  "/webhook-test-results",
  async (req, res) => {
    const limit = parseInt(req.query.limit) || 20;
    
    const requestId = req.headers['x-request-id'] || ulid();
    
    const testContext = {
      operation: "get_webhook_test_results",
      requestId,
      method: req.method,
      path: req.path,
      ip: req.ip,
      userId: req.user ? req.user.id : "anonymous",
      limit
    };
    
    logger.infoWithContext("Retrieving webhook test results", testContext);
    
    try {
      const results = await db.all(
        `SELECT * FROM webhook_tests ORDER BY timestamp DESC LIMIT ?`, 
        [limit]
      );
      
      // Parse JSON payloads
      const formattedResults = results.map(result => ({
        ...result,
        payload: result.payload ? JSON.parse(result.payload) : null,
        success: !!result.success  // Convert to boolean
      }));
      
      logger.infoWithContext(
        "Retrieved webhook test results", 
        {
          ...testContext,
          status: "success",
          count: results.length
        }
      );
      
      res.json({
        success: true,
        results: formattedResults,
        count: formattedResults.length
      });
    } catch (error) {
      logger.errorWithContext(
        "Error retrieving webhook test results", 
        testContext,
        error
      );
      
      res.status(500).json({
        success: false,
        error: "Failed to retrieve webhook test results: " + error.message
      });
    }
  }
);

// Export functions to allow proper cleanup in app.js
router.closeDatabase = async () => {
  if (db) {
    try {
      await db.close();
      logger.infoWithContext("Database connection closed", {
        operation: "db_close",
        module: "cruda_router",
        status: "success"
      });
    } catch (error) {
      logger.errorWithContext(
        "Error closing database", 
        {
          operation: "db_close",
          module: "cruda_router",
          status: "failed"
        },
        error
      );
      throw error;
    }
  }
};

// Export the database getter
router.getDatabase = getDatabase;

module.exports = router;