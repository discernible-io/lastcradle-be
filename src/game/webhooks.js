/**
 * Best-effort outbound webhooks for game events (cradle assignment, phase changes, etc.).
 * Delivers to OpenClaw gateways via RODiT-signed POST /hooks/wake (wake + event payload).
 */

const { RoditClient, blockchainService } = require("@rodit/rodit-auth-be");
const repo = require("./repository");
const {
  normalizeRoditId,
  isPassportTokenId,
  isNearAccountId,
  extractPassportTokenId,
  canonicalRoditId,
  roditIdFromUser
} = require("./rodit-id");

const sdkClient = new RoditClient();
const logger = sdkClient.getLogger();

const WEBHOOK_URL_CACHE_TTL_MS = 5 * 60 * 1000;
const webhookUrlCache = new Map();

let moduleRoditClient = null;

function setRoditClient(client) {
  moduleRoditClient = client;
}

function extractWebhookUrlFromUser(user) {
  if (!user || typeof user !== "object") {
    return null;
  }
  const url = user.rodit_webhookurl || user.webhookUrl;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

async function lookupWebhookUrlFromChain(roditId) {
  const normalized = normalizeRoditId(roditId);
  if (!normalized) {
    return null;
  }

  const passportId = extractPassportTokenId(normalized);
  const cacheKey = passportId || normalized;
  const cached = webhookUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  let token = null;
  try {
    if (isPassportTokenId(passportId)) {
      // Compound JWT subjects (bc=…;sub=<passport>) must use token_id lookup, not account_id.
      token = await blockchainService.nearorg_rpc_tokenfromroditid(passportId);
    } else if (isNearAccountId(normalized)) {
      token = await blockchainService.nearorg_rpc_tokensfromaccountid(normalized);
    }
  } catch (error) {
    logger.debugWithContext("Game webhook URL chain lookup failed", {
      component: "GameWebhooks",
      roditId: normalized,
      passportId: passportId || null,
      error: error.message
    });
    return null;
  }

  const url =
    typeof token?.metadata?.webhook_url === "string" ? token.metadata.webhook_url.trim() : "";
  if (!url) {
    return null;
  }

  const entry = {
    url,
    expiresAt: Date.now() + WEBHOOK_URL_CACHE_TTL_MS
  };
  webhookUrlCache.set(cacheKey, entry);
  if (normalized !== cacheKey) {
    webhookUrlCache.set(normalized, entry);
  }
  return url;
}

async function resolveRecipientWebhookUrl(reqOrRoditId) {
  if (typeof reqOrRoditId !== "string" && reqOrRoditId?.user) {
    const fromUser = extractWebhookUrlFromUser(reqOrRoditId.user);
    if (fromUser) {
      return fromUser;
    }
  }

  const roditId =
    typeof reqOrRoditId === "string" ? reqOrRoditId : roditIdFromUser(reqOrRoditId?.user);

  if (!roditId) {
    return null;
  }
  return lookupWebhookUrlFromChain(roditId);
}

function buildWebhookContext(roditId, webhookUrl = null) {
  const canonical = canonicalRoditId(roditId) || normalizeRoditId(roditId);
  const user = { roditId: canonical, sub: canonical, id: canonical, rodit_id: canonical };
  if (webhookUrl) {
    user.rodit_webhookurl = webhookUrl;
  }
  return {
    user,
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
  if (reqOrRoditId?.user) {
    const roditId = roditIdFromUser(reqOrRoditId.user);
    return {
      ...reqOrRoditId,
      app: reqOrRoditId.app || { locals: { roditClient: moduleRoditClient } },
      user: { ...reqOrRoditId.user, roditId, rodit_id: roditId }
    };
  }
  return reqOrRoditId;
}

async function buildWebhookDeliveryRequest(reqOrRoditId, payloadRoditId = null) {
  const baseReq = resolveWebhookRequest(reqOrRoditId);
  const rawRoditId =
    normalizeRoditId(payloadRoditId) ||
    (typeof reqOrRoditId === "string" ? normalizeRoditId(reqOrRoditId) : "") ||
    roditIdFromUser(baseReq?.user) ||
    "";
  const roditId = canonicalRoditId(rawRoditId) || rawRoditId || null;

  let webhookUrl = extractWebhookUrlFromUser(baseReq?.user);
  if (!webhookUrl && roditId) {
    webhookUrl = await lookupWebhookUrlFromChain(roditId);
  }

  if (!webhookUrl) {
    return { req: baseReq, ready: false, roditId };
  }

  const req = {
    ...baseReq,
    app: baseReq?.app || { locals: { roditClient: moduleRoditClient } },
    user: {
      ...(baseReq?.user || {}),
      roditId,
      rodit_id: roditId,
      sub: baseReq?.user?.sub || roditId,
      rodit_webhookurl: webhookUrl
    }
  };
  if (!req.app.locals?.roditClient) {
    req.app.locals.roditClient = moduleRoditClient;
  }
  return { req, ready: true, roditId, webhookUrl };
}

async function sendGameWebhook(payload, reqOrRoditId = null) {
  try {
    const roditClient = moduleRoditClient;
    if (!roditClient || typeof roditClient.sendWakeHook !== "function") {
      logger.debugWithContext("Game webhook skipped: roditClient unavailable", {
        component: "GameWebhooks",
        event: payload?.event
      });
      return { success: false, error: "roditClient unavailable" };
    }

    const payloadRoditId = payload?.data?.roditId ?? null;
    const { req: webhookReq, ready, roditId, webhookUrl } = await buildWebhookDeliveryRequest(
      reqOrRoditId,
      payloadRoditId
    );

    if (!ready) {
      logger.debugWithContext("Game webhook skipped: recipient webhook_url unavailable", {
        component: "GameWebhooks",
        event: payload?.event,
        roditId: roditId || payloadRoditId
      });
      return { success: false, error: "WEBHOOK_URL_MISSING" };
    }

    const result = await roditClient.sendWakeHook(payload, webhookReq, {
      sessionRoditId: roditId || payloadRoditId
    });

    return {
      ...result,
      success: result?.isValid === true
    };
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
  if (game.status === "running" && game.phase === "execution") {
    yourTurn = await notifyYourTurnForGame(gameId);
  }
  return { phaseChange, yourTurn };
}

function clearWebhookUrlCacheForTests() {
  webhookUrlCache.clear();
}

module.exports = {
  setRoditClient,
  sendGameWebhook,
  resolveRecipientWebhookUrl,
  lookupWebhookUrlFromChain,
  clearWebhookUrlCacheForTests,
  notifyCradleAssigned,
  notifyOpeningInventoryReport,
  notifyPhaseChange,
  notifyYourTurnForGame,
  notifyElimination,
  notifyGameFinished,
  onGamePhaseUpdated
};
