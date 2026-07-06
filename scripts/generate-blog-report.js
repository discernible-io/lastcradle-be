#!/usr/bin/env node
/**
 * Run an N-player simulation and write a blog-style JSON report for the player frontend.
 * Usage: node scripts/generate-blog-report.js [players] [finish]
 */

const fs = require("fs");
const path = require("path");

const PLAYER_COUNT = Math.max(3, Number(process.argv.find((a) => /^\d+$/.test(a))) || 7);
const RUN_UNTIL_FINISH = process.argv.includes("finish");

const DB_PATH = path.join(__dirname, "..", "data", `blog-report-${PLAYER_COUNT}p.sqlite`);
const REPORT_PATH = path.join(__dirname, "..", "frontend", "data", "latest-report.json");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const { getGameNarrative } = require("../src/game/narrative");
const { buildTurnReport } = require("../src/game/turn-report");
const { buildHeavyTradeActions, tradesTargetFor } = require("./sim-trading");

const SPECIALTY_CYCLE = ["energy", "water", "compute", null];
const MSGS_PER_PLAYER = 3;

const PROFILES = Array.from({ length: PLAYER_COUNT }, (_, i) => {
  const specialty = SPECIALTY_CYCLE[i % SPECIALTY_CYCLE.length];
  return {
    roditId: `blog-p${i}`,
    displayName: `Cradle ${i + 1}`,
    specialty,
    role:
      specialty === "energy"
        ? "energy"
        : specialty === "water"
          ? "water"
          : specialty === "compute"
            ? "compute"
            : "reserve"
  };
});

const RODIT_IDS = PROFILES.map((p) => p.roditId);

function buildNegotiation(turnNumber, topic) {
  const kinds = ["Proposal", "Counter", "Accept"];
  const messages = [];
  for (const profile of PROFILES) {
    for (const kind of kinds) {
      messages.push({
        from: profile.roditId,
        body: `[Cycle ${turnNumber}] ${kind} (${topic}): ${profile.displayName} stakes its claim in the reproduction race.`
      });
    }
  }
  return messages;
}

function allActions(fn) {
  return Object.fromEntries(RODIT_IDS.map((id) => [id, fn(id)]));
}

async function runTurn(gameId, agents, turnNumber) {
  const living = agents.filter((a) => a.status === "alive");
  const messages = buildNegotiation(
    turnNumber,
    turnNumber <= 3 ? "bilateral trade pact" : "survival review"
  );

  for (const msg of messages) {
    const agent = living.find((a) => a.roditId === msg.from);
    if (!agent || agent.status !== "alive") continue;
    await engine.publishPublicMessage(gameId, agent.id, { body: msg.body });
  }

  await engine.beginMessageReportPhase(gameId);
  for (const agent of living) {
    const fresh = await repo.getAgentById(agent.id);
    if (fresh.status !== "alive") continue;
    const counts = await repo.getActualMessageCounts(gameId, turnNumber, agent.id);
    await engine.submitMessageReport(gameId, agent.id, counts);
  }

  await engine.beginExecutionPhase(gameId);

  const actionMap = buildHeavyTradeActions(agents, PROFILES, PLAYER_COUNT, turnNumber);

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
  const allAgents = await repo.listAgents(gameId);
  const publicMessages = await repo.listPublicMessages(gameId, turnNumber);
  const turnActions = await repo.listTurnActions(gameId, turnNumber);
  const gameRow = await repo.getGameById(gameId);

  return {
    state,
    agents: allAgents,
    turnReport: buildTurnReport({
      turnNumber,
      state,
      messages: publicMessages,
      actions: turnActions,
      agents: allAgents,
      gameConfig: gameRow.config || {}
    })
  };
}

async function main() {
  const maxTurns = RUN_UNTIL_FINISH ? 10_000 : 40;
  const lore = getGameNarrative();
  const turnPosts = [];

  await repo.initializeDatabase();

  const game = await engine.createGame({
    config: { maxAgents: PLAYER_COUNT, minAgents: 3 }
  });
  const gameId = game.id;

  const agents = [];
  for (const profile of PROFILES) {
    agents.push(await engine.joinGame(gameId, profile));
  }
  await engine.startGame(gameId);

  let finalState = await engine.getPublicState(gameId);
  let finishedTurn = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const { state, agents: allAgents, turnReport } = await runTurn(gameId, agents, turn);
    finalState = state;
    finishedTurn = turn;
    turnPosts.push(turnReport);

    for (let i = 0; i < agents.length; i++) {
      agents[i] = allAgents.find((a) => a.id === agents[i].id);
    }

    const eliminated = turnReport.stats.eliminated.length;
    console.log(
      `Cycle ${turn}: ${turnReport.stats.livingCount} living | ` +
        `${turnReport.stats.messageCount} messages | ` +
        `${turnReport.stats.transferCount} transfers` +
        (eliminated ? ` | ${eliminated} eliminated` : "")
    );

    if (state.game.status === "finished") {
      break;
    }
  }

  const allAgents = await repo.listAgents(gameId);
  const report = {
    generatedAt: new Date().toISOString(),
    game: {
      id: gameId,
      playerCount: PLAYER_COUNT,
      status: finalState.game.status,
      totalTurns: finishedTurn,
      tradeTargetPerTurn: tradesTargetFor(PLAYER_COUNT),
      winners: allAgents
        .filter((a) => (finalState.game.winnerIds || []).includes(a.id))
        .map((a) => ({ id: a.id, displayName: a.displayName, roditId: a.roditId }))
    },
    lore: {
      title: lore.title,
      premise: lore.premise,
      setting: lore.setting
    },
    roster: PROFILES.map((p) => ({
      roditId: p.roditId,
      displayName: p.displayName,
      role: p.role
    })),
    turns: turnPosts,
    summary: {
      survivors: allAgents
        .filter((a) => a.status === "alive")
        .map((a) => a.displayName),
      fallen: allAgents
        .filter((a) => a.status !== "alive")
        .map((a) => ({
          displayName: a.displayName,
          diedAtTurn: a.diedAtTurn
        }))
    }
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${REPORT_PATH}`);
  console.log(
    `Final: ${report.game.status} after ${finishedTurn} cycles | ` +
      `${report.summary.survivors.length} survivors`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
