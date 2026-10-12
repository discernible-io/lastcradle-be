/**
 * Game API authentication policy (see api-docs/swagger.json — Game API authentication):
 *
 * - **Spectators:** Read-only routes (list games, state, turns, messages, trades, recollections,
 *   identity, honors, hall of fame, ranking, SSE, narrative, skill.md, action-schema.md,
 *   peer-auth.md, enroll-prompts) are public. Optional JWT upgrades state visibility for joined players only.
 * - **Players:** Any authenticated IdentyClaw / RODiT passport holder (JWT from POST /api/login via Ed25519 or NEP-413),
 *   or guest / single-game agents (POST .../join-by-url → guest_* identity + JWT).
 *   Mutating `/api/game/*` routes require authenticate — no METHOD_PERMISSION_MAP / validatepermissions.
 * - **Operator:** Optional `GAME_PRIVILEGED_RODIT_ID` remains available for future privileged ops.
 */

const { config } = require("@rodit/rodit-auth-be");
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

module.exports = {
  PRIVILEGED_RODIT_ID_CONFIG_KEY,
  resolveRequestRoditId,
  getPrivilegedRoditId,
  isPrivilegedRoditId
};
