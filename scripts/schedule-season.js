#!/usr/bin/env node
/**
 * Create Season 1 windows (practice → qualifying → final) on the configured DB.
 *
 * Example (Season 1 — finale 24 Oct; T-7 go/no-go 17 Oct; no second postpone):
 *   DRY_RUN=1 \
 *   PRACTICE_STARTS_AT=2026-10-10T00:00:00.000Z \
 *   PRACTICE_ENDS_AT=2026-10-17T00:00:00.000Z \
 *   QUALIFYING_STARTS_AT=2026-10-17T00:00:00.000Z \
 *   QUALIFYING_ENDS_AT=2026-10-24T00:00:00.000Z \
 *   FINAL_JOINING_STARTS_AT=2026-10-24T12:00:00.000Z \
 *   node scripts/schedule-season.js
 *
 * Pass (weekly, on GET /api/game/seasons/:id → viability): ≥14 eligible non-sponsor
 * Passports with ≥1 game in prior 14 days AND ≥12 lobbies in practice window with ≥5 seats.
 * Fail at T-7 → cancel Season 1 and relaunch. Set SEASON_INELIGIBLE_RODIT_IDS for sponsors.
 */

const path = require("path");

process.env.NODE_CONFIG_ENV = process.env.NODE_CONFIG_ENV || "development";
process.env.NODE_CONFIG_DIR = process.env.NODE_CONFIG_DIR || path.join(__dirname, "..", "config");

const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

async function main() {
  const plan = {
    name: process.env.SEASON_NAME || "Season 1",
    practiceStartsAt: process.env.PRACTICE_STARTS_AT,
    practiceEndsAt: process.env.PRACTICE_ENDS_AT,
    qualifyingStartsAt: process.env.QUALIFYING_STARTS_AT,
    qualifyingEndsAt: process.env.QUALIFYING_ENDS_AT,
    finalJoiningStartsAt: process.env.FINAL_JOINING_STARTS_AT || process.env.QUALIFYING_ENDS_AT,
    prizeAmountYoctoNear: process.env.PRIZE_AMOUNT_YOCTO || null,
    dryRun: DRY_RUN
  };

  for (const key of ["practiceStartsAt", "practiceEndsAt", "qualifyingStartsAt", "qualifyingEndsAt"]) {
    if (!plan[key]) {
      console.error(`${key} / matching env var is required`);
      process.exit(1);
    }
  }

  console.log("Season plan:", JSON.stringify(plan, null, 2));
  if (DRY_RUN) {
    console.log("DRY_RUN set — not writing to the database.");
    return;
  }

  const repo = require("../src/game/repository");
  const season = require("../src/game/season");
  await repo.initializeDatabase();
  const created = await season.createSeason(plan);
  console.log(JSON.stringify(created, null, 2));
  await repo.closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
