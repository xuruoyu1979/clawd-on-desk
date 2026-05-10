"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { fileURLToPath } = require("url");

const {
  AGENT_ICON_DIR,
  getAgentIconPath,
  getAgentIcon,
  getAgentIconUrl,
} = require("../src/state-agent-icons");

describe("state agent icons", () => {
  it("returns undefined for BrowserWindow menu icons when nativeImage is unavailable", () => {
    assert.strictEqual(getAgentIcon("claude-code"), undefined);
  });

  it("returns null for missing agent ids and icons", () => {
    assert.strictEqual(getAgentIconUrl(null), null);
    assert.strictEqual(getAgentIconUrl(""), null);
    assert.strictEqual(getAgentIconUrl("missing-agent"), null);
    assert.strictEqual(getAgentIconUrl("../claude-code"), null);
  });

  it("returns a file URL for bundled agent icons", () => {
    const iconUrl = getAgentIconUrl("claude-code");

    assert.strictEqual(new URL(iconUrl).protocol, "file:");
    assert.strictEqual(
      path.normalize(fileURLToPath(iconUrl)),
      path.join(AGENT_ICON_DIR, "claude-code.png")
    );
  });

  it("supports bundled SVG agent icons", () => {
    const iconUrl = getAgentIconUrl("pi");

    assert.strictEqual(new URL(iconUrl).protocol, "file:");
    assert.strictEqual(
      path.normalize(fileURLToPath(iconUrl)),
      path.join(AGENT_ICON_DIR, "pi.svg")
    );
    assert.strictEqual(getAgentIconPath("pi"), path.join(AGENT_ICON_DIR, "pi.svg"));
  });

  it("returns the cached URL value for repeated lookups", () => {
    const first = getAgentIconUrl("codex");
    const second = getAgentIconUrl("codex");

    assert.strictEqual(second, first);
  });
});
