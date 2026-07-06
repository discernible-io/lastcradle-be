#!/usr/bin/env node
/**
 * Single 4-player sample game using default config (10× starting inventory range).
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "game-sample-4p.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const { computeSurvivalCost } = require("../src/game/survival-cost");
const { buildInvestAction } = require("../src/game/defaults");

const PROFILES = [
  { roditId: "p-alpha", displayName: "Alpha" },
  { roditId: "p-beta", displayName: "Beta" },
  { roditId: "p-gamma", displayName: "Gamma" },
  { roditId: "p-delta", displayName: "Delta" }
];

/** Each player runs at least proposal → counter → acceptance with the group (3 partners). */
const TURN_PLANS = [
  {
    messages: [
      { from: "p-alpha", body: "Proposal: I lead energy investment; seeking water and compute partners." },
      { from: "p-beta", body: "Counter: I'll lead water if Alpha commits 15 energy invest and Gamma covers compute." },
      { from: "p-alpha", body: "Accept: locked — Alpha energy 15, Beta water 12, Gamma compute 10." },
      { from: "p-beta", body: "Proposal: water lead confirmed; Delta, stay out of water trades this turn?" },
      { from: "p-gamma", body: "Counter: compute lead works if Beta keeps surplus water for a future swap." },
      { from: "p-beta", body: "Accept: water surplus reserved; no transfers until we agree terms." },
      { from: "p-gamma", body: "Proposal: compute invest 10 this turn; Alpha/Beta confirm specialties." },
      { from: "p-delta", body: "Counter: confirm I am reserve only — no one expects Delta transfers?" },
      { from: "p-gamma", body: "Accept: no transfers requested from Delta this turn." },
      { from: "p-delta", body: "Proposal: observer stance with honest message reporting." },
      { from: "p-alpha", body: "Counter: agreed — keep a public channel open for energy aid requests." },
      { from: "p-delta", body: "Accept: will signal before asking for help." }
    ],
    actions: {
      "p-alpha": buildInvestAction("energy", 15),
      "p-beta": buildInvestAction("water", 12),
      "p-gamma": buildInvestAction("compute", 10),
      "p-delta": { type: "none" }
    }
  },
  {
    messages: [
      { from: "p-alpha", body: "Proposal: continue energy invest 10+5 split; any water pressure?" },
      { from: "p-beta", body: "Counter: water stable — I pause invest unless Gamma shares compute surplus." },
      { from: "p-alpha", body: "Accept: Alpha invests energy 10 and 5 water without transfers." },
      { from: "p-gamma", body: "Proposal: compute invest 8; need confirmation Beta stays liquid." },
      { from: "p-beta", body: "Counter: I hold water this turn; no compute purchase from me." },
      { from: "p-gamma", body: "Accept: proceed with compute 8 from own stock." },
      { from: "p-delta", body: "Proposal: remain passive; request weekly survival margin check." },
      { from: "p-gamma", body: "Counter: margins ok if nobody over-messages — compute cost adds up." },
      { from: "p-delta", body: "Accept: I'll keep reports accurate and stay lean on chat." },
      { from: "p-beta", body: "Proposal: reopen water-for-compute talks next turn if Gamma leads compute." },
      { from: "p-delta", body: "Counter: note trade in public before execution phase." },
      { from: "p-beta", body: "Accept: public deal memo before any transfer." }
    ],
    actions: {
      "p-alpha": buildInvestAction("energy", 10),
      "p-beta": { type: "none" },
      "p-gamma": buildInvestAction("compute", 8),
      "p-delta": { type: "none" }
    }
  },
  {
    messages: [
      { from: "p-beta", body: "Proposal: transfer 20 water to Gamma; request compute growth share next turn." },
      { from: "p-gamma", body: "Counter: accept water if I invest compute 10+5 water this turn." },
      { from: "p-beta", body: "Accept: 20 water transfer for Gamma compute invest commitment." },
      { from: "p-gamma", body: "Proposal: compute invest 10 with 5 water co-invest after receipt." },
      { from: "p-alpha", body: "Counter: confirm this does not pull Alpha into water subsidy." },
      { from: "p-gamma", body: "Accept: Alpha not involved — bilateral Beta/Gamma deal." },
      { from: "p-alpha", body: "Proposal: hold energy; no action this turn." },
      { from: "p-delta", body: "Counter: log transfer amounts in thread before execution." },
      { from: "p-alpha", body: "Accept: deal logged publicly for all witnesses." },
      { from: "p-delta", body: "Proposal: continue observer role; monitor water survival drift." },
      { from: "p-beta", body: "Counter: Delta may need water aid later if global consumption rises." },
      { from: "p-delta", body: "Accept: will ask openly if margins tighten." }
    ],
    actions: (agents) => ({
      "p-alpha": { type: "none" },
      "p-beta": {
        type: "transfer",
        toAgentId: agents.find((a) => a.roditId === "p-gamma").id,
        energy: 0,
        water: 20,
        compute: 0
      },
      "p-gamma": buildInvestAction("compute", 10),
      "p-delta": { type: "none" }
    })
  },
  {
    messages: [
      { from: "p-alpha", body: "Proposal: energy invest 20; need group ack on rising water survival." },
      { from: "p-beta", body: "Counter: I'll water invest 15 if Alpha slows energy after this push." },
      { from: "p-alpha", body: "Accept: one more energy push then plateau." },
      { from: "p-beta", body: "Proposal: water invest 15 with 5 energy co-invest." },
      { from: "p-gamma", body: "Counter: pausing compute if water costs keep climbing." },
      { from: "p-beta", body: "Accept: Beta absorbs water pressure via invest." },
      { from: "p-gamma", body: "Proposal: hold compute action; reassess after survival tick." },
      { from: "p-delta", body: "Counter: request Beta water-invest share data before I act." },
      { from: "p-gamma", body: "Accept: public state shows Beta water investment lead." },
      { from: "p-delta", body: "Proposal: remain idle; honest message counts only." },
      { from: "p-alpha", body: "Counter: keep compute budget for reports — 3 msgs/turn adds up." },
      { from: "p-delta", body: "Accept: reporting exactly what we sent in negotiation." }
    ],
    actions: {
      "p-alpha": buildInvestAction("energy", 20),
      "p-beta": buildInvestAction("water", 15),
      "p-gamma": { type: "none" },
      "p-delta": { type: "none" }
    }
  },
  {
    messages: [
      { from: "p-alpha", body: "Proposal: hold actions; survival costs rising — conserve compute." },
      { from: "p-beta", body: "Counter: agree hold if Gamma skips compute invest too." },
      { from: "p-alpha", body: "Accept: coordinated pause unless emergency." },
      { from: "p-gamma", body: "Proposal: small compute invest 5 to maintain dev lead." },
      { from: "p-delta", body: "Counter: oppose if it risks compute survival margin." },
      { from: "p-gamma", body: "Accept: invest 5 only — minimal compute burn." },
      { from: "p-beta", body: "Proposal: group hold on transfers this turn." },
      { from: "p-alpha", body: "Counter: confirm water survival projections before next invest round." },
      { from: "p-beta", body: "Accept: check projected water survival in public state." },
      { from: "p-delta", body: "Proposal: observer hold; continue accurate reports." },
      { from: "p-gamma", body: "Counter: align message counts — each of us sent three in thread." },
      { from: "p-delta", body: "Accept: three sent, received nine public broadcasts — report honestly." }
    ],
    actions: {
      "p-alpha": { type: "none" },
      "p-beta": { type: "none" },
      "p-gamma": buildInvestAction("compute", 5),
      "p-delta": { type: "none" }
    }
  }
];

