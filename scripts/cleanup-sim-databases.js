#!/usr/bin/env node
/**
 * Remove ephemeral simulation SQLite files from data/.
 * Safe to run anytime — does not delete database.sqlite (production/dev app DB).
 *
 * Usage: node scripts/cleanup-sim-databases.js
 */

const { cleanupSimulationArtifacts, DATA_DIR } = require("./sim-db");

const result = cleanupSimulationArtifacts();
console.log(`Data directory: ${DATA_DIR}`);
if (result.removed === 0) {
  console.log("No simulation database files to remove.");
} else {
  console.log(
    `Removed ${result.removed} file(s), freed ${(result.bytesFreed / 1024 / 1024).toFixed(2)} MB.`
  );
}
