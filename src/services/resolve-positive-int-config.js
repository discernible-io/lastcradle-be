/**
 * Resolve a positive integer from SDK config with logged fallbacks.
 */

const { config, logger } = require("@rodit/rodit-auth-be");

/**
 * @param {string} key - Config path (e.g. MCP_MAX_SESSIONS)
 * @param {number} fallback - Baked-in default when missing/invalid
 * @param {{ component: string, operation?: string }} logContext
 * @returns {number}
 */
function resolvePositiveIntConfig(key, fallback, logContext) {
  const component = logContext.component;
  const operation = logContext.operation || "resolvePositiveIntConfig";

  if (config.has(key)) {
    const raw = config.get(key);
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    logger.warnWithContext("Invalid config value; using default", {
      component,
      operation,
      key,
      raw,
      fallback
    });
    return fallback;
  }

  logger.warnWithContext("Config key missing; using default", {
    component,
    operation,
    key,
    fallback
  });
  return fallback;
}

module.exports = {
  resolvePositiveIntConfig
};
