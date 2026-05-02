const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { spawnSync } = require("child_process");
const { __test } = require("../hooks/gemini-hook");

function runGeminiHook(argvEvent, payload = {}) {
  const scriptPath = path.resolve(__dirname, "..", "hooks", "gemini-hook.js");
  return spawnSync(process.execPath, [scriptPath, argvEvent], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
  });
}

describe("Gemini hook script", () => {
  it("writes only allow JSON for BeforeTool", () => {
    const result = runGeminiHook("BeforeTool", { session_id: "s1" });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stderr, "");
    assert.strictEqual(result.stdout.trim(), JSON.stringify({ decision: "allow" }));
  });

  it("uses argv event name when hook_event_name is absent", () => {
    const result = runGeminiHook("AfterTool", { session_id: "s1", cwd: process.cwd() });

    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), { decision: "allow" });
  });

  it("writes empty JSON for passive lifecycle hooks", () => {
    const result = runGeminiHook("AfterAgent", { session_id: "s1" });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stderr, "");
    assert.strictEqual(result.stdout.trim(), "{}");
  });

  it("prefers payload hook_event_name over argv event name", () => {
    const result = runGeminiHook("BeforeTool", {
      hook_event_name: "AfterAgent",
      session_id: "s1",
    });

    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), {});
  });

  it("posts PID metadata on SessionStart", async () => {
    const postedBodies = [];
    let resolveCalls = 0;
    const result = await __test.sendHookEvent({
      session_id: "s1",
      cwd: process.cwd(),
    }, "SessionStart", {
      env: {},
      resolvePid: () => {
        resolveCalls++;
        return {
          stablePid: 4242,
          agentPid: 4343,
          detectedEditor: "code",
          pidChain: [4343, 4242],
        };
      },
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.strictEqual(resolveCalls, 1);
    assert.strictEqual(result.posted, true);
    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].agent_id, "gemini-cli");
    assert.strictEqual(postedBodies[0].event, "SessionStart");
    assert.strictEqual(postedBodies[0].cwd, process.cwd());
    assert.strictEqual(postedBodies[0].source_pid, 4242);
    assert.strictEqual(postedBodies[0].agent_pid, 4343);
    assert.strictEqual(postedBodies[0].editor, "code");
    assert.deepStrictEqual(postedBodies[0].pid_chain, [4343, 4242]);
  });

  it("does not post PID metadata on non-SessionStart events", async () => {
    const postedBodies = [];
    let resolveCalls = 0;
    const result = await __test.sendHookEvent({
      session_id: "s1",
      cwd: process.cwd(),
    }, "BeforeTool", {
      env: {},
      resolvePid: () => {
        resolveCalls++;
        return {
          stablePid: 4242,
          agentPid: 4343,
          detectedEditor: "code",
          pidChain: [4343, 4242],
        };
      },
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.strictEqual(resolveCalls, 0);
    assert.deepStrictEqual(result.stdout, JSON.stringify({ decision: "allow" }));
    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].agent_id, "gemini-cli");
    assert.strictEqual(postedBodies[0].event, "PreToolUse");
    assert.strictEqual(postedBodies[0].cwd, process.cwd());
    assert.ok(!Object.prototype.hasOwnProperty.call(postedBodies[0], "source_pid"));
    assert.ok(!Object.prototype.hasOwnProperty.call(postedBodies[0], "agent_pid"));
    assert.ok(!Object.prototype.hasOwnProperty.call(postedBodies[0], "pid_chain"));
    assert.ok(!Object.prototype.hasOwnProperty.call(postedBodies[0], "editor"));
  });

  it("posts host instead of local PID metadata in remote mode", async () => {
    const postedBodies = [];
    let resolveCalls = 0;
    const result = await __test.sendHookEvent({
      session_id: "s1",
      cwd: process.cwd(),
    }, "AfterAgent", {
      env: { CLAWD_REMOTE: "1" },
      readHostPrefix: () => "remote-host",
      resolvePid: () => {
        resolveCalls++;
        return { stablePid: 4242, pidChain: [4242] };
      },
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.strictEqual(resolveCalls, 0);
    assert.deepStrictEqual(result.stdout, "{}");
    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].agent_id, "gemini-cli");
    assert.strictEqual(postedBodies[0].event, "AfterAgent");
    assert.strictEqual(postedBodies[0].host, "remote-host");
    assert.ok(!Object.prototype.hasOwnProperty.call(postedBodies[0], "source_pid"));
  });

  it("keeps Gemini AfterAgent as a neutral event instead of Stop/attention", async () => {
    const postedBodies = [];
    const result = await __test.sendHookEvent({
      session_id: "s1",
      cwd: process.cwd(),
    }, "AfterAgent", {
      env: {},
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.deepStrictEqual(result.stdout, "{}");
    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].state, "idle");
    assert.strictEqual(postedBodies[0].event, "AfterAgent");
  });

  it("keeps Gemini PreCompress visible without remapping to PreCompact/sweeping", async () => {
    const postedBodies = [];
    const result = await __test.sendHookEvent({
      session_id: "s1",
      cwd: process.cwd(),
    }, "PreCompress", {
      env: {},
      postState: (body, _options, callback) => {
        postedBodies.push(JSON.parse(body));
        callback(true, 23333);
      },
    });

    assert.deepStrictEqual(result.stdout, "{}");
    assert.strictEqual(postedBodies.length, 1);
    assert.strictEqual(postedBodies[0].state, "idle");
    assert.strictEqual(postedBodies[0].event, "PreCompress");
  });
});
