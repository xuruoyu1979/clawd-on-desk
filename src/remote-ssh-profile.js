"use strict";

// ── Remote SSH profile schema + validation ──
//
// Pure schema helpers for `prefs.remoteSsh.profiles[]`. Used by:
//   - prefs.js normalizeRemoteSsh (drop bad data on load)
//   - settings-actions.js remoteSsh.add / .update commands (reject bad input)
//
// All security-sensitive validation lives here so writers and readers see
// the same rules. Per plan v7 §3.1:
//
//   host          — hostname OR user@hostname; ASCII alphanumeric + . _ -
//                   leading char must be alnum (block `-` to defeat ssh
//                   option injection); at most one `@`.
//   port          — integer in [1, 65535] when set; default 22 means absent.
//   identityFile  — absolute path; no control chars / newline; no leading `-`.
//                   Existence checked at Connect time, not at write time.
//   remoteForwardPort — integer in SERVER_PORTS (23333-23337). Anything
//                   outside is rejected at the schema layer.
//   hostPrefix    — no control chars / newlines AND none of these shell-special
//                   chars: ' " ` $ \ !  (! is bash history expansion). Together
//                   with the ssh-stdin write at deploy time, this is the second
//                   layer of defense.

const path = require("path");

const REMOTE_FORWARD_PORTS = [23333, 23334, 23335, 23336, 23337];

const HOST_BARE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const HOST_USER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*@[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// Control chars (0x00-0x1F + DEL 0x7F) — covers \n, \r, \t, NUL, etc.
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;
// hostPrefix: control chars + shell metacharacters that can break out of
// quoting on the remote even with our ssh-stdin write. Single quote, double
// quote, backtick, dollar, backslash, exclamation.
const HOST_PREFIX_FORBIDDEN_RE = /[\x00-\x1f\x7f'"`$\\!]/;

function isValidHost(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > 255) return false;
  if (HOST_BARE_RE.test(value)) return true;
  if (HOST_USER_RE.test(value)) return true;
  return false;
}

function isValidPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isValidRemoteForwardPort(value) {
  return REMOTE_FORWARD_PORTS.includes(value);
}

function isValidIdentityFile(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (CONTROL_CHARS_RE.test(value)) return false;
  if (value.startsWith("-")) return false;
  if (!path.isAbsolute(value)) return false;
  return true;
}

function isValidHostPrefix(value) {
  if (typeof value !== "string") return false;
  if (HOST_PREFIX_FORBIDDEN_RE.test(value)) return false;
  return true;
}

function isValidLabel(value) {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 100) return false;
  if (CONTROL_CHARS_RE.test(value)) return false;
  return true;
}

function isValidId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

// Validate a profile candidate. Returns { status: "ok" } or
// { status: "error", message }.
function validateProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return { status: "error", message: "profile must be an object" };
  }
  if (!isValidId(profile.id)) {
    return { status: "error", message: "profile.id must be 1-64 chars [a-zA-Z0-9_-]" };
  }
  if (!isValidLabel(profile.label)) {
    return { status: "error", message: "profile.label must be 1-100 chars and contain no control characters" };
  }
  if (!isValidHost(profile.host)) {
    return {
      status: "error",
      message: "profile.host must be a hostname or user@hostname (ASCII alnum, . _ -; no leading -; at most one @)",
    };
  }
  if (profile.port !== undefined && profile.port !== null) {
    if (!isValidPort(profile.port)) {
      return { status: "error", message: "profile.port must be an integer in [1, 65535]" };
    }
  }
  if (profile.identityFile !== undefined && profile.identityFile !== null && profile.identityFile !== "") {
    if (!isValidIdentityFile(profile.identityFile)) {
      return {
        status: "error",
        message: "profile.identityFile must be an absolute path with no control chars and not starting with '-'",
      };
    }
  }
  if (!isValidRemoteForwardPort(profile.remoteForwardPort)) {
    return {
      status: "error",
      message: `profile.remoteForwardPort must be one of ${REMOTE_FORWARD_PORTS.join(", ")}`,
    };
  }
  if (profile.hostPrefix !== undefined && profile.hostPrefix !== null && profile.hostPrefix !== "") {
    if (!isValidHostPrefix(profile.hostPrefix)) {
      return {
        status: "error",
        message: "profile.hostPrefix must not contain control chars or any of: ' \" ` $ \\ !",
      };
    }
  }
  if (typeof profile.autoStartCodexMonitor !== "boolean") {
    return { status: "error", message: "profile.autoStartCodexMonitor must be a boolean" };
  }
  if (typeof profile.connectOnLaunch !== "boolean") {
    return { status: "error", message: "profile.connectOnLaunch must be a boolean" };
  }
  // lastDeployedAt is set by the IPC layer after a successful Deploy. It's
  // optional (a fresh profile starts without one) and must be a finite
  // positive integer when present. The UI consumes it to surface "Hooks not
  // deployed" vs "Hooks deployed N minutes ago" so users don't connect a
  // tunnel that has no hooks on the other end.
  if (profile.lastDeployedAt !== undefined && profile.lastDeployedAt !== null) {
    if (!Number.isFinite(profile.lastDeployedAt) || profile.lastDeployedAt <= 0) {
      return { status: "error", message: "profile.lastDeployedAt must be a positive finite number" };
    }
  }
  return { status: "ok" };
}

// Coerce arbitrary input into a sanitized profile, dropping unknown fields.
// Returns null if the result would be invalid.
function sanitizeProfile(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {
    id: typeof raw.id === "string" ? raw.id : "",
    label: typeof raw.label === "string" ? raw.label : "",
    host: typeof raw.host === "string" ? raw.host.trim() : "",
    port: Number.isInteger(raw.port) ? raw.port : undefined,
    identityFile: typeof raw.identityFile === "string" && raw.identityFile.length > 0
      ? raw.identityFile
      : undefined,
    remoteForwardPort: Number.isInteger(raw.remoteForwardPort) ? raw.remoteForwardPort : 23333,
    hostPrefix: typeof raw.hostPrefix === "string" && raw.hostPrefix.length > 0
      ? raw.hostPrefix
      : undefined,
    autoStartCodexMonitor: raw.autoStartCodexMonitor === true,
    connectOnLaunch: raw.connectOnLaunch === true,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    lastDeployedAt: Number.isFinite(raw.lastDeployedAt) && raw.lastDeployedAt > 0
      ? raw.lastDeployedAt
      : undefined,
  };
  // Strip undefineds for cleaner JSON.
  for (const k of Object.keys(out)) {
    if (out[k] === undefined) delete out[k];
  }
  const v = validateProfile(out);
  if (v.status !== "ok") return null;
  return out;
}

// Coerce a `remoteSsh` snapshot.
function normalizeRemoteSsh(value, defaults) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults || { profiles: [] };
  }
  const profiles = Array.isArray(value.profiles) ? value.profiles : [];
  const seen = new Set();
  const cleanProfiles = [];
  for (const raw of profiles) {
    const clean = sanitizeProfile(raw);
    if (!clean) continue;
    if (seen.has(clean.id)) continue;
    seen.add(clean.id);
    cleanProfiles.push(clean);
  }
  return { profiles: cleanProfiles };
}

function getDefaults() {
  return { profiles: [] };
}

module.exports = {
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
};
