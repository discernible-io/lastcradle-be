/**
 * Game API authentication policy (see api-docs/swagger.json — Game API authentication):
 *
 * - **Spectators:** Read-only routes (list games, state, turns, messages, trades, identity, honors, hall of fame, SSE, contests, narrative, skill.md, peer-auth.md) are public.
 *   Optional JWT upgrades state visibility for joined players only.
 * - **Players:** Any authenticated IdentyClaw / RODiT passport holder (JWT from POST /api/login),
 *   or URL-join agents (POST .../join-by-url → guest_* identity + JWT).
 *   Mutating `/api/game/*` routes require authenticate — no METHOD_PERMISSION_MAP / validatepermissions.
 * - **Operator:** POST /api/game/contests, POST /api/game/contest-series, and official contest lobbies
 *   require JWT roditId === GAME_PRIVILEGED_RODIT_ID (hardcoded administrator in server config).
 */

const { config } = require("@rodit/rodit-auth-be");
const { CONTEST_GAME_CONFIG } = require("./defaults");
const { roditIdFromUser, canonicalRoditId } = require("./rodit-id");

const PRIVILEGED_RODIT_ID_CONFIG_KEY = "GAME_PRIVILEGED_RODIT_ID";

function resolveRequestRoditId(req) {
  return roditIdFromUser(req?.user);
}

function getPrivilegedRoditId() {
  if (!config.has(PRIVILEGED_RODIT_ID_CONFIG_KEY)) {
    return null;
  }
  const value = config.get(PRIVILEGED_RODIT_ID_CONFIG_KEY);
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return canonicalRoditId(value.trim()) || null;
}

function isPrivilegedRoditId(req) {
  const configured = getPrivilegedRoditId();
  if (!configured) {
    return false;
  }
  const caller = resolveRequestRoditId(req);
  return Boolean(caller && caller === configured);
}

/** @deprecated use isPrivilegedRoditId */
function canCreateOfficialContest(req) {
  return isPrivilegedRoditId(req);
}

function isOfficialContestConfig(configOverrides = {}) {
  if (configOverrides.contestMode === "definitive") {
    return true;
  }
  return (
    Number(configOverrides.maxAgents) >= CONTEST_GAME_CONFIG.maxAgents &&
    Number(configOverrides.minAgents) >= CONTEST_GAME_CONFIG.minAgents
  );
}

module.exports = {
  PRIVILEGED_RODIT_ID_CONFIG_KEY,
  resolveRequestRoditId,
  getPrivilegedRoditId,
  isPrivilegedRoditId,
  canCreateOfficialContest,
  isOfficialContestConfig
};
