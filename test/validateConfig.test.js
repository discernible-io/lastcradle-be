// Copyright (c) 2026 Discernible, Inc. All rights reserved.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validateConfig, logger } = require("@rodit/rodit-auth-be");

describe("SDK validateConfig", () => {
  it("passes against current resolved configuration", () => {
    assert.equal(validateConfig(logger), true);
  });
});
