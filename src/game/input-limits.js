/**
 * Generous-but-safe length limits for authenticated writes and shared parsers.
 * Worst-case recollection (6 × RECOLLECTION_FIELD_MAX) fits under JSON_BODY_LIMIT.
 */

/** express.json / urlencoded limit strings (body-parser). */
const JSON_BODY_LIMIT = "256kb";
const URLENCODED_BODY_LIMIT = "64kb";

/** POST .../recollection topic fields (truncated). */
const RECOLLECTION_FIELD_MAX = 16000;

/** POST .../message public negotiation body (truncated). */
const PUBLIC_MESSAGE_BODY_MAX = 16000;

/** Transfer action public rationale (truncated). */
const TRADE_RATIONALE_MAX_LEN = 8000;

/** Curated private-deal snippets on transfer actions. */
const TRADE_SNIPPET_MAX = 10;
const TRADE_SNIPPET_EXCERPT_MAX = 2000;
const TRADE_SNIPPET_CHANNEL_MAX = 128;
const TRADE_SNIPPET_TASK_TYPE_MAX = 64;
const TRADE_SNIPPET_TOKEN_MAX = 256;

/** join-by-url / webhook registration (rejected if longer). */
const WEBHOOK_URL_MAX_LEN = 2048;

/** Optional llmModel on join (rejected if longer). */
const LLM_MODEL_MAX_LEN = 128;

/** CRUDA comment field (rejected if longer). */
const CRUDA_COMMENT_MAX_LEN = 16000;

module.exports = {
  JSON_BODY_LIMIT,
  URLENCODED_BODY_LIMIT,
  RECOLLECTION_FIELD_MAX,
  PUBLIC_MESSAGE_BODY_MAX,
  TRADE_RATIONALE_MAX_LEN,
  TRADE_SNIPPET_MAX,
  TRADE_SNIPPET_EXCERPT_MAX,
  TRADE_SNIPPET_CHANNEL_MAX,
  TRADE_SNIPPET_TASK_TYPE_MAX,
  TRADE_SNIPPET_TOKEN_MAX,
  WEBHOOK_URL_MAX_LEN,
  LLM_MODEL_MAX_LEN,
  CRUDA_COMMENT_MAX_LEN
};