function buildDefaultNegotiation(turnNumber) {
  return [
    { from: "p-alpha", body: `[T${turnNumber}] Proposal: review survival margins before investing.` },
    { from: "p-beta", body: `[T${turnNumber}] Counter: water invest priority if global consumption up.` },
    { from: "p-alpha", body: `[T${turnNumber}] Accept: defer energy spike; monitor water.` },
    { from: "p-beta", body: `[T${turnNumber}] Proposal: maintain water investment share.` },
    { from: "p-gamma", body: `[T${turnNumber}] Counter: compute trade only if margins allow.` },
    { from: "p-beta", body: `[T${turnNumber}] Accept: no transfers without public deal memo.` },
    { from: "p-gamma", body: `[T${turnNumber}] Proposal: hold or minimal compute invest.` },
    { from: "p-delta", body: `[T${turnNumber}] Counter: confirm no hidden offline deals.` },
    { from: "p-gamma", body: `[T${turnNumber}] Accept: public channel only for binding terms.` },
    { from: "p-delta", body: `[T${turnNumber}] Proposal: observer hold unless survival emergency.` },
    { from: "p-alpha", body: `[T${turnNumber}] Counter: keep energy aid offer on table.` },
    { from: "p-delta", body: `[T${turnNumber}] Accept: will broadcast before any aid request.` }
  ];
}

