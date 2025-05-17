// webhook-tests.js

const { ulid } = require("ulid");
const logger = require("../config/logger");
const stateManager = require("./blockchain/statemanager");

// Standardized captureTestData function aligned with successful tests
function captureTestData(testName, moduleName, result, testData) {
  result.testInfo = {
    testName,
    moduleName,
    timestamp: new Date().toISOString(),
    endpoint: testData.endpoint || "unknown",
  };

  if (!result.success) {
    const correlationId = ulid();
    result.testInfo.correlationId = correlationId;

    // Log error using the standard format
    logger.error(
      `Test '${testName}' failed for endpoint ${result.testInfo.endpoint}`,
      {
        component: "TestRunner",
        moduleName,
        testName,
        endpoint: result.testInfo.endpoint,
        correlationId,
        error: result.error,
      }
    );

    // Also log an additional error message in the same format TestRunner uses
    logger.error(`Test failed: ${testName}`, {
      component: "TestRunner",
      moduleName,
      testName,
      error: result.error,
      details: result.details || {},
    });

    logger.metric("test_failure", 1, {
      module: moduleName,
      test: testName,
      endpoint: result.testInfo.endpoint,
      correlation_id: correlationId,
    });
  } else {
    // Log success at DEBUG level in the format TestRunner expects
    logger.debug(
      `Test '${testName}' passed for endpoint ${result.testInfo.endpoint}`,
      {
        component: "TestRunner",
        moduleName,
        testName,
        endpoint: result.testInfo.endpoint,
      }
    );

    // Also log an additional success message at INFO level in the same format TestRunner uses
    logger.info(`Test passed: ${testName}`, {
      component: "TestRunner",
      moduleName,
      testName,
      details: result.details || {},
    });

    logger.metric("test_success", 1, {
      module: moduleName,
      test: testName,
      endpoint: result.testInfo.endpoint,
    });
  }

  return result;
}

/**
 * Tests for webhook functionality and test results
 */
