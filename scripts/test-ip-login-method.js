#!/usr/bin/env node
/**
 * Verifies per-game IP login method lock:
 * guest bind on game A blocks passport join on A; game B allows rodit_ed25519; same-method re-bind OK.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "ip-login-method-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const engine = require("../src/game/engine");
const repo = require("../src/game/repository");
const {
  METHODS,
  assertAndBindIpLoginMethod,
  assertGuestIpLoginMethod,
  assertPassportIpLoginMethod
} = require("../src/game/ip-login-method");

function fakeReq(ip) {
  return { ip };
}

async function expectError(label, promise, code) {
  try {
    await promise;
    throw new Error(`${label}: expected ${code}`);
  } catch (err) {
    if (err.code !== code) {
      throw new Error(`${label}: expected ${code}, got ${err.code || err.message}`);
    }
    return err;
  }
}

async function main() {
  await repo.initializeDatabase();

  const lobbyConfig = {
    maxAgents: 5,
    minAgents: 2,
    joiningWindowDurationMs: 60_000
  };

  const gameA = await engine.createGame({
    config: lobbyConfig,
    allowParallelLobbies: true
  });
  const gameB = await engine.createGame({
    config: lobbyConfig,
    allowParallelLobbies: true
  });
  const ip = "203.0.113.10";

  await assertGuestIpLoginMethod(fakeReq(ip), gameA.id);
  await assertAndBindIpLoginMethod({
    ip,
    gameId: gameA.id,
    method: METHODS.GUEST
  });

  const locked = await expectError(
    "passport after guest on A",
    assertAndBindIpLoginMethod({
      ip,
      gameId: gameA.id,
      method: METHODS.RODIT_ED25519
    }),
    "LOGIN_METHOD_LOCKED"
  );
  if (locked.details?.lockedMethod !== METHODS.GUEST) {
    throw new Error(`expected lockedMethod guest, got ${locked.details?.lockedMethod}`);
  }
  if (locked.details?.attemptedMethod !== METHODS.RODIT_ED25519) {
    throw new Error(`expected attemptedMethod rodit_ed25519`);
  }

  await repo.upsertRoditLoginMethod({
    roditId: "abcdefghijkl",
    method: METHODS.RODIT_ED25519,
    ip
  });
  await assertPassportIpLoginMethod(fakeReq(ip), gameB.id, "abcdefghijkl");

  await expectError(
    "guest after passport on B",
    assertGuestIpLoginMethod(fakeReq(ip), gameB.id),
    "LOGIN_METHOD_LOCKED"
  );

  // NEP413 vs ed25519 on same game
  const gameC = await engine.createGame({
    config: lobbyConfig,
    allowParallelLobbies: true
  });
  await assertAndBindIpLoginMethod({
    ip,
    gameId: gameC.id,
    method: METHODS.NEP413
  });
  await expectError(
    "ed25519 after nep413 on C",
    assertAndBindIpLoginMethod({
      ip,
      gameId: gameC.id,
      method: METHODS.RODIT_ED25519
    }),
    "LOGIN_METHOD_LOCKED"
  );

  console.log("ok: per-game IP login method lock");
  await repo.closeDatabase();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await repo.closeDatabase();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
