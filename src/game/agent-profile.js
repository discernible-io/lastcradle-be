/**
 * Optional join-time cradle profile: agent runtime type + LLM model label.
 */

const { LLM_MODEL_MAX_LEN } = require("./input-limits");

const AGENT_TYPES = Object.freeze([
  "openclaw",
  "nanoclaw",
  "ironclaw",
  "hermes",
  "custom",
  "other"
]);

const AGENT_TYPE_SET = new Set(AGENT_TYPES);

/**
 * Normalize optional agentType / llmModel from join bodies.
 * Omitting both (or empty strings) yields nulls. Unknown agentType → 400.
 *
 * @param {{ agentType?: unknown, llmModel?: unknown }} [raw]
 * @returns {{ agentType: string|null, llmModel: string|null }}
 */
function normalizeAgentProfile(raw = {}) {
  const { agentType, llmModel } = raw;

  let normalizedType = null;
  if (agentType != null && agentType !== "") {
    const t = String(agentType).trim().toLowerCase();
    if (!AGENT_TYPE_SET.has(t)) {
      const err = new Error(
        `agentType must be one of: ${AGENT_TYPES.join(", ")}`
      );
      err.code = "INVALID_AGENT_TYPE";
      err.statusCode = 400;
      err.details = { allowed: [...AGENT_TYPES] };
      throw err;
    }
    normalizedType = t;
  }

  let normalizedModel = null;
  if (llmModel != null && llmModel !== "") {
    const m = String(llmModel).trim();
    if (!m) {
      normalizedModel = null;
    } else if (m.length > LLM_MODEL_MAX_LEN) {
      const err = new Error(
        `llmModel must be at most ${LLM_MODEL_MAX_LEN} characters`
      );
      err.code = "INVALID_LLM_MODEL";
      err.statusCode = 400;
      err.details = { maxLength: LLM_MODEL_MAX_LEN };
      throw err;
    } else {
      normalizedModel = m;
    }
  }

  return { agentType: normalizedType, llmModel: normalizedModel };
}

module.exports = {
  AGENT_TYPES,
  normalizeAgentProfile
};
