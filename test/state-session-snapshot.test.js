"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  deriveSessionBadge,
  buildSessionSnapshot,
  getActiveSessionAliasKeys,
  sessionSnapshotSignature,
} = require("../src/state-session-snapshot");

const STATE_PRIORITY = {
  error: 8,
  notification: 7,
  sweeping: 6,
  attention: 5,
  carrying: 4,
  juggling: 4,
  working: 3,
  thinking: 2,
  idle: 1,
  sleeping: 0,
};

function session(state, overrides = {}) {
  return {
    state,
    updatedAt: 1000,
    cwd: "",
    agentId: "claude-code",
    recentEvents: [],
    ...overrides,
  };
}

describe("state-session-snapshot badges", () => {
  it("derives running, done, interrupted, and idle badges", () => {
    assert.strictEqual(deriveSessionBadge(session("working")), "running");
    assert.strictEqual(deriveSessionBadge(session("sleeping")), "idle");
    assert.strictEqual(deriveSessionBadge(session("idle", {
      recentEvents: [{ event: "Stop", state: "idle", at: 1 }],
    })), "done");
    assert.strictEqual(deriveSessionBadge(session("idle", {
      recentEvents: [{ event: "PostToolUseFailure", state: "idle", at: 1 }],
    })), "interrupted");
    assert.strictEqual(deriveSessionBadge(null), "idle");
  });
});

