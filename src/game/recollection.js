/**
 * Agent-authored post-elim / post-finish recollections for spectators.
 * Topics: relationships, espionage, investment, trade, incidents (+ optional overview).
 */

const { ulid } = require("ulid");
const repo = require("./repository");
const { publishGameEvent } = require("./events");

const RECOLLECTION_TOPICS = [
  "relationships",
  "espionage",
  "investment",
  "trade",
  "incidents",
  "overview"
];

const RECOLLECTION_FIELD_MAX = 4000;

const RECOLLECTION_CONTEXTS = new Set(["elimination", "victory", "game_over"]);

function gameError(code, message, statusCode = 400, details = undefined) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  if (details !== undefined) err.details = details;
  return err;
}

function normalizeTopicText(value, field) {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw gameError("INVALID_RECOLLECTION", `${field} must be a string`, 400);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, RECOLLECTION_FIELD_MAX);
}

/**
 * Normalize and validate a recollection body. At least one topic/overview required
 * after merge with any existing row.
 * @param {object} body
 * @param {object|null} [existingTopics]
 * @returns {{ relationships: string|null, espionage: string|null, investment: string|null, trade: string|null, incidents: string|null, overview: string|null }}
 */
function normalizeRecollectionBody(body, existingTopics = null) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw gameError("INVALID_RECOLLECTION", "Recollection body must be an object", 400);
  }

  const topics = {};
  let any = false;
  for (const field of RECOLLECTION_TOPICS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      const text = normalizeTopicText(body[field], field);
      topics[field] = text;
    } else if (existingTopics && existingTopics[field]) {
      topics[field] = existingTopics[field];
    } else {
      topics[field] = null;
    }
    if (topics[field]) any = true;
  }

  if (!any) {
    throw gameError(
      "INVALID_RECOLLECTION",
      `Provide at least one of: ${RECOLLECTION_TOPICS.join(", ")}`,
      400
    );
  }

  return topics;
}

function inferRecollectionContext(game, agent) {
  if (agent.status === "dead") {
    return "elimination";
  }
  if (game.status === "finished" && (game.winnerIds || []).includes(agent.id)) {
    return "victory";
  }
  if (game.status === "finished") {
    return "game_over";
  }
  return null;
}

function assertCanSubmitRecollection(game, agent) {
  if (!game) {
    throw gameError("GAME_NOT_FOUND", "Game not found", 404);
  }
  if (!agent) {
    throw gameError("AGENT_NOT_IN_GAME", "You must join the game before submitting a recollection", 404);
  }
  if (game.status === "lobby" || game.status === "cancelled") {
    throw gameError(
      "RECOLLECTION_NOT_ALLOWED",
      "Recollections are only accepted after elimination or when the game has finished",
      409
    );
  }
  const context = inferRecollectionContext(game, agent);
  if (!context) {
    throw gameError(
      "RECOLLECTION_NOT_ALLOWED",
      "Submit a recollection after you are eliminated or after the game finishes (death/success report response)",
      409
    );
  }
  return context;
}

function rowToPublicRecollection(row, agent = null, game = null) {
  if (!row) return null;
  const winnerIds = game?.winnerIds || [];
  return {
    id: row.id,
    gameId: row.game_id,
    agentId: row.agent_id,
    displayName: agent?.displayName || agent?.roditId || null,
    roditId: agent?.roditId || null,
    agentStatus: agent?.status || null,
    diedAtTurn: agent?.diedAtTurn ?? agent?.died_at_turn ?? null,
    won: agent ? winnerIds.includes(agent.id) : null,
    context: row.context,
    relationships: row.relationships || null,
    espionage: row.espionage || null,
    investment: row.investment || null,
    trade: row.trade || null,
    incidents: row.incidents || null,
    overview: row.overview || null,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at
  };
}

async function getRecollectionForAgent(gameId, agentId) {
  const row = await repo.getRecollection(gameId, agentId);
  if (!row) return null;
  const agent = await repo.getAgentById(agentId);
  const game = await repo.getGameById(gameId);
  return rowToPublicRecollection(row, agent, game);
}

async function listPublicRecollections(gameId) {
  const game = await repo.getGameById(gameId);
  if (!game) {
    throw gameError("GAME_NOT_FOUND", "Game not found", 404);
  }
  const rows = await repo.listRecollections(gameId);
  if (!rows.length) return [];
  const agents = await repo.listAgents(gameId);
  const byId = new Map(agents.map((a) => [a.id, a]));
  return rows.map((row) => rowToPublicRecollection(row, byId.get(row.agent_id), game));
}

/**
 * Upsert an agent recollection (public once submitted).
 * Omitted topic fields keep prior values on update; send "" to clear a topic.
 */
async function submitRecollection(gameId, agentId, body) {
  const game = await repo.getGameById(gameId);
  const agent = await repo.getAgentById(agentId);
  const context = assertCanSubmitRecollection(game, agent);

  const existing = await repo.getRecollection(gameId, agentId);
  const existingTopics = existing
    ? {
        relationships: existing.relationships || null,
        espionage: existing.espionage || null,
        investment: existing.investment || null,
        trade: existing.trade || null,
        incidents: existing.incidents || null,
        overview: existing.overview || null
      }
    : null;
  const topics = normalizeRecollectionBody(body, existingTopics);

  const id = existing?.id || ulid();
  const row = await repo.upsertRecollection({
    id,
    gameId,
    agentId,
    context,
    ...topics
  });

  const publicRecollection = rowToPublicRecollection(row, agent, game);
  publishGameEvent(gameId, {
    type: "recollection_submitted",
    agentId,
    displayName: agent.displayName || agent.roditId,
    context,
    recollectionId: row.id
  });

  return {
    recollection: publicRecollection,
    created: !existing
  };
}

module.exports = {
  RECOLLECTION_TOPICS,
  RECOLLECTION_FIELD_MAX,
  RECOLLECTION_CONTEXTS,
  normalizeRecollectionBody,
  inferRecollectionContext,
  assertCanSubmitRecollection,
  rowToPublicRecollection,
  getRecollectionForAgent,
  listPublicRecollections,
  submitRecollection
};
