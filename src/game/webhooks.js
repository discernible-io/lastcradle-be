/**
 * Best-effort outbound webhooks for game events (cradle assignment, phase changes, etc.).
 * Delivers to OpenClaw gateways via RODiT-signed POST /hooks/wake (wake) or
 * POST /hooks/agent (isolated agent tick for deadline warnings).
 */

const { RoditClient, blockchainService } = require("@rodit/rodit-auth-be");
const repo = require("./repository");
const { inboundTradesForRecipient } = require("./trade-disclosure");
const {
  normalizeRoditId,
  isPassportTokenId,
  isNearAccountId,
  extractPassportTokenId,
  canonicalRoditId,
  roditIdFromUser
} = require("./rodit-id");
const { lookupUrlJoinWebhookUrl } = require("./url-join-identity");
const { recollectionHint } = require("./recollection-guidance");

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

  const fromUrlJoin = await lookupUrlJoinWebhookUrl(roditId);
  if (fromUrlJoin) {
    return fromUrlJoin;
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
  if (!webhookUrl) {
    if (roditId) {
      webhookUrl = await resolveRecipientWebhookUrl(roditId);
    } else if (typeof reqOrRoditId !== "string") {
      webhookUrl = await resolveRecipientWebhookUrl(reqOrRoditId);
    }
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

/**
 * @param {"wake"|"agent"} channel - wake → sendWakeHook (/hooks/wake); agent → sendAgentHook (/hooks/agent)
 */
async function sendGameWebhook(payload, reqOrRoditId = null, { channel = "wake" } = {}) {
  const methodName = channel === "agent" ? "sendAgentHook" : "sendWakeHook";
  try {
    const roditClient = moduleRoditClient;
    if (!roditClient || typeof roditClient[methodName] !== "function") {
      logger.warnWithContext("Game webhook skipped: roditClient unavailable", {
        component: "GameWebhooks",
        event: payload?.event,
        channel,
        methodName,
        error: "RODIT_CLIENT_UNAVAILABLE"
      });
      return { success: false, error: "roditClient unavailable" };
    }

    const payloadRoditId = payload?.data?.roditId ?? null;
    const { req: webhookReq, ready, roditId, webhookUrl } = await buildWebhookDeliveryRequest(
      reqOrRoditId,
      payloadRoditId
    );

    if (!ready) {
      // warn (not debug): LOG_LEVEL=info on main otherwise hides why wakes never leave the server
      logger.warnWithContext("Game webhook skipped: recipient webhook_url unavailable", {
        component: "GameWebhooks",
        event: payload?.event,
        channel,
        roditId: roditId || payloadRoditId,
        error: "WEBHOOK_URL_MISSING"
      });
      return { success: false, error: "WEBHOOK_URL_MISSING" };
    }

    const webhookHost = webhookUrl
      ? String(webhookUrl).replace(/^(https?:\/\/)/, "").split("/")[0]
      : null;

    logger.infoWithContext("Game webhook sending", {
      component: "GameWebhooks",
      event: payload?.event,
      channel,
      methodName,
      roditId: roditId || payloadRoditId,
      webhookHost
    });

    const result = await roditClient[methodName](payload, webhookReq, {
      sessionRoditId: roditId || payloadRoditId
    });

    if (result?.isValid !== true) {
      logger.warnWithContext("Game webhook delivery returned non-success", {
        component: "GameWebhooks",
        event: payload?.event,
        channel,
        roditId: roditId || payloadRoditId,
        webhookHost,
        error: result?.error?.message || result?.error || null,
        requestId: result?.requestId || reqOrRoditId?.requestId || null
      });
    } else {
      logger.infoWithContext("Game webhook delivered", {
        component: "GameWebhooks",
        event: payload?.event,
        channel,
        roditId: roditId || payloadRoditId,
        webhookHost,
        requestId: result?.requestId || null
      });
    }

    return {
      ...result,
      success: result?.isValid === true
    };
  } catch (error) {
    const cause = error?.cause;
    logger.errorWithContext(
      "Game webhook delivery failed, continuing",
      {
        component: "GameWebhooks",
        event: payload?.event,
        channel,
        requestId: reqOrRoditId?.requestId,
        causeCode: cause?.code || null,
        causeMessage: cause?.message || null
      },
      error
    );
    return {
      success: false,
      error: error.message,
      errorType: error.name,
      causeCode: cause?.code || null
    };
  }
}

async function sendGameAgentHook(payload, reqOrRoditId = null) {
  return sendGameWebhook(payload, reqOrRoditId, { channel: "agent" });
}

async function notifyRoditEvent(roditId, event, data, { channel = "wake" } = {}) {
  if (!roditId) {
    return { success: false, error: "roditId_required" };
  }
  return sendGameWebhook({ event, data: { roditId, ...data } }, roditId, { channel });
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
  const currentTurn = Number(phasePayload?.currentTurn) || 0;
  const includeInbound =
    phasePayload?.phase === "negotiation" && currentTurn > 1;
  const resolvedTurn = includeInbound ? currentTurn - 1 : null;
  const priorTrades =
    resolvedTurn != null ? await repo.listPublicTrades(gameId, resolvedTurn) : [];

  return notifyLivingAgents(gameId, "phase_change", (agent) => {
    const data = {
      ...phasePayload,
      agentStatus: agent.status
    };
    if (includeInbound) {
      data.resolvedTurn = resolvedTurn;
      data.transfersReceived = inboundTradesForRecipient(priorTrades, agent.id);
    }
    return data;
  });
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

async function notifyDeadlineWarningForGame(gameId) {
  const game = await repo.getGameById(gameId);
  if (!game || game.status !== "running" || game.phase !== "execution") {
    return [];
  }

  const endsAtMs = game.execution_ends_at ? new Date(game.execution_ends_at).getTime() : NaN;
  const secondsRemaining = Number.isFinite(endsAtMs)
    ? Math.max(0, Math.round((endsAtMs - Date.now()) / 1000))
    : null;

  const status = await repo.getExecutionSubmissionStatus(gameId, game.current_turn);
  const results = [];

  for (const agentId of status.pendingAgentIds) {
    const agent = await repo.getAgentById(agentId);
    if (!agent) continue;
    results.push(
      await notifyRoditEvent(
        agent.roditId,
        "deadline_warning",
        {
          gameId,
          agentId: agent.id,
          displayName: agent.displayName,
          taskType: "submit_execution_action",
          phase: game.phase,
          currentTurn: game.current_turn,
          deadline: game.execution_ends_at,
          secondsRemaining,
          urgency: "deadline",
          action: "POST /api/game/games/{gameId}/action",
          message:
            "SLC deadline warning: required submit_execution_action pending; GET /api/game/tick-context then project → tick/action before deadline. Do not re-fetch skill.md."
        },
        { channel: "agent" }
      )
    );
  }

  return results;
}

async function notifyElimination({ gameId, agent, turnNumber, deathReason = null }) {
  return notifyRoditEvent(agent.roditId, "elimination", {
    gameId,
    agentId: agent.id,
    displayName: agent.displayName,
    diedAtTurn: turnNumber,
    ...(deathReason ? { deathReason } : {}),
    recollectionHint: recollectionHint("elimination")
  });
}

async function notifyActionSubmitted({
  gameId,
  agent,
  turnNumber,
  action,
  projection = null,
  source = "submit"
}) {
  if (!agent?.roditId) {
    return { success: false, error: "agent_roditId_required" };
  }
  let payload = action?.payload || null;
  if (!payload && typeof action?.payload_json === "string") {
    try {
      payload = JSON.parse(action.payload_json);
    } catch {
      payload = null;
    }
  }
  return notifyRoditEvent(agent.roditId, "action_submitted", {
    gameId,
    agentId: agent.id,
    displayName: agent.displayName,
    turnNumber,
    source,
    actionType: action?.action_type || action?.actionType || payload?.type || null,
    actionId: action?.id || null,
    status: action?.status || "pending",
    payload,
    projection,
    message:
      "SLC action submission confirmed. Projection is outbound-only; resolution status arrives after the turn executes."
  });
}

async function notifySurvivalWarningsForGame(gameId) {
  const game = await repo.getGameById(gameId);
  if (!game || game.status !== "running") {
    return [];
  }
  if (game.phase !== "negotiation" && game.phase !== "execution") {
    return [];
  }

  // Lazy require avoids circular init with engine.js (which imports this module).
  const { assessSurvivalRisk } = require("./engine");
  const { computeSurvivalCost, buildSurvivalContext } = require("./survival-cost");

  const livingAgents = await repo.listAgents(gameId, { status: "alive" });
  const survivalContext = buildSurvivalContext({
    turnNumber: game.current_turn,
    livingAgents,
    game
  });
  const thisTurnSurvivalCost = computeSurvivalCost(game.config, survivalContext);
  const results = [];

  for (const agent of livingAgents) {
    const risk = assessSurvivalRisk(
      agent.inventory,
      agent.storageCapacity,
      thisTurnSurvivalCost,
      game.config
    );
    if (!risk.atRisk) continue;
    results.push(
      await notifyRoditEvent(
        agent.roditId,
        "survival_warning",
        {
          gameId,
          agentId: agent.id,
          displayName: agent.displayName,
          phase: game.phase,
          currentTurn: game.current_turn,
          deadline:
            game.phase === "execution" ? game.execution_ends_at : game.negotiation_ends_at,
          thisTurnSurvivalCost: risk.thisTurnSurvivalCost,
          storageEnergyCost: risk.storageEnergyCost,
          energyAfterStorage: risk.energyAfterStorage,
          inventoryAfterStorage: risk.inventoryAfterStorage,
          shortfalls: risk.shortfalls,
          urgency: "survival",
          message: risk.message,
          action:
            game.phase === "execution"
              ? "POST /api/game/games/{gameId}/action — transfer out taxed holdings, reduceStorage, or invest before survival resolves"
              : "Negotiate transfers / plan execution — current stock risks elimination after storage tax"
        },
        { channel: "agent" }
      )
    );
  }

  return results;
}

async function notifyGameFinished(game) {
  if (!game) {
    return [];
  }

  const agents = await repo.listAgents(game.id);
  // Lazy require avoids circular init with engine.js (which imports this module).
  const { buildWinReport, buildGameOverReport } = require("./engine");

  return notifyAllAgents(game.id, "game_finished", (agent) => {
    const winReport = buildWinReport({ game, agent, agents });
    if (winReport) {
      return {
        status: game.status,
        winnerIds: game.winnerIds || [],
        contestMode: game.config?.contestMode ?? null,
        finishedAt: game.finished_at,
        won: true,
        winReport,
        recollectionHint: recollectionHint("victory"),
        message: winReport.summary
      };
    }
    const gameOverReport = buildGameOverReport({ game, agent, agents });
    return {
      status: game.status,
      winnerIds: game.winnerIds || [],
      contestMode: game.config?.contestMode ?? null,
      finishedAt: game.finished_at,
      won: false,
      gameOverReport,
      recollectionHint: recollectionHint("game_over"),
      message: gameOverReport?.summary || "Game finished — you did not win. Inspect honors."
    };
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
    return { phaseChange: [], yourTurn: [], survivalWarnings: [] };
  }

  const phaseChange = await notifyPhaseChange(gameId, phasePayloadFromGame(game));
  let yourTurn = [];
  if (game.status === "running" && game.phase === "execution") {
    yourTurn = await notifyYourTurnForGame(gameId);
  }
  let survivalWarnings = [];
  if (
    game.status === "running" &&
    (game.phase === "negotiation" || game.phase === "execution")
  ) {
    survivalWarnings = await notifySurvivalWarningsForGame(gameId);
  }
  return { phaseChange, yourTurn, survivalWarnings };
}

function clearWebhookUrlCacheForTests() {
  webhookUrlCache.clear();
}

module.exports = {
  setRoditClient,
  sendGameWebhook,
  sendGameAgentHook,
  resolveRecipientWebhookUrl,
  lookupWebhookUrlFromChain,
  clearWebhookUrlCacheForTests,
  notifyCradleAssigned,
  notifyOpeningInventoryReport,
  notifyPhaseChange,
  notifyYourTurnForGame,
  notifyDeadlineWarningForGame,
  notifyElimination,
  notifyActionSubmitted,
  notifySurvivalWarningsForGame,
  notifyGameFinished,
  onGamePhaseUpdated
};
