# Planned improvements

> **Before editing:** Review [`documentation-standard.md`](documentation-standard.md).

**Created:** 2026-05-24  
**Last reviewed:** 2026-10-22

Cross-service backlog referenced by the standards. Items are numbered for stable cross-references; add new rows rather than renumbering existing ones.

| # | Area | Improvement | Status |
| --- | --- | --- | --- |
| 10 | Error handling | Migrate route handlers from ad hoc `res.status(...).json({ error, message?, requestId })` to SDK `errorResponse.sendError()` per [`error-handling-standard.md`](error-handling-standard.md) | **Done** on host APIs: `signsanctum-idc`, `signportal-idc`, `lastcradle-be` (2026-10-22). Keep the number for cross-references; new services must adopt `sendError` from day one |
| 11 | Error handling | Align global error middleware in `src/app.js` with the standard compact error body and `sendError()` (including `415`, `404`, and uncaught errors) | **Done** on the same three APIs (2026-10-22). New services must wire global handlers the same way |

## Notes

- Track progress in the consuming service repository; this file lives in **discernible-io/docs** for shared visibility.
- When an item is completed in a service, note the service name and date in the **Status** column or close the row—do not delete the number (other docs may cite it).
- Browser SPAs (for example `mintclient-idc`) and static sites are out of scope for items 10–11; they have no API error envelope.
