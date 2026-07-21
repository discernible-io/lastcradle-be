/**
 * Agent task inbox: pending actions across joined games for one RODiT identity.
 */

const repo = require("./repository");
const engine = require("./engine");
const { summarizeGame } = require("./route-helpers");

const TASK_TYPES = {
  WAIT_FOR_START: "wait_for_start",
  NEGOTIATION_OPEN: "negotiation_open",
  SUBMIT_MESSAGE_REPORT: "submit_message_report",
  SUBMIT_EXECUTION_ACTION: "submit_execution_action",
  VIEW_HONORS: "view_honors"
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
    tasks.push({
      ...base,
      taskType: TASK_TYPES.VIEW_HONORS,
      required: false,
      action: "GET /api/game/games/{gameId}/honors",
      description: "Game finished — inspect honors and objective metrics."
    });
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
      action: "POST /api/game/games/{gameId}/message",
      deadline: game.negotiation_ends_at,
      description: "Negotiation phase — publish public messages; coordinate privately off-API."
    });
  }

  if (game.phase === "message_report") {
    const status = await repo.getMessageReportSubmissionStatus(game.id, game.current_turn);
    if (status.pendingAgentIds.includes(agent.id)) {
      tasks.push({
        ...base,
        taskType: TASK_TYPES.SUBMIT_MESSAGE_REPORT,
        required: true,
        action: "POST /api/game/games/{gameId}/message-report",
        deadline: game.message_report_ends_at,
        description: "Submit sent and received message counts for this turn."
      });
    }
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
        description: "Submit one execution action (transfer, invest, or none)."
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

async function listTasksForRodit(roditId, { includeFinished = false } = {}) {
  const gameStatuses = includeFinished ? ["lobby", "running", "finished"] : ["lobby", "running"];
  const memberships = await repo.listMembershipsByRoditId(roditId, { gameStatuses });
  const tasks = [];

  for (const { game, agent } of memberships) {
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
  if (game.phase === "message_report") {
    status = await repo.getMessageReportSubmissionStatus(game.id, game.current_turn);
    needed = TASK_TYPES.SUBMIT_MESSAGE_REPORT;
  } else if (game.phase === "execution") {
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
  const [tasks, waitingOn] = await Promise.all([
    listTasksForRodit(roditId, { includeFinished }),
    listWaitingOnForRodit(roditId, { includeFinished })
  ]);
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
