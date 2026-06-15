#!/usr/bin/env node
/** Counterfactual trade scenarios vs baseline (fixed seed via deterministic join order). */

const fs = require("fs");
const path = require("path");

function runScenario(name, tradeFn) {
  const DB_PATH = path.join(__dirname, "..", "data", `game-cf-${name}.sqlite`);
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

  process.env.NODE_CONFIG_ENV = "development";
  process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
  process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

  delete require.cache[require.resolve("../src/game/repository")];
  delete require.cache[require.resolve("../src/game/engine")];
  const engine = require("../src/game/engine");
  const repo = require("../src/game/repository");
  const { buildInvestAction } = require("../src/game/defaults");

  const PROFILES = [
    { roditId: "p-alpha", displayName: "Alpha" },
    { roditId: "p-beta", displayName: "Beta" },
    { roditId: "p-gamma", displayName: "Gamma" },
    { roditId: "p-delta", displayName: "Delta" }
  ];

  const FIXED = {
    useRandomStartingInventory: false,
    startingInventory: { energy: 100, water: 100, compute: 100 },
    territoryCapacityMin: 60,
    territoryCapacityMax: 60
  };

  const BASE_PLANS = [
    { a: buildInvestAction("energy", 15), b: buildInvestAction("water", 12), g: buildInvestAction("compute", 10), d: { type: "none" } },
    { a: buildInvestAction("energy", 10), b: { type: "none" }, g: buildInvestAction("compute", 8), d: { type: "none" } },
    null,
    { a: buildInvestAction("energy", 20), b: buildInvestAction("water", 15), g: { type: "none" }, d: { type: "none" } },
    { a: { type: "none" }, b: { type: "none" }, g: buildInvestAction("compute", 5), d: { type: "none" } }
  ];

  async function run() {
    await repo.initializeDatabase();
    const game = await engine.createGame({ config: FIXED });
    const agents = [];
    for (const p of PROFILES) agents.push(await engine.joinGame(game.id, p));
    await engine.startGame(game.id);

    let final = null;
    for (let turn = 1; turn <= 80; turn++) {
      await engine.beginMessageReportPhase(game.id);
      for (const a of agents) {
        const f = await repo.getAgentById(a.id);
        if (f.status !== "alive") continue;
        const c = await repo.getActualMessageCounts(game.id, turn, a.id);
        await engine.submitMessageReport(game.id, a.id, c);
      }
      await engine.beginExecutionPhase(game.id);

      let actions = { "p-alpha": { type: "none" }, "p-beta": { type: "none" }, "p-gamma": { type: "none" }, "p-delta": { type: "none" } };
      const bp = BASE_PLANS[turn - 1];
      if (bp) {
        actions = { "p-alpha": bp.a, "p-beta": bp.b, "p-gamma": bp.g, "p-delta": bp.d };
      }
      if (turn === 3) {
        actions["p-beta"] = { type: "transfer", toAgentId: agents.find((x) => x.roditId === "p-gamma").id, energy: 0, water: 20, compute: 0 };
        actions["p-gamma"] = buildInvestAction("compute", 10);
      }

      actions = tradeFn({ turn, agents, actions, repo });

      for (const p of PROFILES) {
        const f = await repo.getAgentById(agents.find((x) => x.roditId === p.roditId).id);
        if (f.status !== "alive") continue;
        let act = actions[p.roditId] || { type: "none" };
        if (act.type === "transfer") {
          const rec = await repo.getAgentById(act.toAgentId);
          if (!rec || rec.status !== "alive") act = { type: "none" };
        }
        await engine.submitAction(game.id, f.id, act);
      }

      final = await engine.getPublicState(game.id);
      for (let i = 0; i < agents.length; i++) {
        agents[i] = (await repo.listAgents(game.id)).find((x) => x.id === agents[i].id);
      }
      if (final.game.status === "finished") break;
    }

    await repo.closeDatabase();
    return {
      name,
      turns: final.game.currentTurn,
      status: final.game.status,
      deaths: final.agents
        .filter((a) => a.status !== "alive")
        .map((a) => `${a.displayName}@T${a.diedAtTurn}`)
        .join(", ") || "none",
      winners: final.agents.filter((a) => final.game.winnerIds?.includes(a.id)).map((a) => a.displayName).join(", ") || "—",
      finalInv: Object.fromEntries(
        final.agents.map((a) => [
          a.displayName,
          a.status === "alive" ? `E${a.inventory.energy.toFixed(0)} W${a.inventory.water.toFixed(0)} C${a.inventory.compute.toFixed(0)}` : "DEAD"
        ])
      )
    };
  }

  return run();
}

