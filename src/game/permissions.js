/**
 * Game-specific permission helpers (supplement SDK route authorization).
 */

const OFFICIAL_CONTEST_PERMISSION = "createOfficialContest";

function hasUserPermission(req, permission) {
  const permissions = req.user?.permissions;
  return Array.isArray(permissions) && permissions.includes(permission);
}

function canCreateOfficialContest(req) {
  return hasUserPermission(req, OFFICIAL_CONTEST_PERMISSION);
}

function isOfficialContestConfig(config = {}) {
  if (config.contestMode === "definitive") {
    return true;
  }
  return Number(config.maxAgents) >= 50 && Number(config.minAgents) >= 50;
}

function requireOfficialContestPermission(req) {
  return canCreateOfficialContest(req);
}

module.exports = {
  OFFICIAL_CONTEST_PERMISSION,
  hasUserPermission,
  canCreateOfficialContest,
  isOfficialContestConfig,
  requireOfficialContestPermission
};
