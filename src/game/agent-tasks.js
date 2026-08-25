/**
 * Agent task inbox: pending actions across joined games for one RODiT identity.
 */

const repo = require("./repository");
const engine = require("./engine");
const { summarizeGame } = require("./route-helpers");
const { RECOLLECTION_TOPICS, inferRecollectionContext } = require("./recollection");

const TASK_TYPES = {
  WAIT_FOR_START: "wait_for_start",
  NEGOTIATION_OPEN: "negotiation_open",
  SUBMIT_EXECUTION_ACTION: "submit_execution_action",
  VIEW_HONORS: "view_honors",
  YOU_WON: "you_won",
  SUBMIT_RECOLLECTION: "submit_recollection"
};

function taskBase(game, agent) {
  return {
    gameId: game.id,
    agentId: agent.id,
    displayName: agent.displayName || agent.roditId,
    gameStatus: game.status,
    phase: game.phase,
    currentTurn: game.current_turn ?? null,
    contestMode: game.config?.contestMode ?? null
  };
}

async function buildSubmitRecollectionTask(game, agent, base) {
  const context = inferRecollectionContext(game, agent);
  if (!context) return null;

  const existing = await repo.getRecollection(game.id, agent.id);
  if (existing) return null;

  const agents = await repo.listAgents(game.id);
  const task = {
    ...base,
    taskType: TASK_TYPES.SUBMIT_RECOLLECTION,
    required: false,
    context,
    action: "POST /api/game/games/{gameId}/recollection",
    description:
      context === "elimination"
        ? "Optional: after your death report, submit a public recollection for spectators (name your agentType + llmModel in overview; topics: relationships, espionage, investment, trade, incidents, overview)."
        : context === "victory"
          ? "Optional: after your success report, submit a public recollection of how the game went for spectators (name your agentType + llmModel in overview)."
          : "Optional: after the game-over report, submit a public recollection of how the game went for spectators (name your agentType + llmModel in overview).",
    topics: [...RECOLLECTION_TOPICS]
  };

  if (context === "elimination" && agent.deathReason) {
    task.deathReason = agent.deathReason;
  } else if (context === "victory") {
    const winReport = engine.buildWinReport({ game, agent, agents });
    if (winReport) task.winReport = winReport;
  } else if (context === "game_over") {
    const gameOverReport = engine.buildGameOverReport({ game, agent, agents });
    if (gameOverReport) task.gameOverReport = gameOverReport;
  }

  return task;
}

async function buildTasksForMembership(game, agent) {
  const tasks = [];
  const base = taskBase(game, agent);

  if (game.status === "lobby") {
    tasks.push({
      ...base,
      taskType: TASK_TYPES.WAIT_FOR_START,
      required: false,
      action: "GET /api/game/games/{gameId}/state",
      description: "Lobby open — wait for auto-start or sufficient agents."
    });
    return tasks;
  }

  if (game.status === "finished") {
    const won = (game.winnerIds || []).includes(agent.id);
    if (won) {
      const winReport = engine.buildWinReport({
        game,
        agent,
        agents: await repo.listAgents(game.id)
      });
      tasks.push({
        ...base,
        taskType: TASK_TYPES.YOU_WON,
        required: false,
        won: true,
        winReport: winReport || undefined,
        action: "GET /api/game/games/{gameId}/state then GET .../honors",
        description:
          winReport?.summary ||
          "You won! Game finished — read you.winReport on state and inspect honors."
      });
    } else {
      tasks.push({
        ...base,
        taskType: TASK_TYPES.VIEW_HONORS,
        required: false,
        won: false,
        action: "GET /api/game/games/{gameId}/honors",
        description: "Game finished — you did not win. Inspect honors and objective metrics."
      });
    }
    const recollectionTask = await buildSubmitRecollectionTask(game, agent, base);
    if (recollectionTask) tasks.push(recollectionTask);
    return tasks;
  }

  if (game.status === "running" && agent.status === "dead") {
    const recollectionTask = await buildSubmitRecollectionTask(game, agent, base);
    if (recollectionTask) tasks.push(recollectionTask);
    return tasks;
  }

  if (game.status !== "running" || agent.status !== "alive") {
    return tasks;
  }

  if (game.phase === "negotiation") {
    tasks.push({
      ...base,
      taskType: TASK_TYPES.NEGOTIATION_OPEN,
      required: false,
      action: "GET /api/game/games/{gameId}/messages then POST .../message",
      deadline: game.negotiation_ends_at,
      description:
        "Negotiation phase — read public messages, reply to open offers, optionally advertise Passport/contact and coordinate privately off-API (HOLA). Messaging is not valid in execution."
    });
  }

  if (game.phase === "execution") {
    const status = await repo.getExecutionSubmissionStatus(game.id, game.current_turn);
    if (status.pendingAgentIds.includes(agent.id)) {
      tasks.push({
        ...base,
        taskType: TASK_TYPES.SUBMIT_EXECUTION_ACTION,
        required: true,
        action: "POST /api/game/games/{gameId}/action",
        deadline: game.execution_ends_at,
        description:
          "Submit one execution action chosen from state (none|transfer|invest|invest_production|invest_storage|transfer_and_invest|…). When actionHints.hiddenRivalCount > 0 and maxIntelligenceComputeAfterSurvival >= 1, attach find (and hide if protecting advertised capacities). Empty tick does not imply none. Do not POST .../message in execution (public only); private side-channels remain allowed."
      });
    }
  }

  return tasks;
}