function countMessagesBySender(messages) {
  const counts = Object.fromEntries(PROFILES.map((p) => [p.displayName, 0]));
  for (const msg of messages) {
    const profile = PROFILES.find((p) => p.roditId === msg.from);
    if (profile) counts[profile.displayName] += 1;
  }
  return counts;
}

function fmt(n) {
  return typeof n === "number" ? n.toFixed(1) : "—";
}

function printAgentRow(agent, game, livingAgents) {
  if (agent.status !== "alive") {
    console.log(
      `  ${agent.displayName.padEnd(6)} DEAD (turn ${agent.diedAtTurn})`
    );
    return;
  }
  const survival = computeSurvivalCost(game.config, {
    aggregateWaterConsumed: game.aggregateWaterConsumed || 0,
    agentWaterInvestment: agent.waterProductionInvestment || 0,
    totalWaterInvestment: livingAgents.reduce(
      (s, a) => s + (a.waterProductionInvestment || 0),
      0
    ),
    livingCount: livingAgents.length,
    energyPenalty: 0
  });
  const inv = agent.inventory;
  const dev = agent.development;
  const cap = agent.capacity;
  console.log(
    `  ${agent.displayName.padEnd(6)} ` +
      `inv E${fmt(inv.energy)} W${fmt(inv.water)} C${fmt(inv.compute)} | ` +
      `dev E${dev.energy.toFixed(2)} W${dev.water.toFixed(2)} C${dev.compute.toFixed(2)} | ` +
      `cap E${cap.energy} W${cap.water} C${cap.compute} | ` +
      `waterInv ${fmt(agent.waterProductionInvestment)} | ` +
      `nextSurv E${fmt(survival.energy)} W${fmt(survival.water)} C${fmt(survival.compute)}`
  );
}

