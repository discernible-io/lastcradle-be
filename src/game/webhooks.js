/**
 * Best-effort outbound webhooks for game events (cradle assignment, phase changes, etc.).
 */

const { RoditClient } = require("@rodit/rodit-auth-be");
const repo = require("./repository");

const sdkClient = new RoditClient();
const logger = sdkClient.getLogger();

let moduleRoditClient = null;

function setRoditClient(client) {
  moduleRoditClient = client;
}

function buildWebhookContext(roditId) {
  return {
    user: { roditId, sub: roditId, id: roditId },
    app: { locals: { roditClient: moduleRoditClient } }
  };
}

function resolveWebhookRequest(reqOrRoditId) {
  if (typeof reqOrRoditId === "string") {
    return buildWebhookContext(reqOrRoditId);
  }
  if (reqOrRoditId?.app?.locals?.roditClient) {
    return reqOrRoditId;
  }
  if (reqOrRoditId?.user?.roditId || reqOrRoditId?.user?.sub) {
    const roditId = reqOrRoditId.user.roditId || reqOrRoditId.user.sub;
    return {
      ...reqOrRoditId,
      app: reqOrRoditId.app || { locals: { roditClient: moduleRoditClient } },
      user: { ...reqOrRoditId.user, roditId }
    };
  }
  return reqOrRoditId;
}

