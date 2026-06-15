#!/usr/bin/env node
const path = require("path");
const fs = require("fs");

async function runTrial(scaling) {
  const DB = path.join(__dirname, "..", "data", `cal-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  fs.mkdirSync(path.dirname(DB), { recursive: true });
  process.env.NODE_CONFIG_ENV = "development";
  process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
  process.env.API_DEFAULT_OPTIONS_DB_PATH = DB;

  delete require.cache[require.resolve("../src/game/engine")];
  delete require.cache[require.resolve("../src/game/repository")];
  const engine = require("../src/game/engine");
  const repo = require("../src/game/repository");
  const { buildInvestAction } = require("../src/game/defaults");

  const PLANS = [
    { a: buildInvestAction("energy", 15), b: buildInvestAction("water", 12), c: buildInvestAction("compute", 10), d: { type: "none" } },
    { a: buildInvestAction("energy", 10), b: { type: "none" }, c: buildInvestAction("compute", 8), d: { type: "none" } },
    "transfer",
    { a: buildInvestAction("energy", 20), b: buildInvestAction("water", 15), c: { type: "none" }, d: { type: "none" } },
    { a: { type: "none" }, b: { type: "none" }, c: buildInvestAction("compute", 5), d: { type: "none" } }
  ];
  const short = { "sim-alpha": "a", "sim-beta": "b", "sim-gamma": "c", "sim-delta": "d" };

  function survivalForTurn(t, base) {
    if (scaling.mode === "flat") return base;
    if (scaling.mode === "linear_add") {
      const add = scaling.k * (t - 1);
      return { energy: base.energy + add, water: base.water + add, compute: base.compute + add };
    }
    if (scaling.mode === "linear") {
      const m = 1 + scaling.k * (t - 1);
      return { energy: base.energy * m, water: base.water * m, compute: base.compute * m };
    }
    return base;
  }

  await repo.initializeDatabase();
  const game = await engine.createGame({
    config: {
      useRandomStartingInventory: true,
      startingInventoryMin: 20,
      startingInventoryMax: 100,
      territoryCapacityMin: 20,
      territoryCapacityMax: 100,
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
    const cfg = { ...g.config, survivalCost: survivalForTurn(t, baseSurvival) };
    await db.run("UPDATE games SET config_json = ? WHERE id = ?", [JSON.stringify(cfg), gameId]);

    agents = await repo.listAgents(gameId);
    const living = agents.filter((a) => a.status === "alive");
    await engine.beginMessageReportPhase(gameId);
    for (const a of living) {
      const msgs = await repo.listPublicMessages(gameId, t);
      await engine.submitMessageReport(gameId, a.id, {
        sent: msgs.filter((m) => m.from_agent_id === a.id).length,
        received: msgs.filter((m) => m.to_agent_id === a.id).length
      });
    }
    await engine.beginExecutionPhase(gameId);
    let plan = PLANS[(t - 1) % 5];
    if (plan === "transfer") {
      const gamma = agents.find((x) => x.roditId === "sim-gamma" && x.status === "alive");
      plan = gamma
        ? { a: { type: "none" }, b: { type: "transfer", toAgentId: gamma.id, water: 20 }, c: buildInvestAction("compute", 10), d: { type: "none" } }
        : { a: { type: "none" }, b: { type: "none" }, c: buildInvestAction("compute", 10), d: { type: "none" } };
    }
    for (const a of living) {
      const fresh = await repo.getAgentById(a.id);
      if (fresh.status !== "alive") continue;
      const act = plan[short[a.roditId]] || { type: "none" };
      if (act.type === "transfer") {
        const recip = await repo.getAgentById(act.toAgentId);
        if (!recip || recip.status !== "alive") continue;
      }
      await engine.submitAction(gameId, a.id, act);
    }
    const state = await engine.getPublicState(gameId);
    if (state.game.status === "finished") {
      await repo.closeDatabase();
      try {
        fs.unlinkSync(DB);
      } catch {}
      return t;
    }
  }
  await repo.closeDatabase();
  try {
    fs.unlinkSync(DB);
  } catch {}
  return null;
}

(async () => {
  const candidates = [
    { mode: "flat", label: "flat 10" },
    { mode: "linear_add", k: 0.2, label: "10+0.20*(t-1)" },
    { mode: "linear_add", k: 0.24, label: "10+0.24*(t-1)" },
    { mode: "linear_add", k: 0.26, label: "10+0.26*(t-1)" },
    { mode: "linear_add", k: 0.28, label: "10+0.28*(t-1)" },
    { mode: "linear", k: 0.01, label: "10*(1+0.010*(t-1))" },
    { mode: "linear", k: 0.012, label: "10*(1+0.012*(t-1))" },
    { mode: "linear", k: 0.014, label: "10*(1+0.014*(t-1))" }
  ];
  for (const c of candidates) {
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await runTrial(c));
    }
    const finished = results.filter((x) => x != null);
    const avg = finished.length ? Math.round(finished.reduce((a, b) => a + b, 0) / finished.length) : null;
    console.log(JSON.stringify({ label: c.label, trials: results, avg, finishRate: `${finished.length}/3` }));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
