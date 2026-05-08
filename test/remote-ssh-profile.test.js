"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  REMOTE_FORWARD_PORTS,
  isValidHost,
  isValidPort,
  isValidRemoteForwardPort,
  isValidIdentityFile,
  isValidHostPrefix,
  isValidLabel,
  isValidId,
  validateProfile,
  sanitizeProfile,
  normalizeRemoteSsh,
  getDefaults,
} = require("../src/remote-ssh-profile");

// ── isValidHost ──

test("isValidHost accepts bare hostname", () => {
  for (const h of ["pi", "raspberry.local", "host-1", "abc_123", "a.b.c"]) {
    assert.equal(isValidHost(h), true, `expected ${h} valid`);
  }
});

test("isValidHost accepts user@host (single @)", () => {
  for (const h of ["user@host", "me@pi.local", "u_n@h-1"]) {
    assert.equal(isValidHost(h), true, h);
  }
});

test("isValidHost rejects multiple @", () => {
  assert.equal(isValidHost("a@b@c"), false);
  assert.equal(isValidHost("user@@host"), false);
});

test("isValidHost rejects leading dash (defeats ssh option injection)", () => {
  assert.equal(isValidHost("-oProxyCommand=evil"), false);
  assert.equal(isValidHost("-rm"), false);
});

test("isValidHost rejects control chars / newlines / spaces", () => {
  assert.equal(isValidHost("host\nname"), false);
  assert.equal(isValidHost("host name"), false);
  assert.equal(isValidHost("host\tname"), false);
  assert.equal(isValidHost("host\0name"), false);
});

test("isValidHost rejects empty / non-string / too long", () => {
  assert.equal(isValidHost(""), false);
  assert.equal(isValidHost(null), false);
  assert.equal(isValidHost(123), false);
  assert.equal(isValidHost("a".repeat(256)), false);
});

test("isValidHost rejects non-ASCII (forces explicit alias in ssh config)", () => {
  assert.equal(isValidHost("树莓派"), false);
});

// ── isValidPort ──

test("isValidPort accepts integer in [1, 65535]", () => {
  assert.equal(isValidPort(22), true);
  assert.equal(isValidPort(1), true);
  assert.equal(isValidPort(65535), true);
});

test("isValidPort rejects out-of-range / non-integer", () => {
  assert.equal(isValidPort(0), false);
  assert.equal(isValidPort(65536), false);
  assert.equal(isValidPort(22.5), false);
  assert.equal(isValidPort("22"), false);
  assert.equal(isValidPort(-1), false);
});

// ── isValidRemoteForwardPort ──

test("isValidRemoteForwardPort accepts only SERVER_PORTS range 23333-23337", () => {
  for (const p of REMOTE_FORWARD_PORTS) {
    assert.equal(isValidRemoteForwardPort(p), true);
  }
});

test("isValidRemoteForwardPort rejects outside SERVER_PORTS", () => {
  assert.equal(isValidRemoteForwardPort(23332), false);
  assert.equal(isValidRemoteForwardPort(23338), false);
  assert.equal(isValidRemoteForwardPort(8080), false);
  assert.equal(isValidRemoteForwardPort(0), false);
});

// ── isValidIdentityFile ──

test("isValidIdentityFile accepts absolute Unix path", () => {
  assert.equal(isValidIdentityFile("/home/me/.ssh/id_rsa"), true);
});

test("isValidIdentityFile accepts absolute Windows path", () => {
  assert.equal(isValidIdentityFile("C:\\Users\\me\\.ssh\\id_rsa"), path.isAbsolute("C:\\Users\\me\\.ssh\\id_rsa"));
});

test("isValidIdentityFile rejects relative path", () => {
  assert.equal(isValidIdentityFile("./key"), false);
  assert.equal(isValidIdentityFile("key"), false);
  assert.equal(isValidIdentityFile("../key"), false);
});

test("isValidIdentityFile rejects leading dash (ssh option injection)", () => {
  assert.equal(isValidIdentityFile("-oProxyCommand=evil"), false);
});

test("isValidIdentityFile rejects control chars / newlines", () => {
  assert.equal(isValidIdentityFile("/home/me\nkey"), false);
  assert.equal(isValidIdentityFile("/home/me\tkey"), false);
  assert.equal(isValidIdentityFile("/home/me\0key"), false);
});