async function runTurn(gameId, agents, turnNumber, plan) {
  const living = agents.filter((a) => a.status === "alive");
  const game = await repo.getGameById(gameId);

  console.log(`\n--- Turn ${turnNumber} (growth pool: ${JSON.stringify(game.turnGrowth)}) ---`);

  const messages = plan.messages || [];
  if (messages.length > 0) {
    const bySender = countMessagesBySender(messages);
    const summary = PROFILES.map((p) => `${p.displayName} ${bySender[p.displayName]}`).join(", ");
    console.log(`  Negotiation: ${messages.length} public messages (${summary})`);
  }

  for (const msg of messages) {
    const agent = living.find((a) => a.roditId === msg.from);
    if (!agent || agent.status !== "alive") continue;
    await engine.publishPublicMessage(gameId, agent.id, { body: msg.body });
  }

  await engine.beginMessageReportPhase(gameId);
  console.log("  Message reports:");

  const computeBefore = new Map();
  for (const agent of living) {
    const fresh = await repo.getAgentById(agent.id);
    if (fresh.status !== "alive") continue;
    computeBefore.set(agent.id, fresh.inventory.compute);
  }

  let messageReportResults = null;
  for (const agent of living) {
    const fresh = await repo.getAgentById(agent.id);
    if (fresh.status !== "alive") continue;
    const counts = await repo.getActualMessageCounts(gameId, turnNumber, agent.id);
    const result = await engine.submitMessageReport(gameId, agent.id, counts);
    if (result.messageReportResults) {
      messageReportResults = result.messageReportResults;
    }
    const computeCost = counts.sent * game.config.communicationCostCompute;
    console.log(
      `    ${agent.displayName.padEnd(6)} reported sent=${counts.sent} received=${counts.received} → compute cost ${computeCost} (before C${fmt(computeBefore.get(agent.id))})`
    );
  }

  if (messageReportResults) {
    const { globalReportMismatch, totalReportedSent, totalReportedReceived, energySurvivalPenalty, communicationCostCompute } =
      messageReportResults;
    console.log(
      `    Totals: sent=${totalReportedSent} received=${totalReportedReceived} mismatch=${globalReportMismatch} → energy survival +${energySurvivalPenalty} each (at ${communicationCostCompute} compute per sent msg)`
    );
    for (const row of messageReportResults.agents) {
      const name = agents.find((a) => a.id === row.agentId)?.displayName || row.agentId;
      const after = await repo.getAgentById(row.agentId);
      const before = computeBefore.get(row.agentId);
      console.log(
        `    ${name.padEnd(6)} compute deducted ${row.computeDeduction}: C${fmt(before)} → C${fmt(after.inventory.compute)}`
      );
    }
  }

  await engine.beginExecutionPhase(gameId);

  const actionMap =
    typeof plan.actions === "function" ? plan.actions(agents) : plan.actions;

  for (const agent of living) {
    const fresh = await repo.getAgentById(agent.id);
    if (fresh.status !== "alive") continue;
    let action = actionMap[agent.roditId] || { type: "none" };
    if (action.type === "transfer") {
      const recipient = agents.find((a) => a.id === action.toAgentId);
      if (!recipient || recipient.status !== "alive") action = { type: "none" };
    }
    await engine.submitAction(gameId, agent.id, action);
  }

  const state = await engine.getPublicState(gameId);
  const gameAfter = await repo.getGameById(gameId);
  const livingAfter = state.agents.filter((a) => a.status === "alive");

  console.log(`  Aggregate water consumed: ${fmt(state.game.aggregateWaterConsumed)}`);
  console.log("  Player snapshot (inventory after message compute costs + turn resolution):");
  for (const agent of state.agents) {
    printAgentRow(agent, gameAfter, livingAfter);
  }

  return state;
}

async function main() {
  await repo.initializeDatabase();

  const game = await engine.createGame({});
  const gameId = game.id;

  console.log("4-player sample game (default config, 10× inventory range 20–200)");
  console.log(`Game ID: ${gameId}\n`);
  console.log("=== LOBBY (after join, before turn 1 production) ===");

  const agents = [];
  for (const profile of PROFILES) {
    const agent = await engine.joinGame(gameId, profile);
    agents.push(agent);
    const inv = agent.inventory;
    const cap = agent.capacity;
    console.log(
      `  ${profile.displayName.padEnd(6)} start inv E${inv.energy} W${inv.water} C${inv.compute} | cradle cap E${cap.energy} W${cap.water} C${cap.compute}`
    );
  }

  await engine.startGame(gameId);
  console.log("\n=== AFTER TURN 1 PRODUCTION (start of turn 1) ===");
  let state = await engine.getPublicState(gameId);
  let gameRow = await repo.getGameById(gameId);
  const living = state.agents.filter((a) => a.status === "alive");
  for (const agent of state.agents) {
    printAgentRow(agent, gameRow, living);
  }

  const maxTurns = 20;
  for (let turn = 1; turn <= maxTurns; turn++) {
    const plan = TURN_PLANS[turn - 1] || {
      messages: buildDefaultNegotiation(turn),
      actions: Object.fromEntries(PROFILES.map((p) => [p.roditId, { type: "none" }]))
    };
    state = await runTurn(gameId, agents, turn, plan);
    for (let i = 0; i < agents.length; i++) {
      agents[i] = (await repo.listAgents(gameId)).find((a) => a.id === agents[i].id);
    }
    if (state.game.status === "finished") {
      console.log(`\n=== GAME FINISHED after turn ${turn} ===`);
      console.log(`Winners: ${state.agents.filter((a) => state.game.winnerIds.includes(a.id)).map((a) => a.displayName).join(", ")}`);
      break;
    }
  }

  await repo.closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
