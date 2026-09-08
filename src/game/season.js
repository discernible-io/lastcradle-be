/**
 * Multi-phase contest seasons:
 * practice (at-will) → qualifying (practice prerequisite; winners eligible) → rostered final.
 */

const { ulid } = require("ulid");
const repo = require("./repository");
const {
  mergeGameConfig,
  QUALIFYING_GAME_CONFIG,
  CONTEST_GAME_CONFIG
} = require("./defaults");
const { canonicalRoditId } = require("./rodit-id");

function gameError(code, message, statusCode = 400, details = undefined) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  err.details = details;
  return err;
}

function isGuestRoditId(roditId) {
  return String(roditId || "").startsWith("guest_");
}

function parseIso(value, fieldName) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw gameError("INVALID_SEASON_TIMESTAMP", `${fieldName} must be a valid ISO timestamp`, 400);
  }
  return date;
}

function resolveSeasonPhase(season, now = new Date()) {
  if (!season) return null;
  const t = now.getTime();
  const practiceStart = new Date(season.practiceStartsAt).getTime();
  const practiceEnd = new Date(season.practiceEndsAt).getTime();
  const qualifyingStart = new Date(season.qualifyingStartsAt).getTime();
  const qualifyingEnd = new Date(season.qualifyingEndsAt).getTime();

  if (t < practiceStart) return "scheduled";
  if (t < practiceEnd) return "practice";
  if (t < qualifyingStart) return "between";
  if (t < qualifyingEnd) return "qualifying";
  if (!season.finalGameId) return "roster";
  return "final";
}

function publicSeason(season, { phase = null, extras = {} } = {}) {
  if (!season) return null;
  const resolvedPhase = phase ?? resolveSeasonPhase(season);
  return {
    id: season.id,
    name: season.name,
    status: season.status,
    phase: resolvedPhase,
    practiceStartsAt: season.practiceStartsAt,
    practiceEndsAt: season.practiceEndsAt,
    qualifyingStartsAt: season.qualifyingStartsAt,
    qualifyingEndsAt: season.qualifyingEndsAt,
    finalJoiningStartsAt: season.finalJoiningStartsAt,
    finalGameId: season.finalGameId,
    finalRoster: season.finalRoster || [],
    prizeAmountYocto: season.prizeAmountYocto,
    prizeStatus: season.prizeStatus,
    createdAt: season.createdAt,
    updatedAt: season.updatedAt,
    ...extras
  };
}

async function createSeason({
  name = null,
  practiceStartsAt,
  practiceEndsAt,
  qualifyingStartsAt,
  qualifyingEndsAt,
  finalJoiningStartsAt = null,
  prizeAmountYoctoNear = null
} = {}) {
  if (!practiceStartsAt || !practiceEndsAt || !qualifyingStartsAt || !qualifyingEndsAt) {
    throw gameError(
      "SEASON_WINDOWS_REQUIRED",
      "practiceStartsAt, practiceEndsAt, qualifyingStartsAt, and qualifyingEndsAt are required",
      400
    );
  }

  const practiceStart = parseIso(practiceStartsAt, "practiceStartsAt");
  const practiceEnd = parseIso(practiceEndsAt, "practiceEndsAt");
  const qualifyingStart = parseIso(qualifyingStartsAt, "qualifyingStartsAt");
  const qualifyingEnd = parseIso(qualifyingEndsAt, "qualifyingEndsAt");
  const finalStart = finalJoiningStartsAt
    ? parseIso(finalJoiningStartsAt, "finalJoiningStartsAt")
    : qualifyingEnd;

  if (!(practiceStart < practiceEnd)) {
    throw gameError("INVALID_SEASON_WINDOWS", "practiceEndsAt must be after practiceStartsAt", 400);
  }
  if (!(qualifyingStart < qualifyingEnd)) {
    throw gameError(
      "INVALID_SEASON_WINDOWS",
      "qualifyingEndsAt must be after qualifyingStartsAt",
      400
    );
  }
  if (practiceEnd.getTime() > qualifyingStart.getTime()) {
    throw gameError(
      "INVALID_SEASON_WINDOWS",
      "practiceEndsAt must be at or before qualifyingStartsAt",
      400
    );
  }

  const season = await repo.createSeason({
    id: ulid(),
    name: name || "Season",
    status: "scheduled",
    practiceStartsAt: practiceStart.toISOString(),
    practiceEndsAt: practiceEnd.toISOString(),
    qualifyingStartsAt: qualifyingStart.toISOString(),
    qualifyingEndsAt: qualifyingEnd.toISOString(),
    finalJoiningStartsAt: finalStart.toISOString(),
    prizeAmountYocto: prizeAmountYoctoNear,
    prizeStatus: prizeAmountYoctoNear ? "pending" : null
  });

  return publicSeason(season);
}

