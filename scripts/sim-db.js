/**
 * Simulation database lifecycle: reset before each run, clean up artifacts after.
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const WORKSPACE_DB = path.join(DATA_DIR, "sim-workspace.sqlite");

/** Ephemeral sqlite files created by scripts; never delete production database.sqlite */
const EPHEMERAL_DB_PATTERN =
  /^(sim-|cal-|cale-|cal2-|cal-surv-|cal-water-|game-simulation|game-cf-|game-metrics|game-sample|game-projection|probe-|bench-|debug-|mechanics-|smoke|capacity-relative).*\.sqlite(-journal|-wal|-shm)?$/;

function sqliteSidecarPaths(dbPath) {
  return [dbPath, `${dbPath}-journal`, `${dbPath}-wal`, `${dbPath}-shm`];
}

function removeSqliteFiles(dbPath) {
  for (const file of sqliteSidecarPaths(dbPath)) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* ignore locked files */
    }
  }
}

function cleanupSimulationArtifacts(dataDir = DATA_DIR) {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    return { removed: 0, bytesFreed: 0 };
  }

  let removed = 0;
  let bytesFreed = 0;
  for (const name of fs.readdirSync(dataDir)) {
    if (!EPHEMERAL_DB_PATTERN.test(name)) continue;
    const filePath = path.join(dataDir, name);
    try {
      const stat = fs.statSync(filePath);
      bytesFreed += stat.size;
      fs.unlinkSync(filePath);
      removed++;
    } catch {
      /* ignore */
    }
  }
  return { removed, bytesFreed };
}

function clearEngineModules() {
  delete require.cache[require.resolve("../src/game/repository")];
  delete require.cache[require.resolve("../src/game/engine")];
}

/**
 * Close any open connection, delete the workspace file, and load a fresh engine.
 */
async function prepareSimulationRun({ dbPath = WORKSPACE_DB } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  try {
    const repo = require("../src/game/repository");
    await repo.closeDatabase();
  } catch {
    /* first run or module not loaded */
  }

  removeSqliteFiles(dbPath);
  process.env.API_DEFAULT_OPTIONS_DB_PATH = dbPath;
  clearEngineModules();

  const engine = require("../src/game/engine");
  const repo = require("../src/game/repository");
  await repo.initializeDatabase();

  return { engine, repo, dbPath };
}

/**
 * Close connection and remove workspace sqlite files.
 */
async function disposeSimulationRun(repo, dbPath = WORKSPACE_DB) {
  if (repo) {
    await repo.closeDatabase();
  }
  clearEngineModules();
  removeSqliteFiles(dbPath);
}

module.exports = {
  DATA_DIR,
  WORKSPACE_DB,
  cleanupSimulationArtifacts,
  prepareSimulationRun,
  disposeSimulationRun,
  removeSqliteFiles
};
