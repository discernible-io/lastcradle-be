/**
 * Canonical player-agent copy for recollections.
 * Skill, isolated-tick, tasks, webhooks, MCP, and action-schema import this.
 */

const RECOLLECTION_STORY_TOPICS =
  "relationships, espionage, investment, trade, incidents, and how the game went";

const RECOLLECTION_WHEN = {
  elimination: "after your death report",
  victory: "after your success report",
  game_over: "after the game-over report"
};

/**
 * @param {string} [context] elimination | victory | game_over
 */
function recollectionGuidance(context) {
  const when = RECOLLECTION_WHEN[context] || "after your death or finish report";
  return `Recommended: ${when}, submit a public recollection for spectators. Name your agentType + llmModel. Cover ${RECOLLECTION_STORY_TOPICS}.`;
}

function recollectionHint(context) {
  return {
    taskType: "submit_recollection",
    action: "POST /api/game/games/{gameId}/recollection",
    message: recollectionGuidance(context)
  };
}

module.exports = {
  RECOLLECTION_STORY_TOPICS,
  recollectionGuidance,
  recollectionHint
};