test("isValidIdentityFile accepts paths with spaces (legitimate)", () => {
  // Spaces are allowed in real filesystems — quoting at the consumer side handles them.
  assert.equal(isValidIdentityFile("/home/me/My Keys/id_rsa"), true);
});

// ── isValidHostPrefix ──

test("isValidHostPrefix accepts plain ASCII labels", () => {
  assert.equal(isValidHostPrefix("raspberrypi"), true);
  assert.equal(isValidHostPrefix("home-mac"), true);
  assert.equal(isValidHostPrefix("树莓派"), true);
});

test("isValidHostPrefix rejects single quote", () => {
  assert.equal(isValidHostPrefix("o'brien"), false);
});

test("isValidHostPrefix rejects double quote", () => {
  assert.equal(isValidHostPrefix('say "hi"'), false);
});

test("isValidHostPrefix rejects backtick", () => {
  assert.equal(isValidHostPrefix("`whoami`"), false);
});

test("isValidHostPrefix rejects dollar", () => {
  assert.equal(isValidHostPrefix("$HOME"), false);
});

test("isValidHostPrefix rejects backslash", () => {
  assert.equal(isValidHostPrefix("a\\b"), false);
});

test("isValidHostPrefix rejects exclamation (bash history)", () => {
  assert.equal(isValidHostPrefix("!cmd"), false);
});

test("isValidHostPrefix rejects newlines / control chars", () => {
  assert.equal(isValidHostPrefix("a\nb"), false);
  assert.equal(isValidHostPrefix("a\rb"), false);
  assert.equal(isValidHostPrefix("a\0b"), false);
});

// ── isValidLabel ──

test("isValidLabel accepts user-friendly names with spaces", () => {
  assert.equal(isValidLabel("My Raspberry Pi"), true);
  assert.equal(isValidLabel("树莓派"), true);
  assert.equal(isValidLabel("Home Mac (M1)"), true);
});

test("isValidLabel rejects empty / too long", () => {
  assert.equal(isValidLabel(""), false);
  assert.equal(isValidLabel("a".repeat(101)), false);
});

test("isValidLabel rejects newlines", () => {
  assert.equal(isValidLabel("line1\nline2"), false);
});

// ── isValidId ──

test("isValidId accepts alnum / underscore / dash", () => {
  assert.equal(isValidId("abc"), true);
  assert.equal(isValidId("a_1-b"), true);
});

test("isValidId rejects empty / too long / special chars", () => {
  assert.equal(isValidId(""), false);
  assert.equal(isValidId("a".repeat(65)), false);
  assert.equal(isValidId("has space"), false);
  assert.equal(isValidId("dot.id"), false);
});

// ── validateProfile ──

function basicProfile(over = {}) {
  return {
    id: "p1",
    label: "My Pi",
    host: "user@pi.local",
    remoteForwardPort: 23333,
    autoStartCodexMonitor: false,
    connectOnLaunch: false,
    ...over,
  };
}

test("validateProfile accepts minimal valid profile", () => {
  assert.equal(validateProfile(basicProfile()).status, "ok");
});

test("validateProfile rejects missing id", () => {
  const p = basicProfile();
  delete p.id;
  assert.equal(validateProfile(p).status, "error");
});

test("validateProfile rejects bad host", () => {
  assert.equal(validateProfile(basicProfile({ host: "-evil" })).status, "error");
  assert.equal(validateProfile(basicProfile({ host: "a@b@c" })).status, "error");
});

test("validateProfile rejects out-of-range remoteForwardPort", () => {
  assert.equal(validateProfile(basicProfile({ remoteForwardPort: 22 })).status, "error");
  assert.equal(validateProfile(basicProfile({ remoteForwardPort: 23338 })).status, "error");
});

test("validateProfile rejects relative identityFile", () => {
  const p = basicProfile({ identityFile: "./key" });
  assert.equal(validateProfile(p).status, "error");
});

test("validateProfile rejects identityFile starting with dash", () => {
  const p = basicProfile({ identityFile: "-oProxyCommand=evil" });
  assert.equal(validateProfile(p).status, "error");
});

