#!/usr/bin/env node
// Copyright (c) 2026 Discernible, Inc. All rights reserved.
// Discover test/*.test.js without relying on shell glob expansion (CI-safe).

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const testDir = path.join(__dirname, "..", "test");
const files = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => path.join(testDir, name))
  .sort();

if (files.length === 0) {
  console.error(`No *.test.js files found in ${testDir}`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", ...files],
  { stdio: "inherit", env: process.env }
);

process.exit(result.status === null ? 1 : result.status);
