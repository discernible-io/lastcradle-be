/**
 * Build blog-style turn reports from game state, messages, and execution actions.
 */

const { buildSurvivalNarrative, buildFinishNarrative } = require("./narrative");

function agentName(agentById, agentId) {
  const agent = agentById.get(agentId);
  return agent?.displayName || agent?.roditId || agentId;
}

function summarizeTransferLeg(from, leg, agentById) {
  const to = agentName(agentById, leg.toAgentId);
  const parts = [];
  if (leg.energy) parts.push(`${leg.energy} energy`);
  if (leg.water) parts.push(`${leg.water} water`);
  if (leg.compute) parts.push(`${leg.compute} compute`);
  let summary = `${from} sent ${parts.join(", ") || "resources"} to ${to}`;
  if (leg.rationale) {
    summary += ` — why: “${leg.rationale}”`;
  }
  if (leg.privateDealSnippets?.length) {
    const snippetText = leg.privateDealSnippets
      .map((s) => {
        const label = [s.taskType, s.channel].filter(Boolean).join(" via ");
        return label ? `${label}: “${s.excerpt}”` : `“${s.excerpt}”`;
      })
      .join("; ");
    summary += ` [private deal: ${snippetText}]`;
  }
  return summary;
}

function summarizeAction(actionRow, agentById) {
  const payload = typeof actionRow.payload_json === "string"
    ? JSON.parse(actionRow.payload_json || "{}")
    : actionRow.payload_json || actionRow.payload || {};
  const from = agentName(agentById, actionRow.agent_id);
  const type = payload.type || actionRow.action_type || "none";

  if (type === "transfer" || type === "transfer_and_invest") {
    const { transferLegsFromPayload } = require("./trade-disclosure");
    const legs = transferLegsFromPayload(payload);
    const transferParts = legs.map((leg) => summarizeTransferLeg(from, leg, agentById));

    if (type === "transfer_and_invest") {
      const investParts = [];
      const invest = payload.invest || {};
      if (invest.energy) investParts.push(`${invest.energy} into energy production`);
      if (invest.water) investParts.push(`${invest.water} into water production`);
      if (invest.compute) investParts.push(`${invest.compute} into compute production`);
      const investText = investParts.length
        ? `${from} invested ${investParts.join(", ")}`
        : `${from} invested`;
      if (transferParts.length) {
        return `${transferParts.join("; ")}; then ${investText.replace(`${from} `, "")}`;
      }
      return investText;
    }

    if (transferParts.length) {
      return transferParts.join("; ");
    }
  }

  if (type === "invest") {
    const parts = [];
    if (payload.energy) parts.push(`${payload.energy} into energy production`);
    if (payload.water) parts.push(`${payload.water} into water production`);
    if (payload.compute) parts.push(`${payload.compute} into compute production`);
    if (parts.length) {
      return `${from} invested ${parts.join(", ")}`;
    }
  }

  if (type === "none") {
    return `${from} held position (no transfer or investment)`;
  }

  return `${from} executed ${type}`;
}

function inventoryTotal(agent) {
  const inv = agent.inventory;
  return (inv?.energy ?? 0) + (inv?.water ?? 0) + (inv?.compute ?? 0);
}

function pickNegotiationHighlights(messages, agentById, limit = 4) {
  return messages.slice(0, limit).map((msg) => ({
    from: agentName(agentById, msg.from_agent_id),
    body: msg.body
  }));
}

function buildTurnReport({
  turnNumber,
  state,
  messages = [],
  actions = [],
  agents = [],
  gameConfig = {}
}) {
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const eliminated = agents.filter((a) => a.status !== "alive" && a.diedAtTurn === turnNumber);
  const livingCount = state.livingAgentCount ?? agents.filter((a) => a.status === "alive").length;
  const survival = buildSurvivalNarrative({
    livingAgentCount: livingCount,
    turnNumber,
    playerReference: gameConfig.survivalCostPlayerReference ?? 3
  });

  const executionSummaries = actions
    .filter((a) => a.status !== "failed")
    .map((a) => summarizeAction(a, agentById));

  const transfers = executionSummaries.filter((s) => s.includes(" sent "));
  const investments = executionSummaries.filter((s) => s.includes(" invested "));
  const highlights = pickNegotiationHighlights(messages, agentById);

  const headlineParts = [`Cycle ${turnNumber}`];
  if (eliminated.length) {
    headlineParts.push(
      `${eliminated.length} ${eliminated.length === 1 ? "cradle falls silent" : "cradles fall silent"}`
    );
  } else if (transfers.length) {
    headlineParts.push(`${transfers.length} trades executed`);
  } else {
    headlineParts.push(`${livingCount} rivals remain`);
  }

  const paragraphs = [];

  paragraphs.push(survival.summary);

  if (highlights.length) {
    paragraphs.push(
      `The negotiation halls recorded ${messages.length} public dispatches. ` +
        highlights.map((h) => `${h.from}: “${h.body}”`).join(" ")
    );
  }

  if (executionSummaries.length) {
    paragraphs.push(
      `Execution phase: ${executionSummaries.slice(0, 8).join("; ")}` +
        (executionSummaries.length > 8 ? `; …and ${executionSummaries.length - 8} more.` : ".")
    );
  }

  if (eliminated.length) {
    const names = eliminated.map((a) => a.displayName || a.roditId).join(", ");
    paragraphs.push(
      `Survival expenses claimed their due. The cradles of ${names} went dark — ` +
        `their immortal populations could no longer meet the overhead of the reproduction race.`
    );
  }

  if (state.game?.status === "finished" && turnNumber === state.game.currentTurn) {
    const winnerAgents = agents
      .filter((a) => (state.game.winnerIds || []).includes(a.id))
      .sort((a, b) => inventoryTotal(b) - inventoryTotal(a));
    const rankedWinnerNames = winnerAgents.map((a) => a.displayName || a.roditId);
    paragraphs.push(
      ...buildFinishNarrative({
        rankedWinnerNames,
        turnNumber,
        maxTurns: gameConfig.maxTurns
      })
    );
  }

  return {
    turnNumber,
    headline: headlineParts.join(" — "),
    narrative: paragraphs,
    stats: {
      livingCount,
      messageCount: messages.length,
      transferCount: transfers.length,
      investmentCount: investments.length,
      eliminated: eliminated.map((a) => ({
        id: a.id,
        displayName: a.displayName,
        roditId: a.roditId
      }))
    },
    negotiationHighlights: highlights,
    execution: executionSummaries
  };
}

module.exports = {
  buildTurnReport,
  summarizeAction
};
