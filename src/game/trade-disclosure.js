/**
 * Optional trade rationale and curated private-deal snippets on transfer actions.
 */

const {
  TRADE_RATIONALE_MAX_LEN,
  TRADE_SNIPPET_MAX,
  TRADE_SNIPPET_EXCERPT_MAX,
  TRADE_SNIPPET_CHANNEL_MAX,
  TRADE_SNIPPET_TASK_TYPE_MAX,
  TRADE_SNIPPET_TOKEN_MAX
} = require("./input-limits");

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

/**
 * Legs for a transfer / transfer_and_invest payload (legacy single or `transfers[]`).
 * Returns shallow leg objects with toAgentId + resource amounts (+ optional disclosure).
 */
function transferLegsFromPayload(payload) {
  if (!payload || typeof payload !== "object") return [];

  if (
    payload.type === "transfer_and_invest" ||
    payload.type === "transfer_and_invest_production" ||
    payload.type === "transfer_and_invest_storage"
  ) {
    if (Array.isArray(payload.transfers) && payload.transfers.length) {
      return payload.transfers.filter((leg) => leg && leg.toAgentId);
    }
    if (payload.transfer) {
      if (Array.isArray(payload.transfer.transfers) && payload.transfer.transfers.length) {
        return payload.transfer.transfers.filter((leg) => leg && leg.toAgentId);
      }
      if (payload.transfer.toAgentId) {
        return [payload.transfer];
      }
    }
    return [];
  }

  if (payload.type === "transfer") {
    if (Array.isArray(payload.transfers) && payload.transfers.length) {
      return payload.transfers.filter((leg) => leg && leg.toAgentId);
    }
    if (payload.toAgentId) {
      return [payload];
    }
  }

  return [];
}

/** @deprecated Prefer transferLegsFromPayload — kept for single-leg callers. */
function transferPayloadFromAction(payload) {
  const legs = transferLegsFromPayload(payload);
  return legs[0] || null;
}

function publicTradeFromLeg(actionRow, payload, transfer, index, totalLegs) {
  const trade = {
    id: totalLegs === 1 ? actionRow.id : `${actionRow.id}:${index}`,
    turnNumber: actionRow.turn_number,
    fromAgentId: actionRow.agent_id,
    toAgentId: transfer.toAgentId,
    energy: transfer.energy || 0,
    water: transfer.water || 0,
    compute: transfer.compute || 0,
    status: actionRow.status,
    submittedAt: actionRow.submitted_at,
    executedAt: actionRow.executed_at || null
  };

  if (transfer.rationale) {
    trade.rationale = transfer.rationale;
  }
  if (transfer.privateDealSnippets?.length) {
    trade.privateDealSnippets = transfer.privateDealSnippets;
  }
  if (
    payload.type === "transfer_and_invest" ||
    payload.type === "transfer_and_invest_production" ||
    payload.type === "transfer_and_invest_storage"
  ) {
    trade.combinedWithInvest = true;
  }
  if (totalLegs > 1) {
    trade.transferIndex = index;
    trade.transferCount = totalLegs;
  }

  return trade;
}

function publicTradeFromAction(actionRow, parseJson) {
  const trades = publicTradesFromAction(actionRow, parseJson);
  return trades[0] || null;
}

function publicTradesFromAction(actionRow, parseJson) {
  const payload = parseJson(actionRow.payload_json, { type: "none" });
  const legs = transferLegsFromPayload(payload);
  if (!legs.length) {
    return [];
  }
  return legs.map((leg, index) => publicTradeFromLeg(actionRow, payload, leg, index, legs.length));
}

/**
 * After execution of turn T resolves, current_turn becomes T+1.
 * Inbound receipts for the just-resolved execution therefore live at currentTurn - 1
 * whenever currentTurn > 1 (negotiation or execution of the following turn).
 */
function lastResolvedTurnNumber(currentTurn) {
  const n = Number(currentTurn) || 0;
  return n > 1 ? n - 1 : null;
}

function inboundTradesForRecipient(trades, recipientAgentId) {
  if (!recipientAgentId || !Array.isArray(trades)) {
    return [];
  }
  return trades.filter((trade) => trade && trade.toAgentId === recipientAgentId);
}

/**
 * Durable receipt block for authenticated state / phase_change wakes.
 * @returns {{ turnNumber: number|null, transfers: object[] }}
 */
function transfersReceivedLastTurn(turnNumber, trades, recipientAgentId) {
  if (turnNumber == null || turnNumber <= 0) {
    return { turnNumber: null, transfers: [] };
  }
  return {
    turnNumber,
    transfers: inboundTradesForRecipient(trades, recipientAgentId)
  };
}

/**
 * Cumulative inbound receipt history through the last resolved execution.
 * @returns {{ throughTurn: number|null, transfers: object[] }}
 */
function transfersReceivedHistory(throughTurn, trades, recipientAgentId) {
  if (throughTurn == null || throughTurn <= 0) {
    return { throughTurn: null, transfers: [] };
  }
  return {
    throughTurn,
    transfers: inboundTradesForRecipient(trades, recipientAgentId)
  };
}

/** Attach display names from an agentId → displayName map (mutates trades in place). */
function enrichTradesWithDisplayNames(trades, displayNameByAgentId) {
  if (!Array.isArray(trades) || !displayNameByAgentId) {
    return trades;
  }
  for (const trade of trades) {
    if (!trade) continue;
    const fromName = displayNameByAgentId.get(trade.fromAgentId);
    const toName = displayNameByAgentId.get(trade.toAgentId);
    if (fromName) trade.fromDisplayName = fromName;
    if (toName) trade.toDisplayName = toName;
  }
  return trades;
}

module.exports = {
  TRADE_RATIONALE_MAX_LEN,
  TRADE_SNIPPET_MAX,
  TRADE_SNIPPET_EXCERPT_MAX,
  normalizeTransferDisclosure,
  transferLegsFromPayload,
  transferPayloadFromAction,
  publicTradeFromAction,
  publicTradesFromAction,
  lastResolvedTurnNumber,
  inboundTradesForRecipient,
  transfersReceivedLastTurn,
  transfersReceivedHistory,
  enrichTradesWithDisplayNames
};