describe("state-session-snapshot builder", () => {
  it("builds ordered dashboard/menu groups and HUD summary with injected deps", () => {
    const sessions = new Map([
      ["old-working", session("working", {
        updatedAt: 1000,
        cwd: "/tmp/old-project",
        sessionTitle: "Fix login",
        recentEvents: [{ event: "PreToolUse", state: "working", at: 900 }],
      })],
      ["latest-remote", session("idle", {
        updatedAt: 3000,
        cwd: "/tmp/latest-project",
        agentId: "codex",
        host: "remote-box",
        headless: true,
        recentEvents: [{ event: "MysteryEvent", state: "idle", at: 2900 }],
      })],
      ["error-local", session("error", {
        updatedAt: 2000,
        cwd: "/tmp/error-project",
        agentId: "missing-agent",
      })],
    ]);

    const snapshot = buildSessionSnapshot(sessions, {
      statePriority: STATE_PRIORITY,
      getAgentIconUrl: (agentId) => agentId === "missing-agent" ? null : `icon:${agentId}`,
    });

    assert.deepStrictEqual(snapshot.orderedIds, ["latest-remote", "error-local", "old-working"]);
    assert.deepStrictEqual(snapshot.menuOrderedIds, ["error-local", "old-working", "latest-remote"]);
    assert.deepStrictEqual(snapshot.groups, [
      { host: "", ids: ["error-local", "old-working"] },
      { host: "remote-box", ids: ["latest-remote"] },
    ]);
    assert.strictEqual(snapshot.hudTotalNonIdle, 2);
    assert.strictEqual(snapshot.hudLastSessionId, "error-local");
    assert.strictEqual(snapshot.hudLastTitle, "error-project");
    assert.strictEqual(snapshot.lastSessionId, "latest-remote");
    assert.strictEqual(snapshot.lastTitle, "latest-project");

    const oldWorking = snapshot.sessions.find((entry) => entry.id === "old-working");
    assert.strictEqual(oldWorking.badge, "running");
    assert.strictEqual(oldWorking.iconUrl, "icon:claude-code");
    assert.strictEqual(oldWorking.sessionTitle, "Fix login");
    assert.strictEqual(oldWorking.displayTitle, "Fix login");
    assert.deepStrictEqual(oldWorking.lastEvent, {
      labelKey: "eventLabelPreToolUse",
      rawEvent: "PreToolUse",
      at: 900,
    });

    const latestRemote = snapshot.sessions.find((entry) => entry.id === "latest-remote");
    assert.strictEqual(latestRemote.headless, true);
    assert.strictEqual(latestRemote.displayTitle, "latest-project");
    assert.deepStrictEqual(latestRemote.lastEvent, {
      labelKey: null,
      rawEvent: "MysteryEvent",
      at: 2900,
    });
  });

  it("applies aliases, Codex thread names, and Kiro cwd-scoped alias keys", () => {
    const sessions = new Map([
      ["claude-local", session("working", {
        updatedAt: 3000,
        cwd: "/repo/a",
        agentId: "claude-code",
        sessionTitle: "Raw title",
      })],
      ["codex:abc", session("thinking", {
        updatedAt: 2000,
        cwd: "/repo/b",
        agentId: "codex",
        sessionTitle: "Auto Summary",
      })],
      ["default", session("working", {
        updatedAt: 1000,
        cwd: "/repo/c",
        agentId: "kiro-cli",
      })],
    ]);

    const snapshot = buildSessionSnapshot(sessions, {
      statePriority: STATE_PRIORITY,
      sessionAliases: {
        "local|claude-code|claude-local": { title: "Claude review", updatedAt: 100 },
        "local|kiro-cli|default": { title: "Legacy Kiro", updatedAt: 100 },
        "local|kiro-cli|default|cwd:%2Frepo%2Fc": { title: "Kiro repo C", updatedAt: 200 },
      },
      readCodexThreadName: (id) => id === "codex:abc" ? "Thread name" : null,
    });

    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === "claude-local").displayTitle, "Claude review");
    const codex = snapshot.sessions.find((entry) => entry.id === "codex:abc");
    assert.strictEqual(codex.sessionTitle, "Thread name");
    assert.strictEqual(codex.displayTitle, "Thread name");
    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === "default").displayTitle, "Kiro repo C");

    assert.deepStrictEqual(
      [...getActiveSessionAliasKeys(sessions)].sort(),
      [
        "local|claude-code|claude-local",
        "local|codex|codex:abc",
        "local|kiro-cli|default|cwd:%2Frepo%2Fc",
      ].sort()
    );
  });

  it("marks detached ended idle sessions hidden from HUD only when cleanup is enabled and pid is dead", () => {
    const sessions = new Map([
      ["done-local", session("idle", {
        updatedAt: 3000,
        sourcePid: 9999,
        pidReachable: true,
        recentEvents: [{ event: "Stop", state: "attention", at: 2900 }],
      })],
      ["idle-local", session("idle", {
        updatedAt: 2000,
        sourcePid: 9998,
        pidReachable: true,
        recentEvents: [{ event: "AfterAgent", state: "idle", at: 1900 }],
      })],
    ]);

    const snapshot = buildSessionSnapshot(sessions, {
      statePriority: STATE_PRIORITY,
      sessionHudCleanupDetached: true,
      isProcessAlive: () => false,
    });

    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === "done-local").hiddenFromHud, true);
    assert.strictEqual(snapshot.sessions.find((entry) => entry.id === "idle-local").hiddenFromHud, false);
    assert.strictEqual(snapshot.hudTotalNonIdle, 1);
    assert.strictEqual(snapshot.hudLastSessionId, "idle-local");
  });

  it("snapshot signatures include visible fields but ignore icon URL churn", () => {
    const base = buildSessionSnapshot(new Map([
      ["s1", session("working", {
        updatedAt: 1000,
        sessionTitle: "Title",
        recentEvents: [{ event: "PreToolUse", state: "working", at: 900 }],
      })],
    ]), {
      statePriority: STATE_PRIORITY,
      getAgentIconUrl: () => "icon:a",
    });
    const sameExceptIcon = buildSessionSnapshot(new Map([
      ["s1", session("working", {
        updatedAt: 1000,
        sessionTitle: "Title",
        recentEvents: [{ event: "PreToolUse", state: "working", at: 900 }],
      })],
    ]), {
      statePriority: STATE_PRIORITY,
      getAgentIconUrl: () => "icon:b",
    });
    const differentTitle = buildSessionSnapshot(new Map([
      ["s1", session("working", {
        updatedAt: 1000,
        sessionTitle: "Other title",
        recentEvents: [{ event: "PreToolUse", state: "working", at: 900 }],
      })],
    ]), {
      statePriority: STATE_PRIORITY,
      getAgentIconUrl: () => "icon:a",
    });

    assert.strictEqual(sessionSnapshotSignature(base), sessionSnapshotSignature(sameExceptIcon));
    assert.notStrictEqual(sessionSnapshotSignature(base), sessionSnapshotSignature(differentTitle));
  });
});
