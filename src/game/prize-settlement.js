/**
 * Records definitive contest prize outcomes for operator / NEAR settlement.
 */

const { RoditClient } = require("@rodit/rodit-auth-be");
const repo = require("./repository");

const sdkClient = new RoditClient();
const logger = sdkClient.getLogger();

async function settleContestPrize(contestId, game) {
  const contest = await repo.getContestById(contestId);
  if (!contest) {
    return { settled: false, reason: "contest_not_found" };
  }
  if (contest.prize_status === "settled" || contest.prize_status === "recorded") {
    return { settled: true, reason: "already_settled", contest };
  }

  const winnerAgentId = game.winnerIds?.[0] ?? null;
  if (!winnerAgentId) {
    await repo.updateContest(contestId, {
      prize_status: "no_winner",
      updated_at: new Date().toISOString()
    });
    return { settled: false, reason: "no_winner" };
  }

  const winner = await repo.getAgentById(winnerAgentId);
  const winnerRoditId = winner?.roditId ?? null;
  const fields = {
    prize_winner_agent_id: winnerAgentId,
    prize_winner_rodit_id: winnerRoditId,
    updated_at: new Date().toISOString()
  };

  if (!contest.prize_amount_yocto || !winnerRoditId) {
    fields.prize_status = "pending_operator";
    await repo.updateContest(contestId, fields);
    logger.infoWithContext("Prize pending operator action", {
      component: "PrizeSettlement",
      contestId,
      winnerRoditId,
      amountYocto: contest.prize_amount_yocto || null
    });
    return { settled: false, reason: "pending_operator", winnerRoditId };
  }

  fields.prize_status = "recorded";
  fields.prize_settled_at = new Date().toISOString();
  fields.prize_tx_reference = `audit:${contestId}:${winnerAgentId}`;
  await repo.updateContest(contestId, fields);

  logger.infoWithContext("Definitive contest prize recorded for settlement", {
    component: "PrizeSettlement",
    contestId,
    gameId: game.id,
    winnerRoditId,
    winnerAgentId,
    amountYocto: contest.prize_amount_yocto,
    txReference: fields.prize_tx_reference
  });

  return {
    settled: true,
    reason: "recorded",
    winnerRoditId,
    winnerAgentId,
    amountYocto: contest.prize_amount_yocto,
    txReference: fields.prize_tx_reference
  };
}

module.exports = {
  settleContestPrize
};
