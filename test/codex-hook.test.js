const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("child_process");
const path = require("path");
const {
  buildCodexNoDecisionOutput,
  buildCodexPermissionOutput,
  buildPermissionBody,
  buildStateBody,
  buildToolInputFingerprint,
  normalizeCodexSessionId,
  sanitizeCodexPermissionOutput,
} = require("../hooks/codex-hook");

const mockResolve = () => ({
  stablePid: 123,
  agentPid: 456,
  detectedEditor: "code",
  pidChain: [789, 456, 123],
});

describe("Codex official hook", () => {
  it("normalizes session ids with the codex prefix", () => {
    assert.strictEqual(normalizeCodexSessionId("abc"), "codex:abc");
    assert.strictEqual(normalizeCodexSessionId("codex:abc"), "codex:abc");
    assert.strictEqual(normalizeCodexSessionId(""), "codex:default");
  });

  it("builds SessionStart state payloads", () => {
    const body = buildStateBody({
      hook_event_name: "SessionStart",
      session_id: "s1",
      cwd: "/repo",
      turn_id: "turn-1",
      permission_mode: "default",
      transcript_path: "/tmp/rollout.jsonl",
      model: "gpt-5.2-codex",
    }, mockResolve);

    assert.strictEqual(body.state, "idle");
    assert.strictEqual(body.session_id, "codex:s1");
    assert.strictEqual(body.agent_id, "codex");
    assert.strictEqual(body.hook_source, "codex-official");
    assert.strictEqual(body.event, "SessionStart");
    assert.strictEqual(body.cwd, "/repo");
    assert.strictEqual(body.turn_id, "turn-1");
    assert.strictEqual(body.permission_mode, "default");
    assert.strictEqual(body.transcript_path, "/tmp/rollout.jsonl");
    assert.strictEqual(body.model, "gpt-5.2-codex");
    assert.strictEqual(body.source_pid, 123);
    assert.strictEqual(body.agent_pid, 456);
    assert.strictEqual(body.editor, "code");
    assert.deepStrictEqual(body.pid_chain, [789, 456, 123]);
  });

  it("passes through tool metadata without raw tool_input", () => {
    const toolInput = { command: "npm test", description: "Run tests" };
    const body = buildStateBody({
      hook_event_name: "PreToolUse",
      session_id: "s1",
      turn_id: "turn-1",
      tool_name: "Bash",
      tool_use_id: "tool-1",
      tool_input: toolInput,
    }, mockResolve);

    assert.strictEqual(body.state, "working");
    assert.strictEqual(body.tool_name, "Bash");
    assert.strictEqual(body.tool_use_id, "tool-1");
    assert.strictEqual(body.tool_input_fingerprint, buildToolInputFingerprint(toolInput));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(body, "tool_input"), false);
  });

  it("uses idle as Stop placeholder and carries stop_hook_active=false", () => {
    const body = buildStateBody({
      hook_event_name: "Stop",
      session_id: "s1",
      turn_id: "turn-1",
      stop_hook_active: false,
    }, mockResolve);

    assert.strictEqual(body.state, "idle");
    assert.strictEqual(body.event, "Stop");
    assert.strictEqual(body.stop_hook_active, false);
  });

  it("no-ops stop_hook_active continuations", () => {
    const body = buildStateBody({
      hook_event_name: "Stop",
      session_id: "s1",
      turn_id: "turn-1",
      stop_hook_active: true,
    }, mockResolve);

    assert.strictEqual(body, null);
  });

  it("builds PermissionRequest payloads for /permission", () => {
    const toolInput = {
      command: "npm test",
      description: "Run tests with approval",
      ignored: "x".repeat(600),
    };
    const body = buildPermissionBody({
      hook_event_name: "PermissionRequest",
      session_id: "s1",
      cwd: "/repo",
      turn_id: "turn-1",
      permission_mode: "default",
      transcript_path: "/tmp/rollout.jsonl",
      model: "gpt-5.2-codex",
      tool_name: "Bash",
      tool_input: toolInput,
    }, mockResolve);

    assert.strictEqual(body.agent_id, "codex");
    assert.strictEqual(body.hook_source, "codex-official");
    assert.strictEqual(body.session_id, "codex:s1");
    assert.strictEqual(body.tool_name, "Bash");
    assert.strictEqual(body.tool_input.description, "Run tests with approval");
    assert.strictEqual(body.tool_input_description, "Run tests with approval");
    assert.strictEqual(body.tool_input.ignored.length, 240);
    assert.strictEqual(body.tool_input_fingerprint, buildToolInputFingerprint(toolInput));
    assert.strictEqual(body.turn_id, "turn-1");
    assert.strictEqual(body.permission_mode, "default");
    assert.strictEqual(body.source_pid, 123);
  });

  it("does not build a state payload for PermissionRequest", () => {
    assert.strictEqual(buildStateBody({ hook_event_name: "PermissionRequest", session_id: "s1" }, mockResolve), null);
  });

  it("sanitizes Codex PermissionRequest output by omitting unsupported keys", () => {
    const output = sanitizeCodexPermissionOutput(JSON.stringify({
      interrupt: true,
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          message: "ignored on allow",
          updatedInput: null,
          updatedPermissions: [{ type: "setMode", mode: "default" }],
          interrupt: true,
        },
      },
    }));
    const parsed = JSON.parse(output);
    const decision = parsed.hookSpecificOutput.decision;

    assert.deepStrictEqual(decision, { behavior: "allow" });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(decision, "updatedInput"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(decision, "updatedPermissions"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(decision, "interrupt"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(parsed, "interrupt"), false);
  });

  it("keeps deny messages in sanitized Codex PermissionRequest output", () => {
    const output = buildCodexPermissionOutput({ behavior: "deny", message: "Blocked" });
    const parsed = JSON.parse(output);

    assert.deepStrictEqual(parsed.hookSpecificOutput.decision, {
      behavior: "deny",
      message: "Blocked",
    });
  });

  it("returns no-decision output for invalid PermissionRequest responses", () => {
    assert.strictEqual(sanitizeCodexPermissionOutput("not json"), buildCodexNoDecisionOutput());
    assert.strictEqual(sanitizeCodexPermissionOutput(JSON.stringify({ hookSpecificOutput: null })), "{}");
  });

  it("writes no stdout and exits 0 when stop_hook_active=true", () => {
    const scriptPath = path.resolve(__dirname, "..", "hooks", "codex-hook.js");
    const result = spawnSync(process.execPath, [scriptPath], {
      input: JSON.stringify({
        hook_event_name: "Stop",
        session_id: "s1",
        turn_id: "turn-1",
        stop_hook_active: true,
      }),
      encoding: "utf8",
      windowsHide: true,
    });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "");
  });

  describe("remote mode", () => {
    before(() => { process.env.CLAWD_REMOTE = "1"; });
    after(() => { delete process.env.CLAWD_REMOTE; });

    it("uses host instead of local pid fields", () => {
      const body = buildStateBody({ hook_event_name: "UserPromptSubmit", session_id: "s1" }, () => {
        throw new Error("resolve should not run in remote mode");
      });

      assert.strictEqual(typeof body.host, "string");
      assert.strictEqual(Object.prototype.hasOwnProperty.call(body, "source_pid"), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(body, "pid_chain"), false);
    });
  });
});
