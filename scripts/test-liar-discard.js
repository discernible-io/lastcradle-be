#!/usr/bin/env node
/**
 * Message-report liar discard was removed with the messaging-cost / report phase.
 * Kept as a no-op so older harnesses that invoke this script still exit 0.
 */
console.log("Skipped: liar discard / message-report feature removed (negotiation → execution only).");
process.exit(0);
