# Planned improvements

> **Before editing:** Review [`documentation-standard.md`](documentation-standard.md).

**Created:** 2026-05-24

Cross-service backlog referenced by the standards. Items are numbered for stable cross-references; add new rows rather than renumbering existing ones.

| # | Area | Improvement | Status |
| --- | --- | --- | --- |
| 10 | Error handling | Migrate route handlers from ad hoc `res.status(...).json({ error, message?, requestId })` to SDK `errorResponse.sendError()` per [`error-handling-standard.md`](error-handling-standard.md) | Done in syntheticslastcradle (2026-06-18); open elsewhere |
| 11 | Error handling | Align global error middleware in `src/app.js` with the standard compact error body and `sendError()` (including `415`, `404`, and uncaught errors) | Done in syntheticslastcradle (2026-06-18); open elsewhere |
| 12 | Game API | Document JWT passport vs `GAME_PRIVILEGED_RODIT_ID` auth in swagger (`x-game-auth`); exclude `/api/game/*` from `METHOD_PERMISSION_MAP` | Done in syntheticslastcradle (2026-06-23) |
| 13 | Game API | Align OpenAPI with runtime (ULID game ids, join 409 codes, `practiceStartsAt` required, action schema) | Done in syntheticslastcradle (2026-06-23); extend response schemas as needed |

## Notes

- Track progress in the consuming service repository; this file lives in **discernible-io/docs** for shared visibility.
- When an item is completed in a service, note the service name and date in the **Status** column or close the row—do not delete the number (other docs may cite it).
