/**
 * Context-driven agent decisions for simulations.
 * Players read margins, survival pressure, and roster state — no hardwired turn scripts.
 */

const { buildInvestAction } = require("../src/game/defaults");
const { computeSurvivalCost, buildSurvivalContext } = require("../src/game/survival-cost");
const { withIntelligence } = require("./sim-trading");

const RESOURCES = ["energy", "water", "compute"];

function profileFor(profiles, roditId) {
  return profiles.find((p) => p.roditId === roditId);
}

function agentMargins(agent, game, living, turnNumber, energyPenalty = 0) {
  const ctx = buildSurvivalContext({
    config: game.config,
    game,
    livingAgents: living,
    turnNumber,
    energyPenalty
  });
  const survival = computeSurvivalCost(game.config, { ...ctx, energyPenalty });
  const inv = agent.inventory;
  const margins = {
    energy: inv.energy - survival.energy,
    water: inv.water - survival.water,
    compute: inv.compute - survival.compute
  };
  const minMargin = Math.min(margins.energy, margins.water, margins.compute);
  const bottleneck = RESOURCES.reduce((worst, key) =>
    margins[key] < margins[worst] ? key : worst
  );
  return { margins, minMargin, bottleneck, survival };
}

function gamePressure(game, living, turnNumber) {
  const ctx = buildSurvivalContext({
    config: game.config,
    game,
    livingAgents: living,
    turnNumber
  });
  const survival = computeSurvivalCost(game.config, ctx);
  const base = game.config.survivalCost ?? { energy: 11, water: 11, compute: 11 };
  const pressure =
    (survival.energy + survival.water + survival.compute) /
    (base.energy + base.water + base.compute);
  return {
    turnNumber,
    livingCount: living.length,
    survival,
    pressure,
    earlyGame: turnNumber <= 3,
    crowded: living.length >= 4
  };
}

function investAmountFor(margin, pressure, { aggressive = false } = {}) {
  if (margin <= 6) return 0;
  const scale = aggressive ? 1.2 : 1;
  if (margin > 40) return Math.min(16, Math.floor(margin * 0.35 * scale));
  if (margin > 28) return Math.min(12, Math.floor(margin * 0.3 * scale));
  if (margin > 18) return Math.min(8, Math.floor(margin * 0.25 * scale));
  if (margin > 10) return Math.min(5, Math.floor(margin * 0.2 * scale));
  return 0;
}

function specialtyInvestTarget(specialty, bottleneck, pressure) {
  if (specialty) return specialty;
  if (bottleneck === "compute" && pressure.pressure > 1.5) return "water";
  return bottleneck;
}

function chooseInvest(agent, profile, game, living, turnNumber) {
  const { margins, minMargin, bottleneck } = agentMargins(agent, game, living, turnNumber);
  const pressure = gamePressure(game, living, turnNumber);

  if (minMargin <= 4) return { type: "none" };

  const specialty = profile?.specialty ?? null;
  let target = specialtyInvestTarget(specialty, bottleneck, pressure);

  if (!specialty && margins.water > 22 && agent.waterProductionInvestment > 0) {
    const totalWaterInv = living.reduce((s, a) => s + (a.waterProductionInvestment || 0), 0);
    const share = totalWaterInv > 0 ? (agent.waterProductionInvestment || 0) / totalWaterInv : 0;
    if (share < 1 / living.length) target = "water";
  }

  const margin = margins[target];
  const aggressive = pressure.earlyGame && minMargin > 20;
  const amount = investAmountFor(margin, pressure, { aggressive });
  if (amount <= 0) return { type: "none" };

  const prod = agent.productionCapacity?.[target] ?? 0;
  const storage = agent.storageCapacity?.[target] ?? 0;
  // Specialty surplus → grow storage (stop waste). Secondary deficit → grow production.
  const capacity = prod > storage ? "storage" : "production";

  const spend =
    pressure.crowded && !pressure.earlyGame && amount > 6
      ? Math.max(4, Math.floor(amount * 0.6))
      : amount;
  return buildInvestAction(target, spend, capacity);
}

function transferPackFor(specialty, amount) {
  const pack = { energy: 0, water: 0, compute: 0 };
  if (specialty === "energy") pack.energy = amount;
  else if (specialty === "water") pack.water = amount;
  else if (specialty === "compute") pack.compute = amount;
  else pack.water = Math.max(4, Math.floor(amount * 0.7));
  return pack;
}

function chooseRescueTransfers(agents, profiles, game, living, turnNumber, actions) {
  const needy = [];
  for (const agent of living) {
    const { margins, minMargin, bottleneck } = agentMargins(agent, game, living, turnNumber);
    if (minMargin < 8) {
      needy.push({ agent, bottleneck, deficit: 8 - minMargin, margins });
    }
  }
  if (!needy.length) return;

  needy.sort((a, b) => a.margins[a.bottleneck] - b.margins[b.bottleneck]);

  for (const need of needy) {
    const donors = living
      .filter((a) => a.id !== need.agent.id && actions[a.roditId]?.type !== "transfer")
      .map((donor) => {
        const profile = profileFor(profiles, donor.roditId);
        const { margins, minMargin } = agentMargins(donor, game, living, turnNumber);
        const resource = need.bottleneck;
        const surplus = margins[resource];
        const specialty = profile?.specialty;
        const specialtyBonus =
          specialty === resource ? 1.4 : specialty === null && resource === "water" ? 1.1 : 1;
        return { donor, surplus, minMargin, score: surplus * specialtyBonus };
      })
      .filter((d) => d.surplus > 14 && d.minMargin > 10)
      .sort((a, b) => b.score - a.score);

    if (!donors.length) continue;

    const donor = donors[0].donor;
    const profile = profileFor(profiles, donor.roditId);
    const amount = Math.min(
      18,
      Math.max(6, Math.floor(donors[0].surplus * 0.4)),
      Math.floor(need.deficit + 6)
    );
    const pack = transferPackFor(profile?.specialty ?? null, amount);
    pack[need.bottleneck] = Math.max(pack[need.bottleneck] || 0, amount);

    actions[donor.roditId] = {
      type: "transfer",
      toAgentId: need.agent.id,
      ...pack
    };
  }
}

