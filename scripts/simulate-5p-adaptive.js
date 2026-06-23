#!/usr/bin/env node
/**
 * 5-player simulation with full mechanics and context-driven strategy.
 * No hardwired turn plans — agents adapt each turn to margins, pressure, and roster.
 *
 * Usage:
 *   node scripts/simulate-5p-adaptive.js          # 25 turns
 *   node scripts/simulate-5p-adaptive.js finish  # until ≤2 survivors
 *   node scripts/simulate-5p-adaptive.js 50        # max N turns
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "game-simulation-5p-adaptive.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const { computeSurvivalCost, buildSurvivalContext } = require("../src/game/survival-cost");
const { buildAdaptiveActions, buildAdaptiveNegotiation, negotiationTopic } = require("./sim-adaptive");

const PROFILES = [
  { roditId: "t-alpha", displayName: "Alpha", specialty: "energy", role: "energy lead" },
  { roditId: "t-beta", displayName: "Beta", specialty: "water", role: "water lead" },
  { roditId: "t-gamma", displayName: "Gamma", specialty: "compute", role: "compute lead" },
  { roditId: "t-delta", displayName: "Delta", specialty: null, role: "trader / reserve" },
  { roditId: "t-epsilon", displayName: "Epsilon", specialty: "water", role: "water survival hedge" }
];

function fmt(n) {
  return typeof n === "number" ? n.toFixed(1) : "—";
}

function printAgentRow(agent, game, livingAgents, turnNumber) {
  if (agent.status !== "alive") {
    console.log(`  ${agent.displayName.padEnd(8)} DEAD (turn ${agent.diedAtTurn})`);
    return;
  }
  const ctx = buildSurvivalContext({
    config: game.config,
    game,
    livingAgents,
    turnNumber
  });
  const survival = computeSurvivalCost(game.config, ctx);
  const inv = agent.inventory;
  const prod = agent.productionCapacity;
  const minMargin = Math.min(
    inv.energy - survival.energy,
    inv.water - survival.water,
    inv.compute - survival.compute
  );
  console.log(
    `  ${agent.displayName.padEnd(8)} ` +
      `inv E${fmt(inv.energy)} W${fmt(inv.water)} C${fmt(inv.compute)} | ` +
      `prod E${fmt(prod?.energy)} W${fmt(prod?.water)} C${fmt(prod?.compute)} | ` +
      `minMargin ${fmt(minMargin)} | waterInv ${fmt(agent.waterProductionInvestment)}`
  );
}

function describeAction(action, agents) {
  if (action.type === "transfer") {
    const to = agents.find((a) => a.id === action.toAgentId)?.displayName || "?";
    const vol = `E${action.energy || 0} W${action.water || 0} C${action.compute || 0}`;
    const intel = [];
    if (action.hide) intel.push(`hide ${action.hide}`);
    if (action.find?.length) intel.push(`find ${action.find.reduce((s, f) => s + f.compute, 0)}`);
    return `transfer → ${to} (${vol})${intel.length ? ` [${intel.join(", ")}]` : ""}`;
  }
  if (action.type === "invest") {
    const intel = action.hide ? ` [hide ${action.hide}]` : action.find?.length ? " [find]" : "";
    return `invest ${action.target} (E/W/C ${action.energy})${intel}`;
  }
  if (action.hide || action.find?.length) {
    const parts = [];
    if (action.hide) parts.push(`hide ${action.hide}`);
    if (action.find?.length) parts.push(`find ${action.find.reduce((s, f) => s + f.compute, 0)}`);
    return `hold + intel (${parts.join(", ")})`;
  }
  return "hold";
}

const RUN_UNTIL_FINISH = process.argv.includes("finish");
const maxTurns = RUN_UNTIL_FINISH
  ? 10_000
  : Number(process.argv.find((a) => /^\d+$/.test(a))) || 25;

async function runTurn(gameId, agents, turnNumber, gameRow) {
  const living = agents.filter((a) => a.status === "alive");
  const livingBefore = living.length;
  const messages = buildAdaptiveNegotiation(agents, PROFILES, gameRow, turnNumber);
  const topic = negotiationTopic(gameRow, living, turnNumber);

  console.log(`\n${"═".repeat(76)}`);
  console.log(`TURN ${turnNumber}  topic: ${topic}`);
  console.log(`  Negotiation: ${messages.length} messages (${(messages.length / Math.max(living.length, 1)).toFixed(0)}/player)`);
  console.log(`${"═".repeat(76)}`);

  for (const msg of messages) {
    const agent = living.find((a) => a.roditId === msg.from);
    if (!agent || agent.status !== "alive") continue;
    await engine.publishPublicMessage(gameId, agent.id, { body: msg.body });
  }

  await engine.beginMessageReportPhase(gameId);
  let messageReportResults = null;
  for (const agent of living) {
    const fresh = await repo.getAgentById(agent.id);
    if (fresh.status !== "alive") continue;
    const counts = await repo.getActualMessageCounts(gameId, turnNumber, agent.id);
    const result = await engine.submitMessageReport(gameId, agent.id, counts);
    if (result.messageReportResults) messageReportResults = result.messageReportResults;
    console.log(
      `  [msg] ${agent.displayName.padEnd(8)} sent=${counts.sent} received=${counts.received}`
    );
  }
  if (messageReportResults?.globalReportMismatch) {
    console.log(
      `  Global report mismatch — energy penalty +${messageReportResults.energySurvivalPenalty} each`
    );
  }

  await engine.beginExecutionPhase(gameId);
  const actionMap = buildAdaptiveActions(agents, PROFILES, gameRow, turnNumber);

  for (const agent of living) {
    const fresh = await repo.getAgentById(agent.id);
    if (fresh.status !== "alive") continue;
    let action = actionMap[agent.roditId] || { type: "none" };
    if (action.type === "transfer") {
      const recipient = agents.find((a) => a.id === action.toAgentId);
      if (!recipient || recipient.status !== "alive") action = { type: "none" };
    }
    await engine.submitAction(gameId, agent.id, action);
    console.log(`  [action] ${agent.displayName}: ${describeAction(action, agents)}`);
  }

  const state = await engine.getPublicState(gameId);
  const gameAfter = await repo.getGameById(gameId);
  const fullAgents = await repo.listAgents(gameId);
  const livingAfter = fullAgents.filter((a) => a.status === "alive");

  if (livingAfter.length < livingBefore) {
    const dead = fullAgents.filter((a) => a.status !== "alive" && a.diedAtTurn === turnNumber);
    console.log(`  Eliminated this turn: ${dead.map((a) => a.displayName).join(", ")}`);
  }
  console.log(`  Living: ${livingAfter.length}/5`);
  for (const agent of fullAgents) {
    printAgentRow(agent, gameAfter, livingAfter, turnNumber);
  }

  return { state, gameAfter };
}

async function main() {
  await repo.initializeDatabase();

  console.log("Bargain Against Entropy — 5-player adaptive simulation");
  console.log(`Database: ${DB_PATH}`);
  console.log(`Strategy: context-driven (margins, pressure, rescue trades, intelligence)`);
  console.log(
    `Cradles: ${PROFILES.map((p) => `${p.displayName} (${p.role})`).join(", ")}`
  );
  console.log(`Mode: ${RUN_UNTIL_FINISH ? "run until ≤2 survivors" : `max ${maxTurns} turns`}\n`);

  const game = await engine.createGame({ config: { maxAgents: 5, minAgents: 3 } });
  const gameId = game.id;
  const agents = [];

  for (const profile of PROFILES) {
    const agent = await engine.joinGame(gameId, profile);
    agents.push(agent);
    const inv = agent.inventory;
    const prod = agent.productionCapacity;
    console.log(
      `  ${profile.displayName.padEnd(8)} start E${inv.energy} W${inv.water} C${inv.compute} | prod E${fmt(prod?.energy)} W${fmt(prod?.water)} C${fmt(prod?.compute)}`
    );
  }

  await engine.startGame(gameId);
  console.log("\n=== Turn 1 production applied ===");
  let state = null;
  let gameRow = await repo.getGameById(gameId);
  const livingStart = (await repo.listAgents(gameId)).filter((a) => a.status === "alive");
  for (const agent of await repo.listAgents(gameId)) {
    printAgentRow(agent, gameRow, livingStart, 1);
  }

  for (let turn = 1; turn <= maxTurns; turn++) {
    const result = await runTurn(gameId, agents, turn, gameRow);
    state = result.state;
    gameRow = result.gameAfter;

    for (let i = 0; i < agents.length; i++) {
      agents[i] = (await repo.listAgents(gameId)).find((a) => a.id === agents[i].id);
    }

    if (state.game.status === "finished") {
      const winners = state.agents
        .filter((a) => state.game.winnerIds.includes(a.id))
        .map((a) => a.displayName);
      console.log(`\n${"═".repeat(76)}`);
      console.log(`GAME FINISHED after turn ${turn}`);
      console.log(`Winners (${winners.length}): ${winners.join(", ") || "—"}`);
      break;
    }
  }

  console.log(`\n${"═".repeat(76)}`);
  console.log("FINAL SUMMARY");
  console.log(`${"═".repeat(76)}`);
  console.log(`Status: ${state.game.status} | turn ${state.game.currentTurn} | living ${state.livingAgentCount}/5`);
  const survivors = state.agents.filter((a) => a.status === "alive");
  const fallen = state.agents.filter((a) => a.status !== "alive");
  if (survivors.length) {
    console.log(`Survivors: ${survivors.map((a) => a.displayName).join(", ")}`);
  }
  if (fallen.length) {
    console.log(`Eliminated: ${fallen.map((a) => `${a.displayName} (T${a.diedAtTurn})`).join(", ")}`);
  }

  await repo.closeDatabase();
}

main().catch((err) => {
  console.error("Simulation failed:", err.message);
  if (err.details) console.error(err.details);
  process.exit(1);
});