async function sendGameWebhook(payload, reqOrRoditId = null) {
  try {
    const req = resolveWebhookRequest(reqOrRoditId);
    const roditClient = req?.app?.locals?.roditClient || moduleRoditClient;
    if (!roditClient || typeof roditClient.send_webhook !== "function") {
      logger.debugWithContext("Game webhook skipped: roditClient unavailable", {
        component: "GameWebhooks",
        event: payload?.event
      });
      return { success: false, error: "roditClient unavailable" };
    }

    const webhookReq = req?.app ? req : buildWebhookContext(payload?.data?.roditId);
    if (!webhookReq.app) {
      webhookReq.app = { locals: { roditClient } };
    }

    return await roditClient.send_webhook(payload, webhookReq);
  } catch (error) {
    logger.errorWithContext(
      "Game webhook delivery failed, continuing",
      {
        component: "GameWebhooks",
        event: payload?.event,
        requestId: reqOrRoditId?.requestId
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

async function notifyRoditEvent(roditId, event, data) {
  if (!roditId) {
    return { success: false, error: "roditId_required" };
  }
  return sendGameWebhook({ event, data: { roditId, ...data } }, roditId);
}

async function notifyAllAgents(gameId, event, dataForAgent) {
  const agents = await repo.listAgents(gameId);
  const results = [];
  for (const agent of agents) {
    const data =
      typeof dataForAgent === "function" ? dataForAgent(agent) : { ...dataForAgent };
    results.push(
      await notifyRoditEvent(agent.roditId, event, {
        gameId,
        agentId: agent.id,
        displayName: agent.displayName,
        ...data
      })
    );
  }
  return results;
}

async function notifyLivingAgents(gameId, event, dataForAgent) {
  const agents = await repo.listAgents(gameId, { status: "alive" });
  const results = [];
  for (const agent of agents) {
    const data =
      typeof dataForAgent === "function" ? dataForAgent(agent) : { ...dataForAgent };
    results.push(
      await notifyRoditEvent(agent.roditId, event, {
        gameId,
        agentId: agent.id,
        displayName: agent.displayName,
        ...data
      })
    );
  }
  return results;
}

function buildCradlePayload(agent) {
  return {
    productionCapacity: agent.productionCapacity,
    storageCapacity: agent.storageCapacity,
    inventory: agent.inventory
  };
}

async function notifyCradleAssigned(req, { gameId, game, agent, roditId }) {
  return sendGameWebhook(
    {
      event: "cradle_assigned",
      data: {
        gameId,
        agentId: agent.id,
        roditId,
        displayName: agent.displayName,
        cradle: buildCradlePayload(agent),
        joiningWindow: game
          ? {
              startsAt: game.joining_window_starts_at,
              endsAt: game.joining_window_ends_at
            }
          : null
      }
    },
    req || roditId
  );
}

async function notifyOpeningInventoryReport(req, { gameId, game }) {
  const runtime = game?.config?.survivalRuntime;
  const scoutAgentId = runtime?.openingInventoryScoutAgentId;
  const report = runtime?.openingInventories;
  if (!scoutAgentId || !report?.length) {
    return { success: false, error: "no_opening_inventory_report" };
  }

  const scout = report.find((entry) => entry.agentId === scoutAgentId);
  return sendGameWebhook(
    {
      event: "opening_inventory_report",
      data: {
        gameId,
        scoutAgentId,
        roditId: scout?.roditId ?? null,
        displayName: scout?.displayName ?? null,
        capturedBeforeTurnProduction: true,
        agents: report
      }
    },
    scout?.roditId || req
  );
}

async function notifyPhaseChange(gameId, phasePayload) {
  return notifyLivingAgents(gameId, "phase_change", (agent) => ({
    ...phasePayload,
    agentStatus: agent.status
  }));
}

async function notifyYourTurnForGame(gameId) {
  const game = await repo.getGameById(gameId);
  if (!game || game.status !== "running") {
    return [];
  }

  const results = [];

  if (game.phase === "message_report") {
    const status = await repo.getMessageReportSubmissionStatus(gameId, game.current_turn);
    for (const agentId of status.pendingAgentIds) {
      const agent = await repo.getAgentById(agentId);
      if (!agent) continue;
      results.push(
        await notifyRoditEvent(agent.roditId, "your_turn", {
          gameId,
          agentId: agent.id,
          displayName: agent.displayName,
          taskType: "submit_message_report",
          phase: game.phase,
          currentTurn: game.current_turn,
          deadline: game.message_report_ends_at,
          action: "POST /api/game/games/{gameId}/message-report"
        })
      );
    }
  }

  if (game.phase === "execution") {
    const status = await repo.getExecutionSubmissionStatus(gameId, game.current_turn);
    for (const agentId of status.pendingAgentIds) {
      const agent = await repo.getAgentById(agentId);
      if (!agent) continue;
      results.push(
        await notifyRoditEvent(agent.roditId, "your_turn", {
          gameId,
          agentId: agent.id,
          displayName: agent.displayName,
          taskType: "submit_execution_action",
          phase: game.phase,
          currentTurn: game.current_turn,
          deadline: game.execution_ends_at,
          action: "POST /api/game/games/{gameId}/action"
        })
      );
    }
  }

  return results;
}

async function notifyElimination({ gameId, agent, turnNumber }) {
  return notifyRoditEvent(agent.roditId, "elimination", {
    gameId,
    agentId: agent.id,
    displayName: agent.displayName,
    diedAtTurn: turnNumber
  });
}

async function notifyGameFinished(game) {
  if (!game) {
    return [];
  }

  return notifyAllAgents(game.id, "game_finished", {
    status: game.status,
    winnerIds: game.winnerIds || [],
    contestMode: game.config?.contestMode ?? null,
    finishedAt: game.finished_at
  });
}

function phasePayloadFromGame(game) {
  return {
    status: game.status,
    phase: game.phase,
    currentTurn: game.current_turn,
    negotiationEndsAt: game.negotiation_ends_at,
    messageReportEndsAt: game.message_report_ends_at,
    executionEndsAt: game.execution_ends_at
  };
}

async function onGamePhaseUpdated(gameId) {
  const game = await repo.getGameById(gameId);
  if (!game) {
    return { phaseChange: [], yourTurn: [] };
  }

  const phaseChange = await notifyPhaseChange(gameId, phasePayloadFromGame(game));
  let yourTurn = [];
  if (game.status === "running" && (game.phase === "message_report" || game.phase === "execution")) {
    yourTurn = await notifyYourTurnForGame(gameId);
  }
  return { phaseChange, yourTurn };
}

module.exports = {
  setRoditClient,
  sendGameWebhook,
  notifyCradleAssigned,
  notifyOpeningInventoryReport,
  notifyPhaseChange,
  notifyYourTurnForGame,
  notifyElimination,
  notifyGameFinished,
  onGamePhaseUpdated
};
