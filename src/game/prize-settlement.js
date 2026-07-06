/**
 * Records definitive contest prize outcomes for operator / NEAR settlement.
 * Prize is split equally among `winnerIds`:
 * - Natural finish (≤ finishSurvivorCount alive): survivors listed in winnerIds
 * - Turn/duration cap: all living agents at the cap are listed in winnerIds
 */

const { RoditClient } = require("@rodit/rodit-auth-be");
const repo = require("./repository");

const sdkClient = new RoditClient();
const logger = sdkClient.getLogger();

function splitPrizeAmountYocto(totalYocto, winnerCount) {
  if (!totalYocto || winnerCount <= 0) {
    return null;
  }
  const total = BigInt(totalYocto);
  const share = total / BigInt(winnerCount);
  return share.toString();
}

async function settleContestPrize(contestId, game) {
  const contest = await repo.getContestById(contestId);
  if (!contest) {
    return { settled: false, reason: "contest_not_found" };
  }
  if (contest.prize_status === "settled" || contest.prize_status === "recorded") {
    return { settled: true, reason: "already_settled", contest };
  }

  const winnerIds = game.winnerIds || [];
  if (winnerIds.length === 0) {
    await repo.updateContest(contestId, {
      prizeStatus: "no_winner",
      updatedAt: new Date().toISOString()
    });
    return { settled: false, reason: "no_winner" };
  }

  const winners = [];
  for (const agentId of winnerIds) {
    const agent = await repo.getAgentById(agentId);
    winners.push({
      agentId,
      roditId: agent?.roditId ?? null,
      displayName: agent?.displayName ?? null
    });
  }

  const shareYocto = splitPrizeAmountYocto(contest.prizeAmountYocto, winners.length);
  const fields = {
    prizeWinnerIdsJson: JSON.stringify(winners),
    prizeWinnerAgentId: winners[0]?.agentId ?? null,
    prizeWinnerRoditId: winners[0]?.roditId ?? null,
    updatedAt: new Date().toISOString()
  };

  const allHaveRoditId = winners.every((w) => w.roditId);
  if (!contest.prizeAmountYocto || !allHaveRoditId) {
    fields.prizeStatus = "pending_operator";
    await repo.updateContest(contestId, fields);
    logger.infoWithContext("Prize pending operator action", {
      component: "PrizeSettlement",
      contestId,
      winners: winners.map((w) => w.roditId),
      amountYocto: contest.prizeAmountYocto || null,
      shareYocto
    });
    return { settled: false, reason: "pending_operator", winners, shareYocto };
  }

  fields.prizeStatus = "recorded";
  fields.prizeSettledAt = new Date().toISOString();
  fields.prizeTxReference = `audit:${contestId}:${winnerIds.join(",")}`;
  await repo.updateContest(contestId, fields);

  logger.infoWithContext("Definitive contest prize recorded for split settlement", {
    component: "PrizeSettlement",
    contestId,
    gameId: game.id,
    winners: winners.map((w) => ({ roditId: w.roditId, agentId: w.agentId })),
    amountYocto: contest.prizeAmountYocto,
    shareYocto,
    txReference: fields.prizeTxReference
  });

  return {
    settled: true,
    reason: "recorded",
    winners,
    amountYocto: contest.prizeAmountYocto,
    shareYocto,
    txReference: fields.prizeTxReference
  };
}

module.exports = {
  settleContestPrize,
  splitPrizeAmountYocto
};