async function main() {
  const scenarios = [
    ["baseline", () => ({ turn, agents, actions }) => actions],
    [
      "beta-water-alpha-T15",
      ({ turn, agents, actions }) => {
        if (turn < 15) return actions;
        const beta = agents.find((a) => a.roditId === "p-beta");
        const alpha = agents.find((a) => a.roditId === "p-alpha");
        if (beta?.status === "alive" && alpha?.status === "alive") {
          actions["p-beta"] = { type: "transfer", toAgentId: alpha.id, energy: 0, water: 50, compute: 0 };
          actions["p-alpha"] = { type: "transfer", toAgentId: beta.id, energy: 30, water: 0, compute: 0 };
        }
        return actions;
      }
    ],
    [
      "beta-water-both-T15",
      ({ turn, agents, actions }) => {
        if (turn < 15) return actions;
        const beta = agents.find((a) => a.roditId === "p-beta");
        const alpha = agents.find((a) => a.roditId === "p-alpha");
        const delta = agents.find((a) => a.roditId === "p-delta");
        if (beta?.status !== "alive") return actions;
        if (alpha?.status === "alive") {
          actions["p-beta"] = { type: "transfer", toAgentId: alpha.id, energy: 0, water: 40, compute: 0 };
          actions["p-alpha"] = { type: "transfer", toAgentId: beta.id, energy: 25, water: 0, compute: 0 };
        } else if (delta?.status === "alive") {
          actions["p-beta"] = { type: "transfer", toAgentId: delta.id, energy: 0, water: 40, compute: 0 };
          actions["p-delta"] = { type: "transfer", toAgentId: beta.id, energy: 25, water: 0, compute: 0 };
        }
        return actions;
      }
    ],
    [
      "alpha-water-invest-T8",
      ({ turn, agents, actions }) => {
        if (turn >= 8 && agents.find((a) => a.roditId === "p-alpha")?.status === "alive") {
          actions["p-alpha"] = buildInvestAction("water", 15);
        }
        return actions;
      }
    ],
    [
      "combo-trades-plus-invest",
      ({ turn, agents, actions }) => {
        if (turn >= 8 && agents.find((a) => a.roditId === "p-alpha")?.status === "alive") {
          actions["p-alpha"] = buildInvestAction("water", 15);
        }
        if (turn >= 12) {
          const beta = agents.find((a) => a.roditId === "p-beta");
          const alpha = agents.find((a) => a.roditId === "p-alpha");
          const delta = agents.find((a) => a.roditId === "p-delta");
          if (beta?.status === "alive" && alpha?.status === "alive") {
            actions["p-beta"] = { type: "transfer", toAgentId: alpha.id, energy: 0, water: 35, compute: 0 };
            actions["p-alpha"] = { type: "transfer", toAgentId: beta.id, energy: 20, water: 0, compute: 0 };
          }
          if (beta?.status === "alive" && delta?.status === "alive" && turn % 2 === 0) {
            actions["p-delta"] = { type: "transfer", toAgentId: beta.id, energy: 15, water: 0, compute: 0 };
            if (!actions["p-beta"] || actions["p-beta"].type === "none") {
              actions["p-beta"] = { type: "transfer", toAgentId: delta.id, energy: 0, water: 30, compute: 0 };
            }
          }
        }
        return actions;
      }
    ],
    [
      "one-shot-T30-rescue",
      ({ turn, agents, actions }) => {
        if (turn !== 30) return actions;
        const beta = agents.find((a) => a.roditId === "p-beta");
        const alpha = agents.find((a) => a.roditId === "p-alpha");
        const delta = agents.find((a) => a.roditId === "p-delta");
        if (beta?.status === "alive" && alpha?.status === "alive") {
          actions["p-beta"] = { type: "transfer", toAgentId: alpha.id, energy: 0, water: 200, compute: 0 };
        }
        if (beta?.status === "alive" && delta?.status === "alive") {
          actions["p-delta"] = { type: "transfer", toAgentId: beta.id, energy: 50, water: 0, compute: 0 };
        }
        return actions;
      }
    ]
  ];

  const results = [];
  for (const [name, fn] of scenarios) {
    results.push(await runScenario(name, fn));
  }

  console.log("Counterfactual scenarios (fixed 60/60/60 territories, 100 start inv):\n");
  for (const r of results) {
    console.log(`${r.name}:`);
    console.log(`  Turns=${r.turns} status=${r.status} winners=${r.winners}`);
    console.log(`  Deaths: ${r.deaths}`);
    console.log(`  Final: ${JSON.stringify(r.finalInv)}`);
    console.log();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