test("validateProfile rejects hostPrefix with shell metacharacters", () => {
  for (const bad of ["o'brien", '"hi"', "`x`", "$HOME", "a\\b", "!run"]) {
    const r = validateProfile(basicProfile({ hostPrefix: bad }));
    assert.equal(r.status, "error", `expected reject: ${JSON.stringify(bad)}`);
  }
});

test("validateProfile accepts safe hostPrefix values", () => {
  for (const ok of ["raspberrypi", "home-mac", "pi.local", "树莓派"]) {
    const r = validateProfile(basicProfile({ hostPrefix: ok }));
    assert.equal(r.status, "ok", `expected accept: ${JSON.stringify(ok)}`);
  }
});

test("validateProfile rejects non-boolean autoStartCodexMonitor / connectOnLaunch", () => {
  assert.equal(validateProfile(basicProfile({ autoStartCodexMonitor: "true" })).status, "error");
  assert.equal(validateProfile(basicProfile({ connectOnLaunch: 1 })).status, "error");
});

// ── sanitizeProfile ──

test("sanitizeProfile fills createdAt and strips unknown fields", () => {
  const out = sanitizeProfile({
    id: "p1",
    label: "My Pi",
    host: "user@pi",
    remoteForwardPort: 23333,
    autoStartCodexMonitor: false,
    connectOnLaunch: false,
    randomGarbage: "ignore me",
  });
  assert.ok(out);
  assert.equal(out.id, "p1");
  assert.ok(Number.isFinite(out.createdAt));
  assert.equal(Object.prototype.hasOwnProperty.call(out, "randomGarbage"), false);
});

test("sanitizeProfile returns null on invalid input", () => {
  assert.equal(sanitizeProfile(null), null);
  assert.equal(sanitizeProfile({}), null);
  assert.equal(sanitizeProfile({ id: "p1" }), null);
});

// ── normalizeRemoteSsh (load path) ──

test("normalizeRemoteSsh drops invalid profiles silently", () => {
  const cleaned = normalizeRemoteSsh({
    profiles: [
      basicProfile(),
      { id: "bad-host", label: "x", host: "-evil", remoteForwardPort: 23333,
        autoStartCodexMonitor: false, connectOnLaunch: false },
      basicProfile({ id: "p2", host: "pi2" }),
    ],
  });
  assert.equal(cleaned.profiles.length, 2);
  assert.deepEqual(cleaned.profiles.map((p) => p.id), ["p1", "p2"]);
});

test("normalizeRemoteSsh dedups by id (first wins)", () => {
  const cleaned = normalizeRemoteSsh({
    profiles: [
      basicProfile({ id: "p1", host: "pi1" }),
      basicProfile({ id: "p1", host: "pi2" }),
    ],
  });
  assert.equal(cleaned.profiles.length, 1);
  assert.equal(cleaned.profiles[0].host, "pi1");
});

test("normalizeRemoteSsh returns defaults for non-object", () => {
  assert.deepEqual(normalizeRemoteSsh(null), getDefaults());
  assert.deepEqual(normalizeRemoteSsh([]), getDefaults());
  assert.deepEqual(normalizeRemoteSsh("nope"), getDefaults());
});

// ── settings-actions: command registry ──

const { commandRegistry, updateRegistry } = require("../src/settings-actions");

test("settings-actions: remoteSsh validator accepts empty profiles list", () => {
  const r = updateRegistry.remoteSsh({ profiles: [] });
  assert.equal(r.status, "ok");
});

test("settings-actions: remoteSsh validator rejects bad profile in list", () => {
  const r = updateRegistry.remoteSsh({ profiles: [basicProfile({ host: "-evil" })] });
  assert.equal(r.status, "error");
  assert.match(r.message, /profiles\[0\]/);
});

test("settings-actions: remoteSsh validator rejects non-object", () => {
  assert.equal(updateRegistry.remoteSsh(null).status, "error");
  assert.equal(updateRegistry.remoteSsh({ profiles: "no" }).status, "error");
});