/**
 * Tag / constrain lobby creation for the active season phase.
 */
async function applySeasonCreatePolicy(configOverrides = {}) {
  const season = await repo.getCurrentSeason();
  if (!season) {
    return configOverrides;
  }

  const phase = resolveSeasonPhase(season);
  const mode = configOverrides.contestMode || null;

  if (mode === "definitive" && configOverrides.contestSeasonId && configOverrides.contestSeasonId !== season.id) {
    throw gameError("SEASON_MISMATCH", "contestSeasonId does not match the current season", 400);
  }

  if (phase === "practice") {
    if (mode === "qualifying" || mode === "definitive") {
      throw gameError(
        "SEASON_PHASE_MISMATCH",
        "Qualifying and final lobbies cannot be created during the practice window",
        409,
        { phase }
      );
    }
    // At-will practice: casual timing, tagged to the season.
    return mergeGameConfig({
      ...configOverrides,
      contestMode: "practice",
      contestSeasonId: season.id
    });
  }

  if (phase === "between") {
    throw gameError(
      "SEASON_BETWEEN_PHASES",
      "Practice has ended; qualifying has not started yet",
      409,
      { phase, qualifyingStartsAt: season.qualifyingStartsAt }
    );
  }

  if (phase === "qualifying") {
    if (mode === "definitive") {
      throw gameError(
        "SEASON_PHASE_MISMATCH",
        "Final lobby cannot be created during the qualifying window — use POST /api/game/seasons/{id}/final after setting the roster",
        409,
        { phase }
      );
    }
    if (mode && mode !== "qualifying" && mode !== "practice") {
      throw gameError(
        "SEASON_QUALIFYING_ONLY",
        "During qualifying week, create lobbies with preset qualifying (or contestMode qualifying)",
        409,
        { phase }
      );
    }
    // Force qualifying tag even if client sent practice by habit.
    return mergeGameConfig({
      ...QUALIFYING_GAME_CONFIG,
      ...configOverrides,
      contestMode: "qualifying",
      contestSeasonId: season.id
    });
  }

  if (phase === "roster" || phase === "final") {
    if (mode !== "definitive") {
      throw gameError(
        "SEASON_FINAL_PHASE",
        "Practice and qualifying lobbies are closed; wait for the operator final or use POST /api/game/seasons/{id}/final",
        409,
        { phase }
      );
    }
    return mergeGameConfig({
      ...CONTEST_GAME_CONFIG,
      ...configOverrides,
      contestMode: "definitive",
      contestSeasonId: season.id
    });
  }

  // scheduled — before practice opens
  if (mode === "qualifying" || mode === "definitive") {
    throw gameError(
      "SEASON_NOT_OPEN",
      "Season practice has not started yet",
      409,
      { phase, practiceStartsAt: season.practiceStartsAt }
    );
  }

  return configOverrides;
}

