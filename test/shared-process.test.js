// test/shared-process.test.js — Unit tests for hooks/shared-process.js
const { describe, it, beforeEach, mock } = require("node:test");
const assert = require("node:assert");

const {
  getPlatformConfig,
  createPidResolver,
  readStdinJson,
  buildElectronLaunchConfig,
} = require("../hooks/shared-process");

// ═════════════════════════════════════════════════════════════════════════════
// getPlatformConfig()
// ═════════════════════════════════════════════════════════════════════════════

describe("getPlatformConfig()", () => {
  it("returns terminalNames, systemBoundary, editorMap, editorPathChecks", () => {
    const cfg = getPlatformConfig();
    assert.ok(cfg.terminalNames instanceof Set);
    assert.ok(cfg.systemBoundary instanceof Set);
    assert.ok(typeof cfg.editorMap === "object");
    assert.ok(Array.isArray(cfg.editorPathChecks));
  });

  it("base terminal names include common terminals", () => {
    const cfg = getPlatformConfig();
    // At least one terminal should be present regardless of platform
    const all = [...cfg.terminalNames];
    assert.ok(all.length > 5, "should have several terminals");
  });

  it("merges extraTerminals into base set", () => {
    const cfg = getPlatformConfig({
      extraTerminals: { win: ["custom.exe"], mac: ["custom"], linux: ["custom"] },
    });
    // The extra should be present (exact key depends on platform)
    const isWin = process.platform === "win32";
    const isLinux = process.platform === "linux";
    if (isWin) assert.ok(cfg.terminalNames.has("custom.exe"));
    else if (isLinux) assert.ok(cfg.terminalNames.has("custom"));
    else assert.ok(cfg.terminalNames.has("custom"));
  });

  it("merges extraEditors into base map", () => {
    const cfg = getPlatformConfig({
      extraEditors: { win: { "foo.exe": "foo" }, mac: { "foo": "foo" }, linux: { "foo": "foo" } },
    });
    // Base editors should still be present
    const isWin = process.platform === "win32";
    if (isWin) {
      assert.strictEqual(cfg.editorMap["code.exe"], "code");
      assert.strictEqual(cfg.editorMap["foo.exe"], "foo");
    } else {
      assert.strictEqual(cfg.editorMap["code"], "code");
      assert.strictEqual(cfg.editorMap["foo"], "foo");
    }
  });

  it("prepends extraEditorPathChecks before defaults", () => {
    const cfg = getPlatformConfig({
      extraEditorPathChecks: [["myeditor", "mine"]],
    });
    assert.deepStrictEqual(cfg.editorPathChecks[0], ["myeditor", "mine"]);
    // Default checks still present after
    assert.ok(cfg.editorPathChecks.some(([p]) => p === "visual studio code"));
  });

  it("returns defaults when no options given", () => {
    const cfg = getPlatformConfig();
    assert.ok(cfg.editorPathChecks.length === 2); // visual studio code + cursor.app
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// createPidResolver() — factory + caching behavior
// ═════════════════════════════════════════════════════════════════════════════

describe("createPidResolver()", () => {
  it("returns a function", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg });
    assert.strictEqual(typeof resolve, "function");
  });

  it("caches result after first call", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: process.pid });
    const r1 = resolve();
    const r2 = resolve();
    assert.strictEqual(r1, r2, "should return same object reference");
  });

  it("result has expected shape", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: process.pid });
    const result = resolve();
    assert.ok("stablePid" in result);
    assert.ok("agentPid" in result);
    assert.ok("detectedEditor" in result);
    assert.ok(Array.isArray(result.pidChain));
  });

  it("walks from startPid and populates pidChain", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: process.pid });
    const { pidChain } = resolve();
    // pidChain should contain at least the start PID (our own process)
    assert.ok(pidChain.length >= 1);
    assert.ok(pidChain.includes(process.pid));
  });

  it("respects maxDepth", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: process.pid, maxDepth: 1 });
    const { pidChain } = resolve();
    assert.ok(pidChain.length <= 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// buildElectronLaunchConfig()
// ═════════════════════════════════════════════════════════════════════════════

describe("buildElectronLaunchConfig()", () => {
  it("strips ELECTRON_RUN_AS_NODE and preserves forwarded args", () => {
    const sourceEnv = {
      ELECTRON_RUN_AS_NODE: "1",
      CLAWD_DISABLE_SANDBOX: "0",
      KEEP_ME: "yes",
    };

    const cfg = buildElectronLaunchConfig("D:\\app", {
      platform: "win32",
      env: sourceEnv,
      forwardedArgs: ["--register-protocol"],
    });

    assert.deepStrictEqual(cfg.args, [".", "--register-protocol"]);
    assert.strictEqual(cfg.cwd, "D:\\app");
    assert.strictEqual(cfg.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.strictEqual(cfg.env.KEEP_ME, "yes");
    assert.strictEqual(sourceEnv.ELECTRON_RUN_AS_NODE, "1");
  });

  it("keeps the Linux sandbox fallback when requested", () => {
    const cfg = buildElectronLaunchConfig("/app", {
      platform: "linux",
      env: {
        CLAWD_DISABLE_SANDBOX: "1",
        ELECTRON_RUN_AS_NODE: "1",
      },
      forwardedArgs: ["--foo"],
    });

    assert.deepStrictEqual(cfg.args, [".", "--no-sandbox", "--disable-setuid-sandbox", "--foo"]);
    assert.strictEqual(cfg.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.strictEqual(cfg.env.ELECTRON_DISABLE_SANDBOX, "1");
    assert.strictEqual(cfg.env.CHROME_DEVEL_SANDBOX, "");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// createPidResolver() — Windows PowerShell / Get-CimInstance path (win32 only)
// ═════════════════════════════════════════════════════════════════════════════

describe("createPidResolver() — Windows PowerShell path", { skip: process.platform !== "win32" }, () => {
  const childProcess = require("child_process");

  function withMockedExec(mockFn, cb) {
    const orig = childProcess.execFileSync;
    childProcess.execFileSync = mockFn;
    try { cb(); } finally { childProcess.execFileSync = orig; }
  }

  function psJson(name, parentPid) {
    return JSON.stringify({ Name: name, ParentProcessId: parentPid });
  }

  it("populates pidChain by walking PS JSON output", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: 1000 });
    withMockedExec((_cmd, args) => {
      if (args[3].includes("ProcessId=1000")) return psJson("cmd.exe", 1001);
      if (args[3].includes("ProcessId=1001")) return psJson("explorer.exe", 0);
      return "";
    }, () => {
      const { pidChain } = resolve();
      assert.ok(pidChain.includes(1000));
      assert.ok(pidChain.includes(1001));
    });
  });

  it("breaks the walk immediately when PS returns empty (process not found)", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: 9999 });
    withMockedExec(() => "", () => {
      const { pidChain } = resolve();
      assert.strictEqual(pidChain.length, 0);
    });
  });

  it("breaks the walk cleanly when ConvertTo-Json outputs 'null'", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: 9000 });
    withMockedExec(() => "null", () => {
      const { pidChain } = resolve();
      assert.strictEqual(pidChain.length, 0, "'null' PS output must abort the walk");
    });
  });

  it("sets stablePid to the terminal PID when a terminal process is found", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: 500 });
    withMockedExec((_cmd, args) => {
      if (args[3].includes("ProcessId=500")) return psJson("windowsterminal.exe", 0);
      return "";
    }, () => {
      const { stablePid } = resolve();
      assert.strictEqual(stablePid, 500);
    });
  });

  it("detects editor from process name", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: 200 });
    withMockedExec((_cmd, args) => {
      if (args[3].includes("ProcessId=200")) return psJson("code.exe", 0);
      return "";
    }, () => {
      const { detectedEditor } = resolve();
      assert.strictEqual(detectedEditor, "code");
    });
  });

  it("stops the walk at a system boundary process (explorer.exe)", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({ platformConfig: cfg, startPid: 300 });
    let callCount = 0;
    withMockedExec(() => {
      callCount++;
      if (callCount === 1) return psJson("cmd.exe", 301);
      if (callCount === 2) return psJson("explorer.exe", 0);
      return psJson("unreachable.exe", 0);
    }, () => {
      resolve();
      assert.strictEqual(callCount, 2, "must stop at system boundary");
    });
  });

  it("detects agentPid when agentNameSet matches a process name", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({
      platformConfig: cfg,
      startPid: 400,
      agentNames: { win: new Set(["claude.exe"]), mac: new Set(["claude"]) },
    });
    withMockedExec((_cmd, args) => {
      if (args[3].includes("ProcessId=400")) return psJson("node.exe", 401);
      if (args[3].includes("ProcessId=401")) return psJson("claude.exe", 0);
      return "";
    }, () => {
      const { agentPid } = resolve();
      assert.strictEqual(agentPid, 401);
    });
  });

  it("detects agentPid via agentCmdlineCheck on node.exe", () => {
    const cfg = getPlatformConfig();
    const resolve = createPidResolver({
      platformConfig: cfg,
      startPid: 600,
      agentCmdlineCheck: (cmdline) => cmdline.includes("claude-code"),
    });
    withMockedExec((_cmd, args) => {
      const command = args[3];
      if (command.includes("Select-Object")) {
        if (command.includes("ProcessId=600")) return psJson("node.exe", 0);
        return "";
      }
      return "node C:\\Users\\x\\AppData\\Local\\claude-code\\index.js";
    }, () => {
      const { agentPid } = resolve();
      assert.strictEqual(agentPid, 600);
    });
  });
});

// readStdinJson() is not unit-tested here — it attaches listeners to
// process.stdin (singleton) which prevents process exit. Validated by
// real agent integration tests + the finishOnce/timeout logic is trivial.