const webhookTests = {
  /**
   * Test direct webhook connectivity
   */
  testWebhookConnectivity: async (apiEndpoint) => {
    const moduleName = "webhook";
    const testName = "testWebhookConnectivity";
    const correlationId = ulid();
    const testData = { apiEndpoint };
    testData.endpoint = `${apiEndpoint}/webhook-test`;

    // Log test start with standardized format
    logger.info(`Starting test: ${testName}`, {
      component: "TestRunner",
      moduleName,
      testName,
      runId: correlationId,
      testId: ulid(),
      apiEndpoint: testData.endpoint,
      startTime: new Date().toISOString(),
    });

    const token = await stateManager.getJwtToken();
    if (!token) {
      const result = {
        success: false,
        error: "No JWT token available for testing",
      };
      return captureTestData(testName, moduleName, result, testData);
    }

    testData.token = token;

    try {
      // Make the direct webhook test request
      const directWebhookResponse = await fetch(`${apiEndpoint}/webhook-test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-Request-ID": correlationId,
        },
      })
        .then(async (response) => {
          try {
            const data = await response.json();
            return {
              status: response.status,
              ok: response.ok,
              data,
              error: !response.ok ? `HTTP error: ${response.status}` : null,
            };
          } catch (e) {
            return {
              status: response.status,
              ok: response.ok,
              error: `Failed to parse response: ${e.message}`,
            };
          }
        })
        .catch((error) => {
          return {
            error: `Network error: ${error.message}`,
            status: 0,
          };
        });

      // Log direct webhook test result
      logger.info("Direct webhook test completed", {
        component: "TestRunner",
        moduleName,
        testName,
        correlationId,
        status: directWebhookResponse.ok ? "success" : "failure",
        responseStatus: directWebhookResponse.status,
        responseData: directWebhookResponse.data,
      });

      // Fetch webhook test results
      let webhookResultsResponse = null;
      if (directWebhookResponse.ok) {
        webhookResultsResponse = await fetch(
          `${apiEndpoint}/webhook-test-results?limit=5`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Request-ID": ulid(),
            },
          }
        )
          .then(async (response) => {
            try {
              const data = await response.json();
              return {
                status: response.status,
                ok: response.ok,
                data,
                error: !response.ok ? `HTTP error: ${response.status}` : null,
              };
            } catch (e) {
              return {
                status: response.status,
                ok: response.ok,
                error: `Failed to parse response: ${e.message}`,
              };
            }
          })
          .catch((error) => {
            return {
              error: `Network error: ${error.message}`,
              status: 0,
            };
          });

        // Log webhook results test
        logger.info("Webhook results test completed", {
          component: "TestRunner",
          moduleName,
          testName,
          correlationId,
          status: webhookResultsResponse.ok ? "success" : "failure",
          responseStatus: webhookResultsResponse.status,
          resultCount: webhookResultsResponse.data?.results?.length || 0,
        });
      }

      // Now test CUD operations with webhook test header
      const crudTestResults = await testCRUDWithWebhook(
        apiEndpoint,
        token,
        correlationId,
        moduleName,
        testName
      );

      // Check for required API success
      const directWebhookSuccess = directWebhookResponse.ok && directWebhookResponse.data.success !== false;
      const webhookResultsSuccess = !webhookResultsResponse || webhookResultsResponse.ok;
      const crudSuccess = crudTestResults.every((result) => result.success);

      // Log test completion
      logger.info("All webhook tests completed", {
        component: "TestRunner",
        moduleName,
        testName,
        correlationId,
        directWebhookSuccess,
        webhookResultsSuccess,
        crudSuccess,
      });

      const result = {
        success: directWebhookSuccess && webhookResultsSuccess && crudSuccess,
        error: !directWebhookSuccess
          ? "Direct webhook test failed"
          : !webhookResultsSuccess
          ? "Webhook results retrieval failed"
          : !crudSuccess
          ? "One or more CRUD operations with webhook test failed"
          : null,
        details: {
          directWebhookTest: {
            success: directWebhookSuccess,
            status: directWebhookResponse.status,
            response: directWebhookResponse.data,
          },
          webhookResultsTest: webhookResultsResponse
            ? {
                success: webhookResultsSuccess,
                status: webhookResultsResponse.status,
                resultCount: webhookResultsResponse.data?.results?.length || 0,
                results: webhookResultsResponse.data?.results || [],
              }
            : "Not tested",
          crudWebhookTests: crudTestResults,
        },
      };

      return captureTestData(testName, moduleName, result, testData);
    } catch (error) {
      logger.error("Test exception", {
        component: "TestRunner",
        moduleName,
        testName,
        correlationId,
        phase: "exception",
        error: error.message,
        stack: error.stack,
      });

      const result = {
        success: false,
        error: error.message,
        details: { stack: error.stack },
      };

      return captureTestData(testName, moduleName, result, testData);
    }
  },

  /**
   * Test webhook results retrieval
   */
  testWebhookResultsRetrieval: async (apiEndpoint) => {
    const moduleName = "webhook";
    const testName = "testWebhookResultsRetrieval";
    const correlationId = ulid();
    const testData = { apiEndpoint };
    testData.endpoint = `${apiEndpoint}/webhook-test-results`;

    // Log test start with standardized format
    logger.info(`Starting test: ${testName}`, {
      component: "TestRunner",
      moduleName,
      testName,
      runId: correlationId,
      testId: ulid(),
      apiEndpoint: testData.endpoint,
      startTime: new Date().toISOString(),
    });

    const token = await stateManager.getJwtToken();
    if (!token) {
      const result = {
        success: false,
        error: "No JWT token available for testing",
      };
      return captureTestData(testName, moduleName, result, testData);
    }

    testData.token = token;

    try {
      // Test cases for different limit parameters
      const limitTestCases = [
        { name: "Default limit", queryParam: "", expectedLimit: 20 },
        { name: "Custom limit 5", queryParam: "?limit=5", expectedLimit: 5 },
        { name: "Custom limit 10", queryParam: "?limit=10", expectedLimit: 10 },
        { name: "Invalid limit", queryParam: "?limit=invalid", expectedLimit: 20 }, // Should use default
        { name: "Negative limit", queryParam: "?limit=-5", expectedLimit: 20 }, // Should use default
        { name: "Zero limit", queryParam: "?limit=0", expectedLimit: 20 }, // Should use default
      ];

      const limitTestResults = [];

      // Test each limit case
      for (const testCase of limitTestCases) {
        logger.debug(`Testing case: ${testCase.name}`, {
          component: "TestRunner",
          moduleName,
          testName,
          correlationId,
          phase: "test_case",
          caseName: testCase.name,
        });

        // Fetch webhook test results with specified limit
        const response = await fetch(
          `${apiEndpoint}/webhook-test-results${testCase.queryParam}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Request-ID": ulid(),
            },
          }
        )
          .then(async (response) => {
            try {
              const data = await response.json();
              return {
                status: response.status,
                ok: response.ok,
                data,
                error: !response.ok ? `HTTP error: ${response.status}` : null,
              };
            } catch (e) {
              return {
                status: response.status,
                ok: response.ok,
                error: `Failed to parse response: ${e.message}`,
              };
            }
          })
          .catch((error) => {
            return {
              error: `Network error: ${error.message}`,
              status: 0,
            };
          });

        // Check if the response is valid and if the expected limit is respected
        const hasResults = response.ok && response.data && Array.isArray(response.data.results);
        const resultCount = hasResults ? response.data.results.length : 0;
        const limitRespected = hasResults && resultCount <= testCase.expectedLimit;
        
        // Note: We can't check if exactly the expected number of results are returned
        // because it depends on how many are in the database. We can only check if 
        // it doesn't exceed the limit.

        limitTestResults.push({
          testCase: testCase.name,
          queryParam: testCase.queryParam,
          success: response.ok,
          hasResults,
          resultCount,
          limitRespected,
          status: response.status,
          error: response.error,
        });
      }

      // Check if all tests succeeded
      const allLimitTestsSucceeded = limitTestResults.every(
        (result) => result.success && result.limitRespected
      );

      // Log test completion
      logger.info("Test completed", {
        component: "TestRunner",
        moduleName,
        testName,
        correlationId,
        phase: "complete",
        allLimitTestsSucceeded,
      });

      const result = {
        success: allLimitTestsSucceeded,
        error: !allLimitTestsSucceeded
          ? "Some webhook results limit tests failed"
          : null,
        details: {
          limitTestResults,
          summary: {
            totalTests: limitTestResults.length,
            successfulTests: limitTestResults.filter((r) => r.success && r.limitRespected).length,
            failedTests: limitTestResults
              .filter((r) => !r.success || !r.limitRespected)
              .map((r) => r.testCase),
          },
        },
      };

      return captureTestData(testName, moduleName, result, testData);
    } catch (error) {
      logger.error("Test exception", {
        component: "TestRunner",
        moduleName,
        testName,
        correlationId,
        phase: "exception",
        error: error.message,
        stack: error.stack,
      });

      const result = {
        success: false,
        error: error.message,
        details: { stack: error.stack },
      };

      return captureTestData(testName, moduleName, result, testData);
    }
  },
};

