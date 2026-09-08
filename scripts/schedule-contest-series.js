#!/usr/bin/env node
/**
 * Create a practice + definitive contest series (operator launch helper).
 *
 * Uses the engine/orchestrator against the configured SQLite DB — same path the
 * API process uses when API_DEFAULT_OPTIONS_DB_PATH / NODE_CONFIG_ENV match.
 *
 * Examples:
 *   PRACTICE_STARTS_AT=2026-09-10T12:00:00.000Z node scripts/schedule-contest-series.js
 *   PRACTICE_STARTS_AT=2026-09-10T12:00:00.000Z DEFINITIVE_STARTS_AT=2026-09-17T12:00:00.000Z \\
 *     PRIZE_AMOUNT_YOCTO=500000000000000000000000000 node scripts/schedule-contest-series.js
 *
 * Dry-run (no DB write):
 *   DRY_RUN=1 PRACTICE_STARTS_AT=2026-09-10T12:00:00.000Z node scripts/schedule-contest-series.js
 */

const path = require("path");

process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
process.env.NODE_CONFIG_DIR = process.env.NODE_CONFIG_DIR || path.join(__dirname, "..", "config");

const PRACTICE_STARTS_AT = process.env.PRACTICE_STARTS_AT || null;
const DEFINITIVE_STARTS_AT = process.env.DEFINITIVE_STARTS_AT || null;
const PRACTICE_WINDOW_MS = Number(process.env.PRACTICE_WINDOW_MS) || 7 * 24 * 60 * 60 * 1000;
const PRIZE_AMOUNT_YOCTO = process.env.PRIZE_AMOUNT_YOCTO || null;
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

async function main() {
  if (!PRACTICE_STARTS_AT) {
    console.error(
      "PRACTICE_STARTS_AT is required (ISO timestamp), e.g. 2026-09-10T12:00:00.000Z"
    );
    process.exit(1);
  }

  const practiceStart = new Date(PRACTICE_STARTS_AT);
  if (Number.isNaN(practiceStart.getTime())) {
    console.error("PRACTICE_STARTS_AT must be a valid ISO timestamp");
    process.exit(1);
  }

  const definitiveStart = DEFINITIVE_STARTS_AT
    ? new Date(DEFINITIVE_STARTS_AT)
    : new Date(practiceStart.getTime() + PRACTICE_WINDOW_MS);
  if (Number.isNaN(definitiveStart.getTime())) {
    console.error("DEFINITIVE_STARTS_AT must be a valid ISO timestamp");
    process.exit(1);
  }

  const plan = {
    practiceStartsAt: practiceStart.toISOString(),
    practiceWindowMs: PRACTICE_WINDOW_MS,
    definitiveJoiningStartsAt: definitiveStart.toISOString(),
    prizeAmountYoctoNear: PRIZE_AMOUNT_YOCTO,
    dryRun: DRY_RUN
  };
  console.log("Contest series plan:", JSON.stringify(plan, null, 2));

  if (DRY_RUN) {
    console.log("DRY_RUN set — not writing to the database.");
    return;
  }

  const repo = require("../src/game/repository");
  const orchestrator = require("../src/game/contest-orchestrator");
  await repo.initializeDatabase();

  const result = await orchestrator.createContestSeries({
    practiceStartsAt: plan.practiceStartsAt,
    practiceWindowMs: plan.practiceWindowMs,
    definitiveJoiningStartsAt: plan.definitiveJoiningStartsAt,
    prizeAmountYoctoNear: plan.prizeAmountYoctoNear
  });

  console.log(
    JSON.stringify(
      {
        contestId: result.contest.id,
        status: result.contest.status,
        practiceGameId: result.practiceGame.id,
        definitiveGameId: result.definitiveGame.id,
        practiceWindowStartsAt: result.contest.practiceWindowStartsAt,
        practiceWindowEndsAt: result.contest.practiceWindowEndsAt,
        definitiveJoiningStartsAt: result.contest.definitiveJoiningStartsAt,
        prizeStatus: result.contest.prizeStatus
      },
      null,
      2
    )
  );

  await repo.closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
