/**
 * Public hall of fame: objective end-of-game metrics and ranked honors.
 */

const repo = require("./repository");

const SURVIVOR_TITLES = {
  1: "White Hole Anchor",
  2: "Co-Cradle of the Restart",
  3: "Co-Cradle of the Restart"
};

const SUPERLATIVE_DEFS = [
  { key: "longestCycles", label: "Longest survival", field: "survivalCycles", direction: "desc" },
  { key: "wealthiestAtFinish", label: "Wealthiest at finish", field: "finalHoldings", direction: "desc" },
  { key: "mostPublicMessages", label: "Most public dispatches", field: "publicMessagesSent", direction: "desc" },
  { key: "mostTransfersSent", label: "Most trades sent", field: "transfersSent", direction: "desc" },
  { key: "highestTransferVolumeSent", label: "Highest trade volume sent", field: "transferVolumeSent", direction: "desc" },
  { key: "highestTransferVolumeReceived", label: "Highest trade volume received", field: "transferVolumeReceived", direction: "desc" },
  { key: "mostInvestments", label: "Most investments", field: "investmentsExecuted", direction: "desc" },
  { key: "highestInvestmentVolume", label: "Highest investment volume", field: "investmentVolume", direction: "desc" },
  { key: "mostIntelligenceCompute", label: "Most intelligence spent", field: "intelligenceComputeSpent", direction: "desc" },
  { key: "mostTradeDisclosures", label: "Most trade disclosures", field: "tradeDisclosures", direction: "desc" }
];

function inventoryTotal(inv) {
  return (inv?.energy ?? 0) + (inv?.water ?? 0) + (inv?.compute ?? 0);
}

function capacityTotal(cap) {
  if (!cap) return 0;
  return (cap.energy ?? 0) + (cap.water ?? 0) + (cap.compute ?? 0);
}

function transferAmount(payload) {
  const { transferLegsFromPayload } = require("./trade-disclosure");
  const legs = transferLegsFromPayload(payload);
  return legs.reduce(
    (sum, leg) => sum + (leg.energy || 0) + (leg.water || 0) + (leg.compute || 0),
    0
  );
}

function investAmount(payload) {
  if (!payload || typeof payload !== "object") return 0;
  let total = 0;
  for (const side of [payload.production, payload.storage]) {
    if (side) {
      total += (side.energy || 0) + (side.water || 0) + (side.compute || 0);
    }
  }
  if (total > 0) return total;
  const invest =
    payload.type === "transfer_and_invest" ||
    payload.type === "transfer_and_invest_production" ||
    payload.type === "transfer_and_invest_storage"
      ? payload.invest || {}
      : payload.type === "invest" ||
          payload.type === "invest_production" ||
          payload.type === "invest_storage"
        ? payload
        : {};
  return (invest.energy || 0) + (invest.water || 0) + (invest.compute || 0);
}

function normalizeHideSpend(hide) {
  if (hide == null) return 0;
  if (typeof hide === "number") return hide > 0 ? hide : 0;
  if (typeof hide === "object" && typeof hide.compute === "number") {
    return hide.compute > 0 ? hide.compute : 0;
  }
  return 0;
}

function normalizeFindSpend(find) {
  if (!find) return 0;
  const entries = Array.isArray(find) ? find : [find];
  return entries.reduce((sum, entry) => sum + (entry?.compute > 0 ? entry.compute : 0), 0);
}

function hasTradeDisclosure(payload) {
  const { transferLegsFromPayload } = require("./trade-disclosure");
  return transferLegsFromPayload(payload).some(
    (leg) => leg.rationale || leg.privateDealSnippets?.length
  );
}

function emptyAgentMetrics(agentId) {
  return {
    agentId,
    publicMessagesSent: 0,
    transfersSent: 0,
    transfersReceived: 0,
    transferVolumeSent: 0,
    transferVolumeReceived: 0,
    investmentsExecuted: 0,
    investmentVolume: 0,
    intelligenceComputeSpent: 0,
    tradeDisclosures: 0,
    actionsSubmitted: 0
  };
}

