/**
 * Best-effort outbound webhooks for game events (territory assignment, etc.).
 */

const { RoditClient } = require("@rodit/rodit-auth-be");

const sdkClient = new RoditClient();
const logger = sdkClient.getLogger();

async function sendGameWebhook(payload, req = null) {
  try {
    const roditClient = req?.app?.locals?.roditClient;
    if (!roditClient || typeof roditClient.send_webhook !== "function") {
      logger.debugWithContext("Game webhook skipped: roditClient unavailable", {
        component: "GameWebhooks",
        event: payload?.event
      });
      return { success: false, error: "roditClient unavailable" };
    }

    return await roditClient.send_webhook(payload, req);
  } catch (error) {
    logger.errorWithContext(
      "Game webhook delivery failed, continuing",
      {
        component: "GameWebhooks",
        event: payload?.event,
        requestId: req?.requestId
      },
      error
    );
    return {
      success: false,
      error: error.message,
      errorType: error.name
    };
  }
}

function buildTerritoryPayload(agent) {
  return {
    productionCapacity: agent.productionCapacity,
    storageCapacity: agent.storageCapacity,
    inventory: agent.inventory
  };
}

async function notifyTerritoryAssigned(req, { gameId, game, agent, roditId }) {
  return sendGameWebhook(
    {
      event: "territory_assigned",
      data: {
        gameId,
        agentId: agent.id,
        roditId,
        displayName: agent.displayName,
        territory: buildTerritoryPayload(agent),
        joiningWindow: game ? {
          startsAt: game.joining_window_starts_at,
          endsAt: game.joining_window_ends_at
        } : null
      }
    },
    req
  );
}

module.exports = {
  sendGameWebhook,
  notifyTerritoryAssigned
};