async function assertSeasonJoinAllowed(game, roditId) {
  const seasonId = game?.config?.contestSeasonId;
  const mode = game?.config?.contestMode || null;
  if (!seasonId || !mode) {
    return;
  }

  const season = await repo.getSeasonById(seasonId);
  if (!season) {
    throw gameError("SEASON_NOT_FOUND", "Contest season not found for this lobby", 404);
  }

  const phase = resolveSeasonPhase(season);
  const canonical = canonicalRoditId(roditId) || roditId;

  if (mode === "practice") {
    if (phase !== "practice") {
      throw gameError(
        "SEASON_PHASE_MISMATCH",
        "This practice lobby is outside the practice window",
        409,
        { phase }
      );
    }
    return;
  }

  if (mode === "qualifying") {
    if (phase !== "qualifying") {
      throw gameError(
        "SEASON_PHASE_MISMATCH",
        "This qualifying lobby is outside the qualifying window",
        409,
        { phase }
      );
    }
    if (isGuestRoditId(canonical)) {
      throw gameError(
        "PASSPORT_REQUIRED",
        "Qualifying seats require a Passport (guest join-by-url is not eligible)",
        403
      );
    }
    const practiced = await repo.hasSeasonPracticeFinish(seasonId, canonical);
    if (!practiced) {
      throw gameError(
        "PRACTICE_REQUIRED",
        "Play and finish at least one practice game in this season before joining qualifying",
        403,
        { seasonId }
      );
    }
    return;
  }

  if (mode === "definitive") {
    if (isGuestRoditId(canonical)) {
      throw gameError(
        "PASSPORT_REQUIRED",
        "Final seats require a Passport",
        403
      );
    }
    const roster = season.finalRoster || [];
    if (!roster.length) {
      throw gameError(
        "FINAL_ROSTER_EMPTY",
        "Operator has not published the final roster yet",
        409,
        { seasonId }
      );
    }
    const allowed = new Set(roster.map((id) => canonicalRoditId(id) || id));
    if (!allowed.has(canonical)) {
      throw gameError(
        "NOT_ON_FINAL_ROSTER",
        "Your Passport is not on the authorized final roster for this season",
        403,
        { seasonId }
      );
    }
  }
}

async function recordFinishedGame(game) {
  if (!game || game.status !== "finished") return null;
  const seasonId = game.config?.contestSeasonId;
  const mode = game.config?.contestMode;
  if (!seasonId || !mode) return null;

  const agents = await repo.listAgents(game.id);
  const byId = new Map(agents.map((a) => [a.id, a]));

  if (mode === "practice") {
    for (const agent of agents) {
      if (isGuestRoditId(agent.roditId)) continue;
      await repo.upsertSeasonPracticeCredit({
        seasonId,
        roditId: agent.roditId,
        gameId: game.id
      });
    }
    return { kind: "practice", credited: agents.filter((a) => !isGuestRoditId(a.roditId)).length };
  }

  if (mode === "qualifying") {
    const winnerIds = game.winnerIds || [];
    let credited = 0;
    for (const agentId of winnerIds) {
      const agent = byId.get(agentId);
      if (!agent || isGuestRoditId(agent.roditId)) continue;
      await repo.upsertSeasonQualifyingWin({
        seasonId,
        roditId: agent.roditId,
        gameId: game.id,
        agentId
      });
      credited += 1;
    }
    return { kind: "qualifying", credited };
  }

  return null;
}

async function setFinalRoster(seasonId, roditIds) {
  const season = await repo.getSeasonById(seasonId);
  if (!season) {
    throw gameError("SEASON_NOT_FOUND", "Season not found", 404);
  }

  if (!Array.isArray(roditIds)) {
    throw gameError("INVALID_ROSTER", "roditIds must be an array", 400);
  }

  const eligible = await repo.listSeasonQualifyingEligible(seasonId);
  const eligibleSet = new Set(eligible.map((row) => canonicalRoditId(row.roditId) || row.roditId));

  const roster = [];
  const seen = new Set();
  for (const raw of roditIds) {
    const id = canonicalRoditId(raw) || String(raw || "").trim();
    if (!id || isGuestRoditId(id)) {
      throw gameError("INVALID_ROSTER_ENTRY", "Roster entries must be Passport rodit ids", 400, {
        roditId: raw
      });
    }
    if (!eligibleSet.has(id)) {
      throw gameError(
        "ROSTER_NOT_ELIGIBLE",
        "Every roster Passport must have won at least one qualifying game this season",
        400,
        { roditId: id }
      );
    }
    if (seen.has(id)) continue;
    seen.add(id);
    roster.push(id);
  }

  if (!roster.length) {
    throw gameError("INVALID_ROSTER", "Final roster cannot be empty", 400);
  }

  const updated = await repo.updateSeason(seasonId, {
    finalRosterJson: JSON.stringify(roster),
    status: "roster_set",
    updatedAt: new Date().toISOString()
  });

  return publicSeason(updated, {
    extras: { eligibleCount: eligible.length, rosterCount: roster.length }
  });
}