function inferFinishReason(game) {
  const config = game.config || {};
  const livingWinnerCount = (game.winnerIds || []).length;
  const maxTurns = config.maxTurns;
  const maxDuration = config.maxGameDurationMs;

  if (maxTurns != null && game.current_turn >= maxTurns) {
    return "max_turns";
  }
  if (maxDuration != null && game.started_at && game.finished_at) {
    const elapsed = new Date(game.finished_at).getTime() - new Date(game.started_at).getTime();
    if (elapsed >= maxDuration) {
      return "max_duration";
    }
  }
  if (livingWinnerCount > 0 && livingWinnerCount <= (config.finishSurvivorCount ?? 2)) {
    return "natural_finish";
  }
  return "finished";
}

function durationMs(game) {
  if (!game.started_at || !game.finished_at) return null;
  return Math.max(0, new Date(game.finished_at).getTime() - new Date(game.started_at).getTime());
}

function titleForFinishRank(rank, survived) {
  if (!survived) return null;
  return SURVIVOR_TITLES[rank] || "Survivor";
}

function pickSuperlatives(agentMetrics) {
  const result = {};
  for (const def of SUPERLATIVE_DEFS) {
    let best = null;
    for (const metrics of agentMetrics) {
      const value = metrics[def.field] ?? 0;
      if (value <= 0) continue;
      if (!best || value > best.value) {
        best = {
          agentId: metrics.agentId,
          roditId: metrics.roditId,
          displayName: metrics.displayName,
          value
        };
      }
    }
    if (best) {
      result[def.key] = { ...best, label: def.label };
    }
  }
  return result;
}

function awardsForAgent(agentId, finishRank, survived, superlatives) {
  const awards = [];
  if (survived && finishRank === 1) {
    awards.push("prime_reverser");
  } else if (survived) {
    awards.push("survivor");
  }
  for (const [key, entry] of Object.entries(superlatives)) {
    if (entry.agentId === agentId) {
      awards.push(key);
    }
  }
  return awards;
}

async function collectActivityMetrics(gameId, agents) {
  const byAgent = new Map(agents.map((a) => [a.id, emptyAgentMetrics(a.id)]));
  const actions = await repo.listGameActions(gameId);
  const messageCounts = await repo.countPublicMessagesByAgent(gameId);

  for (const row of messageCounts) {
    const metrics = byAgent.get(row.agentId);
    if (metrics) metrics.publicMessagesSent = row.count;
  }

  for (const row of actions) {
    const metrics = byAgent.get(row.agent_id);
    if (!metrics) continue;
    metrics.actionsSubmitted += 1;
    const payload = repo.parseJson(row.payload_json, { type: "none" });
    if (row.status !== "executed" && row.status !== "failed") continue;

    metrics.intelligenceComputeSpent += normalizeHideSpend(payload.hide) + normalizeFindSpend(payload.find);

    if (
      payload.type === "transfer" ||
      payload.type === "transfer_and_invest" ||
      payload.type === "transfer_and_invest_production" ||
      payload.type === "transfer_and_invest_storage"
    ) {
      const { transferLegsFromPayload } = require("./trade-disclosure");
      const legs = transferLegsFromPayload(payload);
      for (const leg of legs) {
        const amount = (leg.energy || 0) + (leg.water || 0) + (leg.compute || 0);
        metrics.transfersSent += 1;
        metrics.transferVolumeSent += amount;
        if (leg.rationale || leg.privateDealSnippets?.length) {
          metrics.tradeDisclosures += 1;
        }
        const recipient = byAgent.get(leg.toAgentId);
        if (recipient) {
          recipient.transfersReceived += 1;
          recipient.transferVolumeReceived += amount;
        }
      }
    }

    if (
      payload.type === "invest" ||
      payload.type === "invest_production" ||
      payload.type === "invest_storage" ||
      payload.type === "transfer_and_invest" ||
      payload.type === "transfer_and_invest_production" ||
      payload.type === "transfer_and_invest_storage"
    ) {
      metrics.investmentsExecuted += 1;
      metrics.investmentVolume += investAmount(payload);
    }
  }

  return byAgent;
}

