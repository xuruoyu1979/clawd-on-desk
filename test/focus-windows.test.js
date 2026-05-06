"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

function loadFocusWithMock(options = {}) {
  const cpKey = require.resolve("child_process");
  const focusKey = require.resolve("../src/focus");
  const origCp = require.cache[cpKey];
  const origFocus = require.cache[focusKey];
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const realCp = require("child_process");
  const execFile = options.execFile || ((_cmd, _args, opts, cb) => {
    if (typeof opts === "function") cb = opts;
    if (cb) cb(null, "", "");
  });
  const spawn = options.spawn || (() => ({
    pid: 4242,
    stdin: {
      writable: true,
      write() {},
      on() {},
    },
    on() {},
    unref() {},
    kill() {},
  }));

  require.cache[cpKey] = {
    id: cpKey,
    filename: cpKey,
    loaded: true,
    exports: { ...realCp, execFile, spawn },
  };
  Object.defineProperty(process, "platform", {
    ...origPlatform,
    value: options.platform || "win32",
  });
  delete require.cache[focusKey];

  let initFocus;
  try {
    initFocus = require("../src/focus");
  } finally {
    Object.defineProperty(process, "platform", origPlatform);
  }

  if (origCp) require.cache[cpKey] = origCp;
  else delete require.cache[cpKey];

  return {
    initFocus,
    cleanup: () => {
      if (origFocus) require.cache[focusKey] = origFocus;
      else delete require.cache[focusKey];
    },
  };
}

describe("Windows terminal focus", () => {
  it("does not generate the blind first-WindowsTerminal fallback", () => {
    const { initFocus, cleanup } = loadFocusWithMock();
    try {
      const focus = initFocus({});
      const cmd = focus.__test.makeFocusCmd(1234, ["repo"]);

      assert.match(cmd, /Get-Process -Name 'WindowsTerminal'/);
      assert.doesNotMatch(cmd, /Select-Object -First 1/);
    } finally {
      cleanup();
    }
  });

  it("accepts options-object requests and redacts full cwd in focus logs", () => {
    const execCalls = [];
    const writes = [];
    const logs = [];
    const { initFocus, cleanup } = loadFocusWithMock({
      execFile: (cmd, args, opts, cb) => {
        if (typeof opts === "function") cb = opts;
        execCalls.push({ cmd, args: [...args] });
        if (cb) cb(null, "", "");
      },
      spawn: () => ({
        pid: 9999,
        stdin: {
          writable: true,
          write: (chunk) => writes.push(String(chunk)),
          on() {},
        },
        on() {},
        unref() {},
        kill() {},
      }),
    });

    try {
      const focus = initFocus({ focusLog: (msg) => logs.push(msg) });
      focus.focusTerminalWindow({
        sourcePid: 1234,
        cwd: "C:\\Users\\SecretUser\\project-a",
        editor: null,
        pidChain: [1234, 5678],
        sessionId: "session-1",
        agentId: "claude-code",
        requestSource: "hud",
      });

      assert.strictEqual(execCalls[0].cmd, "powershell.exe");
      assert.ok(writes.length > 0, "fallback should reinitialize the persistent helper");
      const joined = logs.join("\n");
      assert.match(joined, /focus request/);
      assert.match(joined, /source=hud/);
      assert.match(joined, /sid=session-1/);
      assert.match(joined, /agent=claude-code/);
      assert.match(joined, /sourcePid=1234/);
      assert.match(joined, /cwdTail=\.\.\.\\project-a/);
      assert.match(joined, /cwdHash=[0-9a-f]{8}/);
      assert.match(joined, /chain=\[1234>5678\]/);
      assert.match(joined, /focus result branch=windows-command-submitted/);
      assert.ok(!joined.includes("C:\\Users\\SecretUser"), "full cwd must not be logged");
      assert.ok(!joined.includes("SecretUser"), "username must not be logged through cwd tail");
    } finally {
      cleanup();
    }
  });

  it("keeps old positional focus requests compatible", () => {
    const execCalls = [];
    const { initFocus, cleanup } = loadFocusWithMock({
      execFile: (cmd, args, opts, cb) => {
        if (typeof opts === "function") cb = opts;
        execCalls.push({ cmd, args: [...args] });
        if (cb) cb(null, "", "");
      },
    });

    try {
      const focus = initFocus({});
      focus.focusTerminalWindow(2345, "D:\\work\\repo-b", null, [2345]);

      assert.strictEqual(execCalls.length, 1);
      assert.strictEqual(execCalls[0].cmd, "powershell.exe");
      assert.ok(execCalls[0].args.some((arg) => typeof arg === "string" && arg.includes("$curPid = 2345")));
    } finally {
      cleanup();
    }
  });
});

