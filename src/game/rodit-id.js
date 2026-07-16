/**
 * RODiT / IdentyClaw subject ID helpers.
 *
 * JWT `sub` may be a compound URN:
 *   bc=near.org;sc=….near;id=…;sub=<passportTokenId>
 * while chain lookups and stable game identity use the 12-char passport token id.
 */

function normalizeRoditId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isPassportTokenId(roditId) {
  return /^[A-Za-z][A-Za-z0-9]{11}$/.test(roditId);
}

function isImplicitAccount(roditId) {
  return /^[0-9a-f]{64}$/i.test(roditId);
}

function isCompoundRoditSubject(roditId) {
  return /(?:^|;)\s*(?:bc|sub)=/i.test(roditId) || roditId.includes(";");
}

/**
 * True only for real NEAR account ids (implicit hex or dotted named accounts).
 * Compound JWT subjects must never be treated as account ids.
 */
function isNearAccountId(roditId) {
  const normalized = normalizeRoditId(roditId);
  if (!normalized || isCompoundRoditSubject(normalized)) {
    return false;
  }
  if (isImplicitAccount(normalized)) {
    return true;
  }
  // Named NEAR accounts look like "alice.near" / "genaaaa-identyclaw-com.near"
  return /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/i.test(normalized);
}

/**
 * Extract the 12-char passport token id from a raw rodit id or compound JWT sub.
 * Returns "" when no passport id can be derived.
 */
function extractPassportTokenId(roditId) {
  const normalized = normalizeRoditId(roditId);
  if (!normalized) {
    return "";
  }
  if (isPassportTokenId(normalized)) {
    return normalized;
  }
  const subMatch = /(?:^|;)\s*sub=([A-Za-z][A-Za-z0-9]{11})\s*(?:;|$)/i.exec(normalized);
  if (subMatch) {
    return subMatch[1];
  }
  return "";
}

/**
 * Canonical identity for game storage / lookups: prefer passport token id when present.
 */
function canonicalRoditId(roditId) {
  const passport = extractPassportTokenId(roditId);
  if (passport) {
    return passport;
  }
  return normalizeRoditId(roditId);
}

/**
 * Resolve rodit identity from an auth user / JWT payload.
 * Prefers snake_case `rodit_id` (JWT claim) over camelCase / raw compound `sub`.
 */
function roditIdFromUser(user) {
  if (!user || typeof user !== "object") {
    return null;
  }
  const raw =
    normalizeRoditId(user.rodit_id) ||
    normalizeRoditId(user.roditId) ||
    normalizeRoditId(user.sub) ||
    normalizeRoditId(user.id) ||
    "";
  if (!raw) {
    return null;
  }
  return canonicalRoditId(raw) || null;
}

/**
 * SQL extras so lookups by passport id also match legacy compound URNs in game_agents.
 * Returns { sql, params } to append after an equality match on the canonical id.
 */
function compoundRoditIdMatchSql(column, passportOrCanonical) {
  const canonical = canonicalRoditId(passportOrCanonical);
  if (!canonical || !isPassportTokenId(canonical)) {
    return { sql: "", params: [] };
  }
  // Legacy rows: "...;sub=<passport>" (optionally followed by more segments)
  return {
    sql: ` OR ${column} LIKE ? OR ${column} LIKE ?`,
    params: [`%;sub=${canonical}`, `%;sub=${canonical};%`]
  };
}

module.exports = {
  normalizeRoditId,
  isPassportTokenId,
  isImplicitAccount,
  isCompoundRoditSubject,
  isNearAccountId,
  extractPassportTokenId,
  canonicalRoditId,
  roditIdFromUser,
  compoundRoditIdMatchSql
};