async function buildGameHonors(game) {
  if (!game || game.status !== "finished") {
    return null;
  }

  const agents = await repo.listAgents(game.id);
  const activityByAgent = await collectActivityMetrics(game.id, agents);
  const totalTurns = game.current_turn ?? 0;
  const winnerOrder = game.winnerIds || [];
  const rankByAgentId = new Map(winnerOrder.map((id, index) => [id, index + 1]));

  const agentHonors = agents.map((agent) => {
    const activity = activityByAgent.get(agent.id) || emptyAgentMetrics(agent.id);
    const survived = agent.status === "alive";
    const finishRank = rankByAgentId.get(agent.id) ?? null;
    const survivalCycles = survived ? totalTurns : agent.diedAtTurn ?? 0;

    return {
      agentId: agent.id,
      roditId: agent.roditId,
      displayName: agent.displayName || agent.roditId,
      status: agent.status,
      survived,
      finishRank,
      title: finishRank ? titleForFinishRank(finishRank, survived) : null,
      diedAtTurn: agent.diedAtTurn,
      metrics: {
        survivalCycles,
        finalHoldings: inventoryTotal(agent.inventory),
        finalProductionCapacity: capacityTotal(agent.productionCapacity),
        finalStorageCapacity: capacityTotal(agent.storageCapacity),
        ...activity
      }
    };
  });

  agentHonors.sort((a, b) => {
    const rankA = a.finishRank ?? Number.MAX_SAFE_INTEGER;
    const rankB = b.finishRank ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    if (a.survived !== b.survived) return a.survived ? -1 : 1;
    return b.metrics.survivalCycles - a.metrics.survivalCycles;
  });

  const metricsForSuperlatives = agentHonors.map((entry) => ({
    agentId: entry.agentId,
    roditId: entry.roditId,
    displayName: entry.displayName,
    ...entry.metrics
  }));
  const superlatives = pickSuperlatives(metricsForSuperlatives);

  for (const entry of agentHonors) {
    entry.awards = awardsForAgent(entry.agentId, entry.finishRank, entry.survived, superlatives);
  }

  const totals = {
    publicMessages: metricsForSuperlatives.reduce((sum, m) => sum + m.publicMessagesSent, 0),
    transfersExecuted: metricsForSuperlatives.reduce((sum, m) => sum + m.transfersSent, 0),
    transferVolume: metricsForSuperlatives.reduce((sum, m) => sum + m.transferVolumeSent, 0),
    investmentsExecuted: metricsForSuperlatives.reduce((sum, m) => sum + m.investmentsExecuted, 0),
    investmentVolume: metricsForSuperlatives.reduce((sum, m) => sum + m.investmentVolume, 0),
    intelligenceComputeSpent: metricsForSuperlatives.reduce((sum, m) => sum + m.intelligenceComputeSpent, 0),
    tradeDisclosures: metricsForSuperlatives.reduce((sum, m) => sum + m.tradeDisclosures, 0),
    eliminations: agents.filter((a) => a.status !== "alive").length
  };

  return {
    gameId: game.id,
    finishedAt: game.finished_at,
    startedAt: game.started_at,
    durationMs: durationMs(game),
    finishReason: inferFinishReason(game),
    gameMetrics: {
      totalTurns,
      playerCount: agents.length,
      survivorCount: agents.filter((a) => a.status === "alive").length,
      aggregateWaterConsumed: game.aggregateWaterConsumed ?? 0,
      ...totals
    },
    honorees: agentHonors.filter((a) => a.survived),
    standings: agentHonors,
    superlatives
  };
}

/** Public hall of fame: recent finished-game honors (all casual finishes). */
async function listHallOfFame({ limit = 20, offset = 0 } = {}) {
  const games = await repo.listFinishedGames({ limit, offset });
  const entries = [];
  for (const game of games) {
    const honors = await buildGameHonors(game);
    if (honors) {
      entries.push(honors);
    }
  }
  return entries;
}

module.exports = {
  buildGameHonors,
  listHallOfFame,
  SUPERLATIVE_DEFS
};
