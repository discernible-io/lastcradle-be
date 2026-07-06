/**
 * Optional trade rationale and curated private-deal snippets on transfer actions.
 */

const TRADE_RATIONALE_MAX_LEN = 2000;
const TRADE_SNIPPET_MAX = 5;
const TRADE_SNIPPET_EXCERPT_MAX = 500;
const TRADE_SNIPPET_CHANNEL_MAX = 64;
const TRADE_SNIPPET_TASK_TYPE_MAX = 64;
const TRADE_SNIPPET_TOKEN_MAX = 128;

const ALLOWED_SNIPPET_TASK_TYPES = new Set([
  "TRADE_OFFER",
  "TRADE_COUNTER",
  "TRADE_ACCEPT",
  "ALLIANCE_PROPOSE"
]);

function gameError(code, message, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

function normalizeTransferDisclosure(action) {
  if (!action || action.type !== "transfer") {
    return action;
  }

  if (action.rationale != null) {
    if (typeof action.rationale !== "string") {
      throw gameError("INVALID_TRADE_RATIONALE", "rationale must be a string", 400);
    }
    const trimmed = action.rationale.trim();
    if (!trimmed) {
      delete action.rationale;
    } else {
      action.rationale = trimmed.slice(0, TRADE_RATIONALE_MAX_LEN);
    }
  }

  if (action.privateDealSnippets != null) {
    if (!Array.isArray(action.privateDealSnippets)) {
      throw gameError("INVALID_TRADE_SNIPPETS", "privateDealSnippets must be an array", 400);
    }

    const normalized = [];
    for (let index = 0; index < Math.min(action.privateDealSnippets.length, TRADE_SNIPPET_MAX); index++) {
      const raw = action.privateDealSnippets[index];
      if (!raw || typeof raw !== "object") {
        throw gameError("INVALID_TRADE_SNIPPETS", `privateDealSnippets[${index}] must be an object`, 400);
      }
      if (typeof raw.excerpt !== "string" || !raw.excerpt.trim()) {
        throw gameError(
          "INVALID_TRADE_SNIPPETS",
          `privateDealSnippets[${index}].excerpt is required`,
          400
        );
      }

      const snippet = {
        excerpt: raw.excerpt.trim().slice(0, TRADE_SNIPPET_EXCERPT_MAX)
      };

      if (raw.channel != null) {
        if (typeof raw.channel !== "string") {
          throw gameError("INVALID_TRADE_SNIPPETS", `privateDealSnippets[${index}].channel must be a string`, 400);
        }
        const channel = raw.channel.trim().slice(0, TRADE_SNIPPET_CHANNEL_MAX);
        if (channel) snippet.channel = channel;
      }

      if (raw.taskType != null) {
        if (typeof raw.taskType !== "string") {
          throw gameError("INVALID_TRADE_SNIPPETS", `privateDealSnippets[${index}].taskType must be a string`, 400);
        }
        const taskType = raw.taskType.trim().slice(0, TRADE_SNIPPET_TASK_TYPE_MAX);
        if (taskType && !ALLOWED_SNIPPET_TASK_TYPES.has(taskType)) {
          throw gameError(
            "INVALID_TRADE_SNIPPETS",
            `privateDealSnippets[${index}].taskType must be one of: ${[...ALLOWED_SNIPPET_TASK_TYPES].join(", ")}`,
            400
          );
        }
        if (taskType) snippet.taskType = taskType;
      }

      if (raw.peerTokenId != null) {
        if (typeof raw.peerTokenId !== "string") {
          throw gameError(
            "INVALID_TRADE_SNIPPETS",
            `privateDealSnippets[${index}].peerTokenId must be a string`,
            400
          );
        }
        const peerTokenId = raw.peerTokenId.trim().slice(0, TRADE_SNIPPET_TOKEN_MAX);
        if (peerTokenId) snippet.peerTokenId = peerTokenId;
      }

      if (raw.holaVerified != null) {
        if (typeof raw.holaVerified !== "boolean") {
          throw gameError(
            "INVALID_TRADE_SNIPPETS",
            `privateDealSnippets[${index}].holaVerified must be a boolean`,
            400
          );
        }
        snippet.holaVerified = raw.holaVerified;
      }

      normalized.push(snippet);
    }

    if (normalized.length) {
      action.privateDealSnippets = normalized;
    } else {
      delete action.privateDealSnippets;
    }
  }

  return action;
}

function publicTradeFromAction(actionRow, parseJson) {
  const payload = parseJson(actionRow.payload_json, { type: "none" });
  if (payload.type !== "transfer" || !payload.toAgentId) {
    return null;
  }

  const trade = {
    id: actionRow.id,
    turnNumber: actionRow.turn_number,
    fromAgentId: actionRow.agent_id,
    toAgentId: payload.toAgentId,
    energy: payload.energy || 0,
    water: payload.water || 0,
    compute: payload.compute || 0,
    status: actionRow.status,
    submittedAt: actionRow.submitted_at,
    executedAt: actionRow.executed_at || null
  };

  if (payload.rationale) {
    trade.rationale = payload.rationale;
  }
  if (payload.privateDealSnippets?.length) {
    trade.privateDealSnippets = payload.privateDealSnippets;
  }

  return trade;
}

module.exports = {
  TRADE_RATIONALE_MAX_LEN,
  TRADE_SNIPPET_MAX,
  TRADE_SNIPPET_EXCERPT_MAX,
  normalizeTransferDisclosure,
  publicTradeFromAction
};
