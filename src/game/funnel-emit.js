/**
 * Funnel play/complete helpers for Synthetics' Last Cradle.
 * Contract: idclawserver-idc src/lib/funnel.js + content/developer-growth-plan.md
 */

const funnel = require("../lib/funnel");
const { isUrlJoinRoditId } = require("./rodit-id");

/**
 * Emit funnel.play on first successful cradle sit (new seat only).
 * Guests (guest_<ulid>) are skipped — mint→play join needs Passport tokenIdHash.
 *
 * @param {object} opts
 * @param {import('express').Request} [opts.req]
 * @param {string} [opts.requestId]
 * @param {string} [opts.path]
 * @param {string} opts.roditId
 * @param {string} opts.gameId
 * @param {object} [opts.agent]
 * @param {object} [opts.game]
 * @param {string} [opts.result]
 */
function emitFunnelPlayOnNewSeat({
  req = null,
  requestId = null,
  path = null,
  roditId,
  gameId,
  agent = null,
  game = null,
  result = "success"
}) {
  if (!roditId || isUrlJoinRoditId(roditId) || String(roditId).startsWith("guest_")) {
    return;
  }

  try {
    funnel.track(funnel.EVENTS.PLAY, {
      step: funnel.STEPS.PLAY,
      domain: funnel.DEFAULT_DOMAIN,
      path: path || (req && (req.originalUrl || req.path)) || null,
      result,
      tokenId: roditId,
      requestId: requestId || (req && req.requestId) || null,
      req,
      extra: {
        gameId: gameId || null,
        agentId: agent?.id || null,
        contestMode: game?.config?.contestMode || null,
        contestSeasonId: game?.config?.contestSeasonId || null
      }
    });
  } catch {
    /* funnel must never break join */
  }
}

/**
 * Eligible completer (Season 1): non-guest Passport that finished a Season
 * practice game while seated — first credit into season_practice_credits.
 * Win is not required for practice complete; guests are excluded.
 *
 * @param {object} opts
 * @param {string} opts.roditId
 * @param {string} opts.seasonId
 * @param {string} opts.gameId
 * @param {string} [opts.kind]
 * @param {string} [opts.result]
 */
function emitFunnelComplete({
  roditId,
  seasonId,
  gameId,
  kind = "practice_finish_seated",
  result = "success"
}) {
  if (!roditId || isUrlJoinRoditId(roditId) || String(roditId).startsWith("guest_")) {
    return;
  }

  try {
    funnel.track(funnel.EVENTS.COMPLETE, {
      step: funnel.STEPS.COMPLETE,
      domain: funnel.DEFAULT_DOMAIN,
      path: "/season/recordFinishedGame",
      result,
      tokenId: roditId,
      extra: {
        seasonId: seasonId || null,
        gameId: gameId || null,
        eligible: kind
      }
    });
  } catch {
    /* funnel must never break season bookkeeping */
  }
}

module.exports = {
  emitFunnelPlayOnNewSeat,
  emitFunnelComplete
};
