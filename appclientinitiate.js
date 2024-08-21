let jwt_token;
let tokenExpirationTime = null; // New variable to hold the token expiration time
let refreshTimeout = null; // New variable to hold the refresh timeout ID

// Function to schedule a token refresh
function scheduleTokenRefresh() {
  if (tokenExpirationTime) {
    const currentTime = Date.now();
    const timeUntilExpiration = tokenExpirationTime - currentTime;

    // Refresh token 1 minute before expiration
    const refreshTime = timeUntilExpiration - 60000; // 60,000 ms = 1 minute

    if (refreshTime > 0) {
      refreshTimeout = setTimeout(async () => {
        console.debug("Info: Refreshing token...");
        await refreshToken();
      }, refreshTime);
    }
  }
}

// Function to refresh the token
async function refreshToken() {
  try {
    const response = await fetch("/api/refresh-token", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt_token}`,
      },
    });

    if (!response.ok) {
      throw new Error("Failed to refresh token");
    }

    const data = await response.json();
    jwt_token = data.new_token; // Update the JWT token
    tokenExpirationTime = Date.now() + data.expires_in * 1000; // Assuming the server returns the expiration time in seconds
    scheduleTokenRefresh(); // Schedule the next token refresh
  } catch (error) {
    logger.error(`Error refreshing token: ${error.message}`);
  }
}

// Modified fetchWithErrorHandling function to handle token expiration header
async function fetchWithErrorHandling(url, options) {
  try {
    // Add the current token to the request headers
    if (jwt_token) {
      options.headers = {
        ...options.headers,
        Authorization: `Bearer ${jwt_token}`,
      };
    }

    const response = await fetch(url, options);

    // Check for a token expiration time in the response headers
    const tokenExpiration = response.headers.get("Token-Expiration");
    if (tokenExpiration) {
      tokenExpirationTime = parseInt(tokenExpiration, 10) * 1000; // Convert to milliseconds
      scheduleTokenRefresh(); // Schedule the token refresh
    }

    // Check for a new token in the response headers
    const newToken = response.headers.get("New-Token");
    if (newToken) {
      jwt_token = newToken;
      tokenExpirationTime = Date.now() + 3600000; // Assuming 1 hour validity by default
      scheduleTokenRefresh(); // Schedule the next token refresh
      console.debug("Info: Received an updated JWT token");
    }

    // Parse the response as JSON
    const responseData = await response.json();

    if (!response.ok) {
      // Check if it's a rate limiting error
      if (
        response.status === 429 &&
        responseData.error === "RateLimitExceeded"
      ) {
        const retryAfter = parseInt(
          response.headers.get("Retry-After") || "60",
          10
        );
        return {
          error: "RateLimitExceeded",
          message: responseData.message,
          retryAfter,
          maxRequests: responseData.maxRequests,
          windowMinutes: responseData.windowMinutes,
        };
      }

      // For other errors, throw with details
      throw new Error(
        `Error: Request failed: ${response.statusText}, Details: ${JSON.stringify(
          responseData
        )}`
      );
    }

    return responseData;
  } catch (error) {
    logger.error(`Error: fetchWithErrorHandling: ${error.message}`);

    // If the error is due to JSON parsing (i.e., the response wasn't JSON)
    if (error instanceof SyntaxError && error.message.includes("JSON")) {
      return {
        error: "Error: InvalidResponse",
        message: "The server returned an invalid response",
      };
    }

    return {
      error: "RequestFailed",
      message: error.message,
    };
  }
}

// Start the server and run the client
app.listen(WEBHOOKPORT, async () => {
  console.info(`Webhook server listening on port ${WEBHOOKPORT}`);
  // Run the client operations before the server starts accepting requests
  await sampleclient();
  console.info("Server ready to accept webhook requests");
});
