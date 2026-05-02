const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { spawnSync } = require("child_process");

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
});
