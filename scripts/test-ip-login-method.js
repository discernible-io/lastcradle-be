#!/usr/bin/env node
/**
 * Verifies per-game IP guest seat limit:
 * one guest per IP per game; passport joins (ed25519 and nep413) are unlimited
 * and may share that IP with the guest seat; after TTL a new guest is allowed.
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

  await assertAndBindIpLoginMethod({
    ip,
    gameId: gameA.id,
    method: METHODS.RODIT_ED25519
  });
  await assertAndBindIpLoginMethod({
    ip,
    gameId: gameA.id,
    method: METHODS.NEP413
  });
  const guestStillHeld = await repo.getGameIpLoginMethod(gameA.id, ip);
  if (guestStillHeld?.method !== METHODS.GUEST) {
    throw new Error("passport joins must not clear the guest seat");
  }

  await repo.upsertRoditLoginMethod({
    roditId: "abcdefghijkl",
    method: METHODS.RODIT_ED25519,
    ip
  });
  await repo.upsertRoditLoginMethod({
    roditId: "mnopqrstuvwx",
    method: METHODS.NEP413,
    ip
  });
  await assertPassportIpLoginMethod(fakeReq(ip), gameB.id, "abcdefghijkl");
  await assertPassportIpLoginMethod(fakeReq(ip), gameB.id, "mnopqrstuvwx");
  if (await repo.getGameIpLoginMethod(gameB.id, ip)) {
    throw new Error("passport joins must not reserve the IP");
  }

  await assertGuestIpLoginMethod(fakeReq(ip), gameB.id);
  await expectError(
    "second guest after passport on B",
    assertGuestIpLoginMethod(fakeReq(ip), gameB.id),
    "LOGIN_METHOD_LOCKED"
  );

  const gameC = await engine.createGame({
    config: lobbyConfig,
    allowParallelLobbies: true
  });
  await assertAndBindIpLoginMethod({
    ip,
    gameId: gameC.id,
    method: METHODS.NEP413
  });
  await assertAndBindIpLoginMethod({
    ip,
    gameId: gameC.id,
    method: METHODS.RODIT_ED25519
  });
  await assertGuestIpLoginMethod(fakeReq(ip), gameC.id);

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
  if (!r.ok || r.lockedMethod !== METHODS.RODIT_ED25519) {
    throw new Error("passport bind must succeed while a guest seat is held");
  }
  const held = await repo.getGameIpLoginMethod(gameD.id, ip);
  if (held?.method !== METHODS.GUEST) {
    throw new Error("passport bind must leave the guest seat in place");
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

  const gameF = await engine.createGame({
    config: lobbyConfig,
    allowParallelLobbies: true
  });
  const sqlite3 = require("sqlite3");
  const { open } = require("sqlite");
  const legacy = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await legacy.run(
    `INSERT INTO game_ip_login_methods (game_id, ip, method) VALUES (?, ?, ?)`,
    [gameF.id, ip, METHODS.RODIT_ED25519]
  );
  await legacy.close();
  r = await repo.bindGameIpLoginMethod({
    gameId: gameF.id,
    ip,
    method: METHODS.GUEST,
    ttlMs: shortTtlMs
  });
  if (!r.ok || r.lockedMethod !== METHODS.GUEST) {
    throw new Error("legacy passport row must not block the one guest seat");
  }

  console.log("ok: one guest seat per IP per game; passport joins are not IP-limited");
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