test("settings-actions: remoteSsh.add inserts new profile and returns commit", () => {
  const cmd = commandRegistry["remoteSsh.add"];
  const r = cmd(basicProfile(), { snapshot: { remoteSsh: { profiles: [] } } });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.commit.remoteSsh.profiles.map((p) => p.id), ["p1"]);
});

test("settings-actions: remoteSsh.add rejects duplicate id", () => {
  const cmd = commandRegistry["remoteSsh.add"];
  const r = cmd(basicProfile(), {
    snapshot: { remoteSsh: { profiles: [basicProfile()] } },
  });
  assert.equal(r.status, "error");
  assert.match(r.message, /already exists/);
});

test("settings-actions: remoteSsh.add rejects invalid input", () => {
  const cmd = commandRegistry["remoteSsh.add"];
  const r = cmd({ id: "bad", label: "x", host: "-evil",
                  remoteForwardPort: 23333,
                  autoStartCodexMonitor: false, connectOnLaunch: false },
                { snapshot: { remoteSsh: { profiles: [] } } });
  assert.equal(r.status, "error");
});

test("settings-actions: remoteSsh.update overwrites existing profile + preserves createdAt", () => {
  const cmd = commandRegistry["remoteSsh.update"];
  const original = basicProfile({ createdAt: 12345 });
  const r = cmd(
    basicProfile({ host: "newhost" }),
    { snapshot: { remoteSsh: { profiles: [original] } } }
  );
  assert.equal(r.status, "ok");
  assert.equal(r.commit.remoteSsh.profiles[0].host, "newhost");
  // createdAt preserved (caller didn't pass a new one).
  assert.equal(r.commit.remoteSsh.profiles[0].createdAt, 12345);
});

test("settings-actions: remoteSsh.update fails on unknown id", () => {
  const cmd = commandRegistry["remoteSsh.update"];
  const r = cmd(basicProfile({ id: "ghost" }), {
    snapshot: { remoteSsh: { profiles: [] } },
  });
  assert.equal(r.status, "error");
  assert.match(r.message, /not found/);
});

test("settings-actions: remoteSsh.delete removes profile", () => {
  const cmd = commandRegistry["remoteSsh.delete"];
  const r = cmd("p1", {
    snapshot: { remoteSsh: { profiles: [basicProfile()] } },
  });
  assert.equal(r.status, "ok");
  assert.equal(r.commit.remoteSsh.profiles.length, 0);
});

test("settings-actions: remoteSsh.delete is noop on unknown id (no error)", () => {
  const cmd = commandRegistry["remoteSsh.delete"];
  const r = cmd("ghost", {
    snapshot: { remoteSsh: { profiles: [basicProfile()] } },
  });
  assert.equal(r.status, "ok");
  assert.equal(r.noop, true);
  assert.equal(r.commit, undefined);
});

test("settings-actions: remoteSsh.delete rejects empty / non-string id", () => {
  const cmd = commandRegistry["remoteSsh.delete"];
  assert.equal(cmd("", { snapshot: {} }).status, "error");
  assert.equal(cmd(null, { snapshot: {} }).status, "error");
  assert.equal(cmd({}, { snapshot: {} }).status, "error");
});

// ── prefs.js: schema integration ──

test("prefs.getDefaults includes remoteSsh.profiles=[]", () => {
  const { getDefaults: prefsDefaults } = require("../src/prefs");
  const d = prefsDefaults();
  assert.ok(d.remoteSsh, "remoteSsh field must be in defaults");
  assert.ok(Array.isArray(d.remoteSsh.profiles));
  assert.equal(d.remoteSsh.profiles.length, 0);
});

test("prefs.validate normalizes invalid remoteSsh into defaults", () => {
  const { validate } = require("../src/prefs");
  const out = validate({ remoteSsh: { profiles: "no" } });
  // schema validate runs normalize first → drops bad profiles → empty list.
  assert.deepEqual(out.remoteSsh, { profiles: [] });
});

test("prefs.validate keeps valid remoteSsh profiles", () => {
  const { validate } = require("../src/prefs");
  const profile = basicProfile();
  const out = validate({ remoteSsh: { profiles: [profile] } });
  assert.equal(out.remoteSsh.profiles.length, 1);
  assert.equal(out.remoteSsh.profiles[0].id, "p1");
});