function chooseOpportunisticTrades(agents, profiles, game, living, turnNumber, actions) {
  if (living.length < 3) return;

  const pressure = gamePressure(game, living, turnNumber);
  if (pressure.earlyGame) return;

  for (const agent of living) {
    if (actions[agent.roditId]?.type === "transfer") continue;
    const profile = profileFor(profiles, agent.roditId);
    const specialty = profile?.specialty;
    if (!specialty) continue;

    const { margins, minMargin } = agentMargins(agent, game, living, turnNumber);
    if (margins[specialty] < 22 || minMargin < 12) continue;

    const partners = living.filter((a) => a.id !== agent.id);
    const recipient = partners[(turnNumber + living.indexOf(agent)) % partners.length];
    if (actions[recipient.roditId]?.type === "transfer") continue;

    const { margins: rMargins, bottleneck: rBottleneck } = agentMargins(
      recipient,
      game,
      living,
      turnNumber
    );
    if (rMargins[rBottleneck] > 12) continue;
    if (specialty === rBottleneck) continue;

    const amount = Math.min(14, Math.floor(margins[specialty] * 0.35));
    if (amount < 6) continue;

    const pack = transferPackFor(specialty, amount);
    actions[agent.roditId] = {
      type: "transfer",
      toAgentId: recipient.id,
      ...pack
    };
  }
}

function buildAdaptiveActions(agents, profiles, game, turnNumber) {
  const living = agents.filter((a) => a.status === "alive");
  const actions = Object.fromEntries(profiles.map((p) => [p.roditId, { type: "none" }]));
  if (!living.length) return actions;

  chooseRescueTransfers(agents, profiles, game, living, turnNumber, actions);
  chooseOpportunisticTrades(agents, profiles, game, living, turnNumber, actions);

  for (const agent of living) {
    if (actions[agent.roditId]?.type === "transfer") continue;
    const profile = profileFor(profiles, agent.roditId);
    actions[agent.roditId] = chooseInvest(agent, profile, game, living, turnNumber);
  }

  for (const agent of living) {
    const roditId = agent.roditId;
    if (!actions[roditId]) continue;
    const { minMargin } = agentMargins(agent, game, living, turnNumber);
    if (minMargin < 8 && actions[roditId].hide) {
      const { hide, find, ...rest } = actions[roditId];
      actions[roditId] = rest;
    }
    actions[roditId] = withIntelligence(actions[roditId], agent, {
      profiles,
      living,
      turnNumber
    });
  }

  return actions;
}

function negotiationTopic(game, living, turnNumber) {
  const pressure = gamePressure(game, living, turnNumber);
  const avgMin = living.reduce((sum, agent) => {
    const { minMargin } = agentMargins(agent, game, living, turnNumber);
    return sum + minMargin;
  }, 0) / Math.max(living.length, 1);

  if (avgMin < 10) return "emergency survival coordination";
  if (pressure.earlyGame) return "opening specialty allocation";
  if (pressure.crowded) return "bilateral relief before cost spike";
  return "margin review and trade offers";
}

function msgsPerPlayerForTurn(agents, profiles, game, turnNumber) {
  const living = agents.filter((a) => a.status === "alive");
  if (!living.length) return 0;

  const tightCompute = living.filter((agent) => {
    const { margins } = agentMargins(agent, game, living, turnNumber);
    return margins.compute < 15;
  }).length;

  if (tightCompute >= Math.ceil(living.length / 2)) return 1;
  if (living.length <= 3) return 2;
  return 3;
}

function buildAdaptiveNegotiation(agents, profiles, game, turnNumber) {
  const living = agents.filter((a) => a.status === "alive");
  const topic = negotiationTopic(game, living, turnNumber);
  const kindsByCount = {
    0: [],
    1: ["Proposal"],
    2: ["Proposal", "Counter"],
    3: ["Proposal", "Counter", "Accept"]
  };
  const perPlayer = msgsPerPlayerForTurn(agents, profiles, game, turnNumber);
  const kinds = kindsByCount[perPlayer] || kindsByCount[3];
  const messages = [];

  for (const profile of profiles) {
    const agent = living.find((a) => a.roditId === profile.roditId);
    if (!agent) continue;
    const { minMargin, bottleneck } = agentMargins(agent, game, living, turnNumber);
    for (const kind of kinds) {
      messages.push({
        from: profile.roditId,
        body:
          `[T${turnNumber}] ${kind} (${topic}): ${profile.displayName} ` +
          `— ${bottleneck} margin ${minMargin.toFixed(0)}, role ${profile.role || profile.specialty || "reserve"}.`
      });
    }
  }
  return messages;
}

module.exports = {
  agentMargins,
  gamePressure,
  buildAdaptiveActions,
  buildAdaptiveNegotiation,
  msgsPerPlayerForTurn,
  negotiationTopic
};
