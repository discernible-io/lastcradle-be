#!/usr/bin/env node
/**
 * URL-join (non-passport) helpers: guest rodit ids, webhook persistence, contest gate.
 */

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "url-join-test.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

process.env.NODE_CONFIG_ENV = "development";
process.env.NODE_CONFIG_DIR = path.join(__dirname, "..", "config");
process.env.API_DEFAULT_OPTIONS_DB_PATH = DB_PATH;

const express = require("express");
const {
  extractPeerSubjectId,
  isUrlJoinRoditId,
  roditIdFromUser,
  canonicalRoditId
} = require("../src/game/rodit-id");
const {
  validateWebhookUrl,
  lookupUrlJoinWebhookUrl,
  installUrlJoinIdentitySupport
} = require("../src/game/url-join-identity");
const repo = require("../src/game/repository");
const engine = require("../src/game/engine");
const orchestrator = require("../src/game/contest-orchestrator");
const spectatorRoutes = require("../src/game/spectator-routes");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function requestJson(port, method, urlPath, { body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, body: json };
}

async function main() {
  installUrlJoinIdentitySupport();
  await repo.initializeDatabase();

  const guestId = "guest_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  assert(isUrlJoinRoditId(guestId), "guest ulid id should match");
  assert(!isUrlJoinRoditId("lflvlnbrsfcq"), "passport id is not url-join");

  const compound = `bc=near.org;sc=x.near;id=abcdefghijkl;sub=${guestId}`;
  assert(extractPeerSubjectId(compound) === guestId, "extract guest from compound sub");
  assert(canonicalRoditId(compound) === guestId, "canonical guest id");
  assert(
    roditIdFromUser({
      sub: compound,
      rodit_id: "ServerToknId",
      rodit_webhookurl: "https://agent.example/hooks/wake"
    }) === guestId,
    "roditIdFromUser prefers guest sub over server rodit_id"
  );

  assert(
    validateWebhookUrl("https://agent.example:9443/hooks/wake") ===
      "https://agent.example:9443/hooks/wake",
    "https webhook accepted"
  );
  try {
    validateWebhookUrl("not-a-url");
    throw new Error("expected INVALID_WEBHOOK_URL");
  } catch (err) {
    assert(err.code === "INVALID_WEBHOOK_URL", "invalid url rejected");
  }

  const blocked = [
    "https://127.0.0.1:8443/",
    "https://localhost:8443/",
    "https://10.0.0.5/hook",
    "https://192.168.1.1/hook",
    "https://169.254.169.254/latest/meta-data/",
    "https://user:pass@agent.example/hooks/wake"
  ];
  for (const url of blocked) {
    try {
      validateWebhookUrl(url);
      throw new Error(`expected block for ${url}`);
    } catch (err) {
      assert(err.code === "INVALID_WEBHOOK_URL", `blocked ${url}`);
    }
  }

  await repo.insertUrlJoinIdentity({
    roditId: guestId,
    ownerId: "ab".repeat(32),
    webhookUrl: "https://agent.example/hooks/wake",
    displayName: "UrlBot",
    notAfter: new Date(Date.now() + 86400000).toISOString(),
    notBefore: new Date().toISOString(),
    maxRequests: "1000",
    maxrqWindow: "3600",
    jwtDuration: "3600",
    subjectuniqueidentifierUrl: "https://slcapi.example",
    serviceproviderId: "bc=near.org;sc=x.near;id=abcdefghijkl",
    serviceproviderSignature: "dGVzdA"
  });

  const storedUrl = await lookupUrlJoinWebhookUrl(guestId);
  assert(storedUrl === "https://agent.example/hooks/wake", "url-join webhook lookup");

  const game = await engine.createGame({
    config: { minAgents: 1, maxAgents: 4, joiningWindowDurationMs: 60_000 },
    allowParallelLobbies: true
  });
  const agent = await engine.joinGame(game.id, {
    roditId: guestId,
    displayName: "UrlBot"
  });
  assert(agent.roditId === guestId, "cradle keyed by guest id");
  assert(agent.productionCapacity?.energy > 0, "cradle assigned");

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.requestId = "test-url-join";
    next();
  });
  app.use("/api/game", spectatorRoutes);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = server.address().port;
  let definitiveId = null;

  try {
    const definitive = await engine.createGame({
      config: {
        minAgents: 1,
        maxAgents: 4,
        joiningWindowDurationMs: 60_000,
        contestMode: "definitive"
      },
      allowParallelLobbies: true
    });
    definitiveId = definitive.id;
    orchestrator.registerLobbyGame(definitive);

    const blocked = await requestJson(port, "POST", `/api/game/games/${definitive.id}/join-by-url`, {
      body: { webhookUrl: "https://agent.example/hooks/wake", displayName: "Nope" }
    });
    assert(blocked.status === 403, `definitive url-join should 403, got ${blocked.status}`);
    assert(
      blocked.body.error?.code === "URL_JOIN_NOT_ALLOWED",
      `URL_JOIN_NOT_ALLOWED code, got ${JSON.stringify(blocked.body)}`
    );

    const badUrl = await requestJson(port, "POST", `/api/game/games/${game.id}/join-by-url`, {
      body: { webhookUrl: "ftp://nope" }
    });
    assert(badUrl.status === 400, `bad webhook should 400, got ${badUrl.status}`);
    assert(
      badUrl.body.error?.code === "INVALID_WEBHOOK_URL",
      `INVALID_WEBHOOK_URL code, got ${JSON.stringify(badUrl.body)}`
    );

    console.log("URL-join unit checks passed (JWT mint requires live server RODiT; skipped here).");
  } finally {
    if (definitiveId) {
      orchestrator.unregisterLobbyGame(definitiveId);
    }
    await new Promise((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 500);
    });
    await repo.closeDatabase();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
