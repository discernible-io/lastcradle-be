/**
 * Privileged game operations are allowed only for a configured RODiT identity.
 * Does not use rodit-auth-be METHOD_PERMISSION_MAP authorization.
 */

const { config } = require("@rodit/rodit-auth-be");

const PRIVILEGED_RODIT_ID_CONFIG_KEY = "GAME_PRIVILEGED_RODIT_ID";

function resolveRequestRoditId(req) {
  return req.user?.roditId || req.user?.sub || req.user?.id || null;
}

function getPrivilegedRoditId() {
  if (!config.has(PRIVILEGED_RODIT_ID_CONFIG_KEY)) {
    return null;
  }
  const value = config.get(PRIVILEGED_RODIT_ID_CONFIG_KEY);
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return value.trim();
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
  return Number(configOverrides.maxAgents) >= 50 && Number(configOverrides.minAgents) >= 50;
}

module.exports = {
  PRIVILEGED_RODIT_ID_CONFIG_KEY,
  resolveRequestRoditId,
  getPrivilegedRoditId,
  isPrivilegedRoditId,
  canCreateOfficialContest,
  isOfficialContestConfig
};