async function createSeasonFinal(seasonId, { joiningWindowStartsAt = null, configOverrides = {} } = {}) {
  const season = await repo.getSeasonById(seasonId);
  if (!season) {
    throw gameError("SEASON_NOT_FOUND", "Season not found", 404);
  }
  if (season.finalGameId) {
    throw gameError("FINAL_ALREADY_CREATED", "This season already has a final game", 409, {
      finalGameId: season.finalGameId
    });
  }
  if (!(season.finalRoster || []).length) {
    throw gameError(
      "FINAL_ROSTER_REQUIRED",
      "Set the final roster with PUT /api/game/seasons/{id}/roster before creating the final",
      409
    );
  }

  const startsAt =
    joiningWindowStartsAt ||
    season.finalJoiningStartsAt ||
    new Date().toISOString();

  const engine = require("./engine");
  const game = await engine.createGame({
    config: mergeGameConfig({
      ...CONTEST_GAME_CONFIG,
      ...configOverrides,
      contestMode: "definitive",
      contestSeasonId: season.id,
      maxAgents: Math.min(
        CONTEST_GAME_CONFIG.maxAgents,
        Math.max(season.finalRoster.length, CONTEST_GAME_CONFIG.minAgents)
      ),
      minAgents: Math.min(CONTEST_GAME_CONFIG.minAgents, season.finalRoster.length)
    }),
    joiningWindowStartsAt: startsAt,
    allowParallelLobbies: true,
    bypassSimultaneousCap: true
  });

  const updated = await repo.updateSeason(seasonId, {
    finalGameId: game.id,
    status: "final_lobby",
    updatedAt: new Date().toISOString()
  });

  const orchestrator = require("./contest-orchestrator");
  orchestrator.registerLobbyGame(game);

  return { season: publicSeason(updated), finalGame: game };
}

async function getSeasonPublicView(seasonId) {
  const season = await repo.getSeasonById(seasonId);
  if (!season) return null;
  const phase = resolveSeasonPhase(season);
  const [practiceCount, eligible] = await Promise.all([
    repo.countSeasonPracticePlayers(seasonId),
    repo.listSeasonQualifyingEligible(seasonId)
  ]);
  return publicSeason(season, {
    phase,
    extras: {
      practicePlayers: practiceCount,
      qualifyingEligible: eligible.length,
      qualifyingEligibleRoditIds: eligible.map((row) => row.roditId)
    }
  });
}

async function getEligibilityForRodit(seasonId, roditId) {
  const season = await repo.getSeasonById(seasonId);
  if (!season) {
    throw gameError("SEASON_NOT_FOUND", "Season not found", 404);
  }
  const canonical = canonicalRoditId(roditId) || roditId;
  const practiced = await repo.hasSeasonPracticeFinish(seasonId, canonical);
  const wins = await repo.listSeasonQualifyingWinsForRodit(seasonId, canonical);
  const roster = season.finalRoster || [];
  const onRoster = roster.some((id) => (canonicalRoditId(id) || id) === canonical);
  return {
    seasonId,
    roditId: canonical,
    phase: resolveSeasonPhase(season),
    practiceCompleted: practiced,
    qualifyingWins: wins.length,
    qualifyingWinGameIds: wins.map((w) => w.gameId),
    finalEligible: wins.length > 0,
    onFinalRoster: onRoster
  };
}

module.exports = {
  isGuestRoditId,
  resolveSeasonPhase,
  publicSeason,
  createSeason,
  applySeasonCreatePolicy,
  assertSeasonJoinAllowed,
  recordFinishedGame,
  setFinalRoster,
  createSeasonFinal,
  getSeasonPublicView,
  getEligibilityForRodit
};