/**
 * Helper function to test CRUD operations with webhook test header
 */
async function testCRUDWithWebhook(apiEndpoint, token, correlationId, moduleName, testName) {
  const crudEndpoints = [
    {
      name: "Create comment with webhook test",
      endpoint: `${apiEndpoint}/create`,
      method: "POST",
      payload: {
        title: "Test Webhook Title",
        content: "This is a test content for webhook testing"
      }
    },
    {
      name: "List comments with webhook test",
      endpoint: `${apiEndpoint}/list`,
      method: "POST",
      payload: {}
    },
    {
      name: "Read comment with webhook test",
      endpoint: `${apiEndpoint}/read`,
      method: "POST",
      payload: {
        id: 1 // This assumes at least one comment exists
      }
    },
    {
      name: "Update comment with webhook test",
      endpoint: `${apiEndpoint}/update`,
      method: "POST",
      payload: {
        id: 1, // This assumes at least one comment exists
        title: "Updated Test Webhook Title",
        content: "This is updated content for webhook testing"
      }
    }
    // We omit destroy test to avoid removing data that may be needed for other tests
  ];

  const results = [];

  for (const testCase of crudEndpoints) {
    logger.debug(`Testing CRUD with webhook: ${testCase.name}`, {
      component: "TestRunner",
      moduleName,
      testName,
      correlationId,
      phase: "crud_webhook_test",
      testCase: testCase.name
    });

    try {
      // Make the request with webhook test header
      const response = await fetch(testCase.endpoint, {
        method: testCase.method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-Request-ID": ulid(),
          "X-Webhook-Test": "true" // Important: This header triggers webhook test mode
        },
        body: JSON.stringify(testCase.payload)
      })
      .then(async (response) => {
        try {
          const data = await response.json();
          return {
            status: response.status,
            ok: response.ok,
            data,
            error: !response.ok ? `HTTP error: ${response.status}` : null,
          };
        } catch (e) {
          return {
            status: response.status,
            ok: response.ok,
            error: `Failed to parse response: ${e.message}`,
          };
        }
      })
      .catch(error => {
        return {
          error: `Network error: ${error.message}`,
          status: 0,
        };
      });

      // Check for webhook_result in the response
      const hasWebhookResult = response.ok && 
                              response.data && 
                              response.data.webhook_result !== undefined;

      // Log webhook result for debug
      if (hasWebhookResult) {
        logger.debug(`Webhook result for ${testCase.name}`, {
          component: "TestRunner",
          moduleName,
          testName,
          correlationId,
          phase: "crud_webhook_result",
          webhookSuccess: response.data.webhook_result.success,
          correlationId: response.data.webhook_result.correlation_id,
          error: response.data.webhook_result.error
        });
      }

      results.push({
        testCase: testCase.name,
        success: response.ok,
        hasWebhookResult,
        webhookSuccess: hasWebhookResult ? response.data.webhook_result.success : false,
        status: response.status,
        error: response.error
      });
    } catch (error) {
      logger.error(`Error in CRUD webhook test: ${testCase.name}`, {
        component: "TestRunner",
        moduleName,
        testName,
        correlationId,
        phase: "crud_webhook_error",
        testCase: testCase.name,
        error: error.message,
        stack: error.stack
      });

      results.push({
        testCase: testCase.name,
        success: false,
        error: error.message
      });
    }
  }

  return results;
}

module.exports = webhookTests;