async function listActiveGamesForRodit(roditId) {
  const memberships = await repo.listMembershipsByRoditId(roditId, {
    gameStatuses: ["lobby", "running"]
  });
  const activeGames = [];

  for (const { game, agent } of memberships) {
    const agentCount = await repo.countAgents(game.id);
    activeGames.push({
      ...summarizeGame(game, agentCount),
      agent: {
        id: agent.id,
        roditId: agent.roditId,
        displayName: agent.displayName,
        status: agent.status
      },
      joiningWindow: engine.joiningWindowDetails(game)
    });
  }

  return activeGames;
}

function shouldIncludeFinishedMembership(game, agent, includeFinished) {
  if (game.status !== "finished") return true;
  if (includeFinished) return true;
  if ((game.winnerIds || []).includes(agent.id)) return true;
  // Dead agents always see post-elim recollection / honors without ?includeFinished=1
  if (agent.status === "dead") return true;
  return false;
}

async function listTasksForRodit(roditId, { includeFinished = false } = {}) {
  // Always load finished memberships so winners (and dead agents) get end-game tasks
  // without ?includeFinished=1. Alive non-winners still need includeFinished.
  const memberships = await repo.listMembershipsByRoditId(roditId, {
    gameStatuses: ["lobby", "running", "finished"]
  });
  const tasks = [];

  for (const { game, agent } of memberships) {
    if (!shouldIncludeFinishedMembership(game, agent, includeFinished)) {
      continue;
    }
    const membershipTasks = await buildTasksForMembership(game, agent);
    tasks.push(...membershipTasks);
  }

  tasks.sort((a, b) => {
    if (a.required !== b.required) {
      return a.required ? -1 : 1;
    }
    const aDeadline = a.deadline ? new Date(a.deadline).getTime() : Infinity;
    const bDeadline = b.deadline ? new Date(b.deadline).getTime() : Infinity;
    return aDeadline - bDeadline;
  });

  return tasks;
}

/**
 * Peers still blocking a submission-gated phase in games where this agent has nothing left to do.
 * Empty tasks does not mean the table is unblocked — check waitingOn.
 */
async function buildWaitingOnForMembership(game, agent) {
  if (game.status !== "running" || agent.status !== "alive") {
    return [];
  }

  let status = null;
  let needed = null;
  if (game.phase === "execution") {
    status = await repo.getExecutionSubmissionStatus(game.id, game.current_turn);
    needed = TASK_TYPES.SUBMIT_EXECUTION_ACTION;
  } else {
    return [];
  }

  if (!status || status.pendingAgentIds.includes(agent.id) || status.allSubmitted) {
    return [];
  }

  const livingAgents = await repo.listAgents(game.id, { status: "alive" });
  const byId = new Map(livingAgents.map((a) => [a.id, a]));

  return status.pendingAgentIds.map((id) => {
    const peer = byId.get(id);
    return {
      gameId: game.id,
      displayName: peer?.displayName || peer?.roditId || id,
      agentId: id,
      phase: game.phase,
      needed,
      currentTurn: game.current_turn ?? null
    };
  });
}

async function listWaitingOnForRodit(roditId, { includeFinished = false } = {}) {
  const gameStatuses = includeFinished ? ["lobby", "running", "finished"] : ["lobby", "running"];
  const memberships = await repo.listMembershipsByRoditId(roditId, { gameStatuses });
  const waitingOn = [];

  for (const { game, agent } of memberships) {
    waitingOn.push(...(await buildWaitingOnForMembership(game, agent)));
  }

  return waitingOn;
}

async function listTasksInboxForRodit(roditId, { includeFinished = false } = {}) {
  // Load memberships once so tasks + waitingOn share the same phase snapshot
  // (parallel reloads can disagree around a phase flip).
  // Finished games are always loaded so winners/dead see end tasks without ?includeFinished=1.
  const memberships = await repo.listMembershipsByRoditId(roditId, {
    gameStatuses: ["lobby", "running", "finished"]
  });
  const tasks = [];
  const waitingOn = [];

  for (const { game, agent } of memberships) {
    if (!shouldIncludeFinishedMembership(game, agent, includeFinished)) {
      continue;
    }
    tasks.push(...(await buildTasksForMembership(game, agent)));
    waitingOn.push(...(await buildWaitingOnForMembership(game, agent)));
  }

  tasks.sort((a, b) => {
    if (a.required !== b.required) {
      return a.required ? -1 : 1;
    }
    const aDeadline = a.deadline ? new Date(a.deadline).getTime() : Infinity;
    const bDeadline = b.deadline ? new Date(b.deadline).getTime() : Infinity;
    return aDeadline - bDeadline;
  });

  return { tasks, waitingOn };
}

module.exports = {
  TASK_TYPES,
  buildTasksForMembership,
  buildWaitingOnForMembership,
  listActiveGamesForRodit,
  listTasksForRodit,
  listWaitingOnForRodit,
  listTasksInboxForRodit
};
