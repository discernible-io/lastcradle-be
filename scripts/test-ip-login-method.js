#!/usr/bin/env node
/**
 * Verifies per-game IP login method lock:
 * guest bind on game A blocks passport join on A; game B allows rodit_ed25519;
 * passport same-method re-bind OK; guest is exclusive (one seat per IP);
 * after TTL expiry a different method (or a new guest) is allowed.
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
  IP_LOGIN_METHOD_LOCK_TTL_MS,
  assertAndBindIpLoginMethod,
  assertGuestIpLoginMethod,
  assertPassportIpLoginMethod,
  ensureGuestIpLoginMethodAllowed
} = require("../src/game/ip-login-method");

function fakeReq(ip) {
  return { ip };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  if (IP_LOGIN_METHOD_LOCK_TTL_MS !== 10 * 60 * 1000) {
    throw new Error(`expected 10-minute TTL, got ${IP_LOGIN_METHOD_LOCK_TTL_MS}`);
  }

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
  const otherIp = "203.0.113.11";

  await assertGuestIpLoginMethod(fakeReq(ip), gameA.id);

  const secondGuest = await expectError(
    "second guest on A from same IP",
    assertGuestIpLoginMethod(fakeReq(ip), gameA.id),
    "LOGIN_METHOD_LOCKED"
  );
  if (secondGuest.details?.lockedMethod !== METHODS.GUEST) {
    throw new Error(`expected lockedMethod guest, got ${secondGuest.details?.lockedMethod}`);
  }
  if (secondGuest.details?.attemptedMethod !== METHODS.GUEST) {
    throw new Error(`expected attemptedMethod guest`);
  }
  if (!(secondGuest.details?.retryAfterSeconds > 0)) {
    throw new Error(`expected retryAfterSeconds > 0, got ${secondGuest.details?.retryAfterSeconds}`);
  }
  if (!/guest seat/i.test(secondGuest.message || "")) {
    throw new Error(`expected one-guest message, got ${secondGuest.message}`);
  }

  await expectError(
    "ensureGuest after guest bind on A",
    ensureGuestIpLoginMethodAllowed(fakeReq(ip), gameA.id),
    "LOGIN_METHOD_LOCKED"
  );

  await assertGuestIpLoginMethod(fakeReq(otherIp), gameA.id);

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
  if (!(locked.details?.retryAfterSeconds > 0)) {
    throw new Error(`expected retryAfterSeconds > 0, got ${locked.details?.retryAfterSeconds}`);
  }
  if (!locked.details?.lockedUntil) {
    throw new Error("expected lockedUntil");
  }

  await repo.upsertRoditLoginMethod({
    roditId: "abcdefghijkl",
    method: METHODS.RODIT_ED25519,
    ip
  });
  await assertPassportIpLoginMethod(fakeReq(ip), gameB.id, "abcdefghijkl");
  await assertPassportIpLoginMethod(fakeReq(ip), gameB.id, "abcdefghijkl");

  await expectError(
    "guest after passport on B",
    assertGuestIpLoginMethod(fakeReq(ip), gameB.id),
    "LOGIN_METHOD_LOCKED"
  );

  const gameGuestB = await engine.createGame({
    config: lobbyConfig,
    allowParallelLobbies: true
  });
  await assertGuestIpLoginMethod(fakeReq(ip), gameGuestB.id);

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
  await assertAndBindIpLoginMethod({
    ip,
    gameId: gameC.id,
    method: METHODS.NEP413
  });

  // Cool-down expiry: short TTL via repository bind
  const gameD = await engine.createGame({
    config: lobbyConfig,
    allowParallelLobbies: true
  });
  // SQLite datetime('now') is second-precision; keep TTL > 1s for the in-window check.
  const shortTtlMs = 2000;
  let r = await repo.bindGameIpLoginMethod({
    gameId: gameD.id,
    ip,
    method: METHODS.GUEST,
    ttlMs: shortTtlMs
  });
  if (!r.ok) {
    throw new Error("short-ttl guest bind should succeed");
  }
  r = await repo.bindGameIpLoginMethod({
    gameId: gameD.id,
    ip,
    method: METHODS.GUEST,
    ttlMs: shortTtlMs
  });
  if (r.ok || r.lockedMethod !== METHODS.GUEST || r.reason !== "guest_already_bound") {
    throw new Error("short-ttl second guest should be locked (one guest per IP)");
  }
  r = await repo.bindGameIpLoginMethod({
    gameId: gameD.id,
    ip,
    method: METHODS.RODIT_ED25519,
    ttlMs: shortTtlMs
  });
  if (r.ok || r.lockedMethod !== METHODS.GUEST) {
    throw new Error("short-ttl switch should be locked to guest");
  }
  await sleep(shortTtlMs + 50);
  r = await repo.bindGameIpLoginMethod({
    gameId: gameD.id,
    ip,
    method: METHODS.RODIT_ED25519,
    ttlMs: shortTtlMs
  });
  if (!r.ok || r.lockedMethod !== METHODS.RODIT_ED25519) {
    throw new Error("after TTL, rodit_ed25519 bind should succeed");
  }

  const gameE = await engine.createGame({
    config: lobbyConfig,
    allowParallelLobbies: true
  });
  r = await repo.bindGameIpLoginMethod({
    gameId: gameE.id,
    ip,
    method: METHODS.GUEST,
    ttlMs: shortTtlMs
  });
  if (!r.ok) {
    throw new Error("game E guest bind should succeed");
  }
  await sleep(shortTtlMs + 50);
  r = await repo.bindGameIpLoginMethod({
    gameId: gameE.id,
    ip,
    method: METHODS.GUEST,
    ttlMs: shortTtlMs
  });
  if (!r.ok || r.lockedMethod !== METHODS.GUEST) {
    throw new Error("after TTL, a new guest bind should succeed");
  }

  console.log("ok: per-game IP login method lock (10-minute cool-down, one guest per IP)");
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
