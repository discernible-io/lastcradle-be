#!/usr/bin/env node
/** One trial per formula, fixed config — fast calibration. */
const path = require("path");
const fs = require("fs");

async function runTrial(scaling) {
  const DB = path.join(__dirname, "..", "data", `qcal-${Date.now()}.sqlite`);
  fs.mkdirSync(path.dirname(DB), { recursive: true });
  process.env.NODE_CONFIG_ENV = "development";
  process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
  process.env.API_DEFAULT_OPTIONS_DB_PATH = DB;
  delete require.cache[require.resolve("../src/game/engine")];
  delete require.cache[require.resolve("../src/game/repository")];
  const engine = require("../src/game/engine");
  const repo = require("../src/game/repository");
  const { buildInvestAction } = require("../src/game/defaults");
  const short = { "sim-alpha": "a", "sim-beta": "b", "sim-gamma": "c", "sim-delta": "d" };
  const PLANS = [
    { a: buildInvestAction("energy", 15), b: buildInvestAction("water", 12), c: buildInvestAction("compute", 10), d: { type: "none" } },
    { a: buildInvestAction("energy", 10), b: { type: "none" }, c: buildInvestAction("compute", 8), d: { type: "none" } },
    "transfer",
    { a: buildInvestAction("energy", 20), b: buildInvestAction("water", 15), c: { type: "none" }, d: { type: "none" } },
    { a: { type: "none" }, b: { type: "none" }, c: buildInvestAction("compute", 5), d: { type: "none" } }
  ];

  function survivalForTurn(t, base) {
    if (scaling.mode === "flat") return base;
    if (scaling.mode === "add") {
      const add = scaling.k * (t - 1);
      return { energy: base.energy + add, water: base.water + add, compute: base.compute + add };
    }
    const m = 1 + scaling.k * (t - 1);
    return { energy: base.energy * m, water: base.water * m, compute: base.compute * m };
  }

  await repo.initializeDatabase();
  const game = await engine.createGame({
    config: {
      useRandomStartingInventory: false,
      startingInventory: { energy: 90, water: 90, compute: 90 },
      cradleCapacityMin: 40,
      cradleCapacityMax: 40,
      minAgents: 3
    }
  });
  const gameId = game.id;
  const baseSurvival = { ...game.config.survivalCost };
  let agents = [];
  for (const roditId of ["sim-alpha", "sim-beta", "sim-gamma", "sim-delta"]) {
    agents.push(await engine.joinGame(gameId, { roditId, displayName: roditId }));
  }
  await engine.startGame(gameId);
  const db = await repo.getDb();

  for (let t = 1; t <= 200; t++) {
    const g = await repo.getGameById(gameId);
    await db.run("UPDATE games SET config_json = ? WHERE id = ?", [
      JSON.stringify({ ...g.config, survivalCost: survivalForTurn(t, baseSurvival) }),
      gameId
    ]);
    agents = await repo.listAgents(gameId);
    const living = agents.filter((a) => a.status === "alive");
    await engine.beginExecutionPhase(gameId);
    let plan = PLANS[(t - 1) % 5];
    if (plan === "transfer") {
      const gamma = agents.find((x) => x.roditId === "sim-gamma" && x.status === "alive");
      plan = gamma
        ? { a: { type: "none" }, b: { type: "transfer", toAgentId: gamma.id, water: 20 }, c: buildInvestAction("compute", 10), d: { type: "none" } }
        : { a: { type: "none" }, b: { type: "none" }, c: buildInvestAction("compute", 10), d: { type: "none" } };
    }
    for (const a of living) {
      if ((await repo.getAgentById(a.id)).status !== "alive") continue;
      const act = plan[short[a.roditId]] || { type: "none" };
      if (act.type === "transfer") {
        const recip = await repo.getAgentById(act.toAgentId);
        if (!recip || recip.status !== "alive") continue;
      }
      await engine.submitAction(gameId, a.id, act);
    }
    if ((await engine.getPublicState(gameId)).game.status === "finished") {
      await repo.closeDatabase();
      try { fs.unlinkSync(DB); } catch {}
      return t;
    }
  }
  await repo.closeDatabase();
  try { fs.unlinkSync(DB); } catch {}
  return null;
}

(async () => {
  const candidates = [
    { mode: "flat", label: "flat 10/turn" },
    { mode: "add", k: 0.2, label: "10 + 0.20×(turn−1)" },
    { mode: "add", k: 0.26, label: "10 + 0.26×(turn−1)" },
    { mode: "add", k: 0.3, label: "10 + 0.30×(turn−1)" },
    { mode: "add", k: 0.34, label: "10 + 0.34×(turn−1)" },
    { mode: "mul", k: 0.012, label: "10 × (1 + 0.012×(turn−1))" },
    { mode: "mul", k: 0.015, label: "10 × (1 + 0.015×(turn−1))" }
  ];
  for (const c of candidates) {
    const turn = await runTrial(c);
    let at100 = "";
    if (c.mode === "add") at100 = ` (≈${(10 + c.k * 99).toFixed(0)} E/W/C at turn 100)`;
    if (c.mode === "mul") at100 = ` (≈${(10 * (1 + c.k * 99)).toFixed(0)} E/W/C at turn 100)`;
    console.log(`${c.label}: game ends turn ${turn ?? "200+ (no finish)"}${at100}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
