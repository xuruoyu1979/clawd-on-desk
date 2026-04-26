"use strict";

const assert = require("node:assert");
const Module = require("node:module");
const { describe, it } = require("node:test");

const PERMISSION_MODULE_PATH = require.resolve("../src/permission");

function loadPermissionWithElectron() {
  delete require.cache[PERMISSION_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        BrowserWindow: Object.assign(class {}, { fromWebContents() { return null; } }),
        globalShortcut: {
          register() { return true; },
          unregister() {},
          isRegistered() { return false; },
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/permission");
  } finally {
    Module._load = originalLoad;
  }
}

describe("Codex permission response sanitizer", () => {
  it("omits unsupported fail-closed fields instead of setting them to null", () => {
    const permission = loadPermissionWithElectron();
    const body = permission.__test.buildCodexPermissionResponseBody({
      behavior: "allow",
      message: "ignored",
      updatedInput: null,
      updatedPermissions: [{ type: "setMode", mode: "default" }],
      interrupt: true,
    });
    const parsed = JSON.parse(body);
    const decision = parsed.hookSpecificOutput.decision;

    assert.deepStrictEqual(decision, { behavior: "allow" });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(decision, "updatedInput"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(decision, "updatedPermissions"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(decision, "interrupt"), false);
  });

  it("keeps deny messages and rejects invalid decisions as no-decision", () => {
    const permission = loadPermissionWithElectron();
    const denyBody = permission.__test.buildCodexPermissionResponseBody("deny", "Blocked");
    const deny = JSON.parse(denyBody).hookSpecificOutput.decision;

    assert.deepStrictEqual(deny, { behavior: "deny", message: "Blocked" });
    assert.strictEqual(permission.__test.buildCodexPermissionResponseBody({ behavior: "ask" }), "{}");
  });
});
