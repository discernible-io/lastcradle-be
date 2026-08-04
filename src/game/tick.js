/**
 * One-shot required-task submit (execution action).
 * Shared by MCP `slc_tick` and REST `POST /api/game/tick`.
 *
 * Conscious ticks require an explicit execution action body.
 * AFK phase timeout still submits `none` via the scheduler — not via empty tick.
 */

const engine = require("./engine");
const repo = require("./repository");
const scheduler = require("./scheduler");
const { onGamePhaseUpdated } = require("./webhooks");
const { listTasksInboxForRodit, TASK_TYPES } = require("./agent-tasks");

const EXECUTION_ACTION_TYPES = new Set([
  "none",
  "transfer",
  "invest",
  "invest_production",
  "invest_storage",
  "transfer_and_invest",
  "transfer_and_invest_production",
  "transfer_and_invest_storage"
]);

function applyActionSideEffects(result) {
  if (result?.turnCompleted && result.game) {
    scheduler.onTurnCompleted(result.game);
  } else if (result?.game?.status === "running" && result.game.phase === "execution") {
    onGamePhaseUpdated(result.game.id).catch(() => {});
  }
}

/**
 * Resolve an explicit execution action from tick opts / request body.
 * @returns {object|null} action payload, or null when the caller sent no action
 */
function resolveTickAction(opts = {}) {
  if (opts.action && typeof opts.action === "object" && !Array.isArray(opts.action)) {
    const nested = opts.action;
    const type = nested.type || nested.actionType || opts.actionType || opts.type;
    if (type && EXECUTION_ACTION_TYPES.has(type)) {
      return { ...nested, type, action: type };
    }
  }

  const type = opts.type || opts.actionType;
  if (!type || !EXECUTION_ACTION_TYPES.has(type)) {
    return null;
  }

  const {
    actionType: _actionType,
    action: _action,
    type: _type,
    ...rest
  } = opts;
  return { ...rest, type, action: type };
}

/**
 * @param {string} roditId
 * @param {object} [opts] Tick body: explicit action fields (`type` / `actionType` / nested `action`)
 * @returns {Promise<object>}
 */
async function runAgentTick(roditId, opts = {}) {
  const inbox = await listTasksInboxForRodit(roditId);
  const required = (inbox.tasks || []).find((t) => t.required) || (inbox.tasks || [])[0];
  if (!required) {
    return {
      submitted: false,
      reason: "no_pending_task",
      tasks: inbox.tasks,
      waitingOn: inbox.waitingOn,
      note: "Empty tasks does not mean unblocked — check waitingOn."
    };
  }

  if (required.taskType === TASK_TYPES.SUBMIT_EXECUTION_ACTION) {
    const agent = await repo.getAgentByRoditId(required.gameId, roditId);
    if (!agent) {
      const err = new Error("You must join the game before submitting actions");
      err.code = "AGENT_NOT_IN_GAME";
      err.statusCode = 404;
      throw err;
    }

    const body = resolveTickAction(opts);
    if (!body) {
      return {
        submitted: false,
        reason: "action_required",
        taskType: required.taskType,
        gameId: required.gameId,
        tasks: inbox.tasks,
        waitingOn: inbox.waitingOn,
        note:
          "Conscious tick requires an explicit execution action (none|transfer|invest|invest_production|invest_storage|transfer_and_invest|…) from current state. AFK timeout submits none automatically; empty tick bodies do not."
      };
    }

    const result = await engine.submitAction(required.gameId, agent.id, body);
    applyActionSideEffects(result);
    const after = await listTasksInboxForRodit(roditId);
    return {
      submitted: true,
      taskType: required.taskType,
      gameId: required.gameId,
      payload: body,
      result,
      waitingOn: after.waitingOn
    };
  }

  return {
    submitted: false,
    reason: "unsupported_task",
    task: required,
    waitingOn: inbox.waitingOn
  };
}

module.exports = {
  runAgentTick,
  resolveTickAction
};
