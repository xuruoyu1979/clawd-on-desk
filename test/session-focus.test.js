"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  getFocusableLocalHudSessionIds,
  isFocusableLocalHudSession,
} = require("../src/session-focus");

describe("session focus helpers", () => {
  it("selects only local HUD-visible sessions with a terminal pid", () => {
    const snapshot = {
      sessions: [
        { id: "local", sourcePid: 1000, state: "working" },
        { id: "no-pid", sourcePid: null, state: "working" },
        { id: "headless", sourcePid: 1001, headless: true, state: "working" },
        { id: "sleeping", sourcePid: 1002, state: "sleeping" },
        { id: "hidden", sourcePid: 1003, state: "idle", hiddenFromHud: true },
        { id: "remote", sourcePid: 1004, state: "working", host: "remote-box" },
      ],
    };

    assert.deepStrictEqual(getFocusableLocalHudSessionIds(snapshot), ["local"]);
  });

  it("rejects malformed entries defensively", () => {
    assert.strictEqual(isFocusableLocalHudSession(null), false);
    assert.strictEqual(isFocusableLocalHudSession({ sourcePid: 1 }), false);
    assert.deepStrictEqual(getFocusableLocalHudSessionIds({ sessions: "bad" }), []);
    assert.deepStrictEqual(getFocusableLocalHudSessionIds(null), []);
  });
});
