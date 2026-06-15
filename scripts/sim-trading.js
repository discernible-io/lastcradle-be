/**
 * Shared trade action builder for N-player simulations.
 * Targets at least floor(playerCount / 2) transfers per turn when enough agents are alive.
 */

const { buildInvestAction } = require("../src/game/defaults");

const TRANSFER_BY_SPECIALTY = {
  energy: { energy: 12, water: 0, compute: 0 },
  water: { energy: 0, water: 12, compute: 0 },
  compute: { energy: 0, water: 0, compute: 10 },
  reserve: { energy: 0, water: 8, compute: 0 }
};

function transferForSpecialty(specialty) {
  if (specialty === "energy") return TRANSFER_BY_SPECIALTY.energy;
  if (specialty === "water") return TRANSFER_BY_SPECIALTY.water;
  if (specialty === "compute") return TRANSFER_BY_SPECIALTY.compute;
  return TRANSFER_BY_SPECIALTY.reserve;
}

function tradesTargetFor(playerCount) {
  return Math.floor(Math.max(playerCount, 0) / 2);
}

const HIDE_COMPUTE = 7;
const FIND_COMPUTE = 11;

function computeAvailableAfterAction(agent, action) {
  let compute = agent.inventory?.compute ?? 0;
  if (action.type === "invest") {
    compute -= action.compute || action.energy || 0;
  }
  return compute;
}

/**
 * Attach hide/find to execution actions. Find spend must exceed target hide to reveal capacities.
 * Traders scout recipients; investors and reserves conceal; compute specialists probe rivals.
 */
function withIntelligence(action, agent, { profiles, living, turnNumber }) {
  const next = { ...action };
  const specialty = profiles.find((p) => p.roditId === agent.roditId)?.specialty;
  let intelSpend = 0;

  if (next.type === "transfer" && next.toAgentId) {
    if (computeAvailableAfterAction(agent, next) >= intelSpend + FIND_COMPUTE) {
      next.find = [{ targetAgentId: next.toAgentId, compute: FIND_COMPUTE }];
      intelSpend += FIND_COMPUTE;
    }
  } else if (next.type === "invest" || (next.type === "none" && specialty === null)) {
    if (computeAvailableAfterAction(agent, next) >= intelSpend + HIDE_COMPUTE) {
      next.hide = HIDE_COMPUTE;
      intelSpend += HIDE_COMPUTE;
    }
  }

  if (specialty === "compute" && next.type !== "transfer") {
    const rivals = living.filter((a) => a.id !== agent.id);
    if (rivals.length) {
      const target = rivals[(turnNumber + living.indexOf(agent)) % rivals.length];
      if (computeAvailableAfterAction(agent, next) >= intelSpend + FIND_COMPUTE) {
        next.find = [{ targetAgentId: target.id, compute: FIND_COMPUTE }];
      }
    }
  }

  return next;
}

/**
 * Build execution actions with heavy trading plus specialty investment for non-traders.
 */
function buildHeavyTradeActions(agents, profiles, playerCount, turnNumber = 1) {
  const living = agents.filter((a) => a.status === "alive");
  const actions = Object.fromEntries(profiles.map((p) => [p.roditId, { type: "none" }]));
  const targetTrades = tradesTargetFor(playerCount);
  if (living.length < 2 || targetTrades === 0) {
    return actions;
  }

  const offset = (turnNumber - 1) % living.length;
  const recipientOffset = Math.max(1, Math.ceil(living.length / 2));
  let tradesAssigned = 0;

  for (let i = 0; i < living.length && tradesAssigned < targetTrades; i++) {
    const donor = living[(i + offset) % living.length];
    const recipient = living[(i + offset + recipientOffset) % living.length];
    if (donor.id === recipient.id) continue;
    if (actions[donor.roditId]?.type === "transfer") continue;

    const profile = profiles.find((p) => p.roditId === donor.roditId);
    const pack = transferForSpecialty(profile?.specialty ?? null);
    actions[donor.roditId] = {
      type: "transfer",
      toAgentId: recipient.id,
      ...pack
    };
    tradesAssigned += 1;
  }

  for (const agent of living) {
    const roditId = agent.roditId;
    if (actions[roditId]?.type === "transfer") continue;
    const specialty = profiles.find((p) => p.roditId === roditId)?.specialty;
    if (specialty === "energy") {
      actions[roditId] = buildInvestAction("energy", 10);
    } else if (specialty === "water") {
      actions[roditId] = buildInvestAction("water", 10);
    } else if (specialty === "compute") {
      actions[roditId] = buildInvestAction("compute", 8);
    } else if (turnNumber % 2 === 0) {
      actions[roditId] = buildInvestAction("water", 4);
    }
  }

  for (const agent of living) {
    const roditId = agent.roditId;
    if (actions[roditId]) {
      actions[roditId] = withIntelligence(actions[roditId], agent, {
        profiles,
        living,
        turnNumber
      });
    }
  }

  return actions;
}

module.exports = {
  TRANSFER_BY_SPECIALTY,
  transferForSpecialty,
  tradesTargetFor,
  HIDE_COMPUTE,
  FIND_COMPUTE,
  withIntelligence,
  buildHeavyTradeActions
};
