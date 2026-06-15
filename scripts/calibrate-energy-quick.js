#!/usr/bin/env node
/** Targeted energy calibration sweep for ~30 turn average. */
const PLAYER_COUNT = Number(process.argv[2]) || 20;
const TARGET = Number(process.argv[3]) || 30;
const TRIALS = Number(process.argv[4]) || 8;

// Patch trials count on scoreConfig via env
process.env.CALIB_TRIALS = String(TRIALS);

const calibrate = require("./calibrate-energy-survival.js");
const { buildProfiles, buildTurnPlans, scoreConfig } = calibrate;

const candidates = [
  { base: 8, lead: -0.12, inc: 0.04 },
  { base: 8, lead: -0.12, inc: 0.05 },
  { base: 8, lead: -0.10, inc: 0.04 },
  { base: 8, lead: -0.10, inc: 0.05 },
  { base: 8, lead: -0.10, inc: 0.06 },
  { base: 8, lead: -0.08, inc: 0.05 },
  { base: 8, lead: -0.08, inc: 0.06 },
  { base: 8, lead: -0.08, inc: 0.07 },
  { base: 10, lead: -0.10, inc: 0.05 },
  { base: 10, lead: -0.10, inc: 0.06 },
  { base: 10, lead: -0.08, inc: 0.06 },
  { base: 10, lead: -0.05, inc: 0.06 },
  { base: 10, lead: -0.05, inc: 0.08 },
  { base: 10, lead: 0, inc: 0.06 },
  { base: 10, lead: 0, inc: 0.08 }
];

(async () => {
  const profiles = buildProfiles(PLAYER_COUNT);
  const turnPlans = buildTurnPlans(profiles);

  console.log(`Target ${TARGET} turns @ ${PLAYER_COUNT}p, ${TRIALS} trials/config, water budget OFF\n`);

  let best = null;
  for (const cfg of candidates) {
    const energyConfig = {
      energySurvivalProductionLead: cfg.lead,
      energySurvivalTurnIncrement: cfg.inc,
      survivalCost: { energy: cfg.base, water: 10, compute: 10 }
    };
    const r = await scoreConfig(energyConfig, profiles, turnPlans);
    const err = Math.abs(r.avg - TARGET);
    const dc = r.deathCauses;
    console.log(
      `base=${cfg.base} lead=${cfg.lead.toFixed(2)} inc=${cfg.inc.toFixed(2)} → avg=${r.avg.toFixed(1)} [${r.min}-${r.max}] E${dc.energy}/W${dc.water}/C${dc.compute}`
    );
    if (!best || err < best.err || (err === best.err && dc.water < best.deathCauses.water)) {
      best = { ...cfg, ...r, err };
    }
  }

  console.log("\nRECOMMENDED (energy-led, flat water during cal):");
  console.log(`  survivalCost.energy:          ${best.base}`);
  console.log(`  energySurvivalProductionLead: ${best.lead}`);
  console.log(`  energySurvivalTurnIncrement:  ${best.inc}`);
  console.log(`  avg turns: ${best.avg.toFixed(1)} (err ${best.err.toFixed(1)} from target ${TARGET})`);
  console.log(`  range: ${best.min} – ${best.max}`);
  console.log(
    `  elimination causes: energy=${best.deathCauses.energy} water=${best.deathCauses.water} compute=${best.deathCauses.compute}`
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
