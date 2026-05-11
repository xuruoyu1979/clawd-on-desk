// Clawd on Desk — musacode 插件
// 运行在 musacode 进程（Bun runtime）中，将 session/tool 事件转发给
// Clawd HTTP 服务（127.0.0.1:23333-23337）。
//
// Phase 2 bridge（permission replies）：
//   musacode TUI 不暴露外部 HTTP 监听（ctx.serverUrl 是 phantom URL，
//   ctx.client.fetch 绑定到 in-process Hono router）。所以 Clawd 无法直接
//   调用 musacode REST API。解决方案与 opencode 插件一致：在插件内启动一个
//   tiny Bun.serve() reverse bridge，Clawd POSTs 决策到 bridge，bridge
//   再调用 ctx.client._client.post() — 与 opencode serve 内部相同的 in-process
//   Hono 路由。随机 32-byte hex token 保护 bridge 端点。

import { readFileSync, writeFileSync, mkdirSync, promises as fsp } from "fs";
import { homedir, platform } from "os";
import { join } from "path";
import { randomBytes, timingSafeEqual } from "crypto";
import { execSync } from "child_process";

const CLAWD_DIR = join(homedir(), ".clawd");
const RUNTIME_CONFIG_PATH = join(CLAWD_DIR, "runtime.json");
const DEBUG_LOG_PATH = join(CLAWD_DIR, "musacode-plugin.log");
const SERVER_PORTS = [23333, 23334, 23335, 23336, 23337];
const STATE_PATH = "/state";
// Fire-and-forget: the IIFE never blocks the event hook's return value, so a
// generous timeout is safe. 200ms was too tight when Clawd's IPC roundtrip
// (main → renderer → main) ran under load and silently timed out.
const POST_TIMEOUT_MS = 1000;
const AGENT_ID = "musacode";

// musacode emits session.status=busy between every tool call as the LLM
// deliberates the next step; without this gate the pet would flash
// thinking ↔ working on every invocation. Active states listed here
// suppress the "back to thinking" regression.
const ACTIVE_STATES_BLOCKING_THINKING = new Set(["working", "sweeping"]);

// Process tree walk config — mirrors hooks/clawd-hook.js exactly, minus the
// Claude-specific detection. The plugin runs in-process with musacode, so the
// walk starts at process.pid.
const TERMINAL_NAMES_WIN = new Set([
  "windowsterminal.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
  "code.exe", "alacritty.exe", "wezterm-gui.exe", "mintty.exe",
  "conemu64.exe", "conemu.exe", "hyper.exe", "tabby.exe",
  "antigravity.exe", "warp.exe", "iterm.exe", "ghostty.exe",
]);
const TERMINAL_NAMES_MAC = new Set([
  "terminal", "iterm2", "alacritty", "wezterm-gui", "kitty",
  "hyper", "tabby", "warp", "ghostty",
]);
const TERMINAL_NAMES_LINUX = new Set([
  "gnome-terminal", "kgx", "konsole", "xfce4-terminal", "tilix",
  "alacritty", "wezterm", "wezterm-gui", "kitty", "ghostty",
  "xterm", "lxterminal", "terminator", "tabby", "hyper", "warp",
]);
const SYSTEM_BOUNDARY_WIN = new Set(["explorer.exe", "services.exe", "winlogon.exe", "svchost.exe"]);
const SYSTEM_BOUNDARY_MAC = new Set(["launchd", "init", "systemd"]);
const SYSTEM_BOUNDARY_LINUX = new Set(["systemd", "init"]);
// Editor detection drives URI-scheme tab focus (code://, cursor://) in Clawd.
const EDITOR_MAP_WIN = { "code.exe": "code", "cursor.exe": "cursor" };
const EDITOR_MAP_MAC = { "code": "code", "cursor": "cursor" };
const EDITOR_MAP_LINUX = { "code": "code", "cursor": "cursor", "code-insiders": "code" };

// Per plugin-instance state (scoped to one musacode process).
let _cachedPort = null;
let _lastState = null;
let _lastSessionId = null;
let _reqCounter = 0;
// musacode subtasks may emit session.created with new sessionIDs. The parent
// session's `task` tool spawns these as child sessions. Clawd's multi-session
// fanout handles this visually. Only the ROOT session (first seen) should fire
// the happy idle animation; subtask session.idle is downgraded to SessionEnd.
let _rootSessionId = null;
// Process tree walk results — populated once by getStablePid() at init, then
// read by every POST to /state. null until first resolution.
let _stablePid = null;
let _pidChain = [];
let _detectedEditor = null;
// Project directory — captured from ctx.directory at init, sent with every
// POST so state.js can display path.basename(cwd) as the session menu label.
let _cwd = "";
// musacode HTTP server URL, captured at plugin init from ctx.serverUrl. Kept
// for debug logging only — see Phase 2 Spike: TUI does not actually listen
// on this URL. Replies go through _bridgeUrl instead.
let _serverUrl = "";
// Captured at plugin init — the musacode SDK client. Used by the reverse
// bridge to call in-process Hono routes (e.g. /permission/:id/reply).
let _ctxClient = null;
// Reverse bridge state. Set by startBridge() at plugin init. Clawd receives
// _bridgeUrl + _bridgeToken with every /permission forward and POSTs back.
let _bridgeUrl = "";
let _bridgeTokenHex = "";
let _bridgeTokenBuf = null;
let _bridgeServer = null;

// Debug log is reset on plugin init so each musacode startup gets a clean
// file. message.part.updated ignores are filtered out at the event-handler
// level to keep volume low, but we still write via a batched async flush
// (libuv threadpool) so even a burst of MAP/SEND/POST lines from a single
// event tick never blocks the musacode TUI main thread.
const _debugBuffer = [];
let _debugFlushing = false;
function debugLog(msg) {
  _debugBuffer.push(`[${new Date().toISOString()}] ${msg}\n`);
  scheduleDebugFlush();
}
function scheduleDebugFlush() {
  if (_debugFlushing || _debugBuffer.length === 0) return;
  _debugFlushing = true;
  setImmediate(async () => {
    const chunk = _debugBuffer.join("");
    _debugBuffer.length = 0;
    try {
      await fsp.appendFile(DEBUG_LOG_PATH, chunk, "utf8");
    } catch {}
    _debugFlushing = false;
    if (_debugBuffer.length > 0) scheduleDebugFlush();
  });
}

function resetDebugLog() {
  try {
    mkdirSync(CLAWD_DIR, { recursive: true });
    writeFileSync(DEBUG_LOG_PATH, "", "utf8");
  } catch {}
}

function readRuntimePort() {
  try {
    const raw = JSON.parse(readFileSync(RUNTIME_CONFIG_PATH, "utf8"));
    const port = Number(raw && raw.port);
    if (Number.isInteger(port) && SERVER_PORTS.includes(port)) return port;
  } catch {}
  return null;
}

// Ordered: cached → runtime.json → full scan. Only touches runtime.json when
// the cache is empty (avoids a sync fs read on every successful POST).
function getPortCandidates() {
  const ordered = [];
  const seen = new Set();
  const add = (p) => {
    if (p && !seen.has(p) && SERVER_PORTS.includes(p)) {
      seen.add(p);
      ordered.push(p);
    }
  };
  add(_cachedPort);
  if (_cachedPort == null) add(readRuntimePort());
  SERVER_PORTS.forEach(add);
  return ordered;
}

// Walk the process tree from process.pid until we hit a terminal app (for
// window focus) or a system boundary (explorer.exe / launchd / systemd). The
// walk keeps going past the first terminal match so we can pick the OUTERMOST
// terminal. Synchronous + cached; runs once at plugin init. Never throws.
function getStablePid() {
  if (_stablePid) return _stablePid;
  const isWin = platform() === "win32";
  const isMac = platform() === "darwin";
  const terminalNames = isWin ? TERMINAL_NAMES_WIN : (isMac ? TERMINAL_NAMES_MAC : TERMINAL_NAMES_LINUX);
  const systemBoundary = isWin ? SYSTEM_BOUNDARY_WIN : (isMac ? SYSTEM_BOUNDARY_MAC : SYSTEM_BOUNDARY_LINUX);
  const editorMap = isWin ? EDITOR_MAP_WIN : (isMac ? EDITOR_MAP_MAC : EDITOR_MAP_LINUX);

  let pid = process.pid;
  let lastGoodPid = pid;
  let terminalPid = null;
  _pidChain = [];
  _detectedEditor = null;

  for (let i = 0; i < 10 && pid && pid > 1; i++) {
    let name = "";
    let parentPid = 0;
    try {
      if (isWin) {
        const out = execSync(
          `wmic process where "ProcessId=${pid}" get Name,ParentProcessId /format:csv`,
          { encoding: "utf8", timeout: 1500, windowsHide: true }
        );
        const lines = out.trim().split("\n").filter((l) => l.includes(","));
        if (!lines.length) break;
        const parts = lines[lines.length - 1].split(",");
        name = (parts[1] || "").trim().toLowerCase();
        parentPid = parseInt(parts[2], 10) || 0;
      } else {
        const commOut = execSync(`ps -o comm= -p ${pid}`, { encoding: "utf8", timeout: 1000 }).trim();
        name = commOut.split("/").pop().toLowerCase();
        // macOS: VS Code binary is "Electron" — check full comm path for editor detection
        if (!_detectedEditor) {
          const fullLower = commOut.toLowerCase();
          if (fullLower.includes("visual studio code")) _detectedEditor = "code";
          else if (fullLower.includes("cursor.app")) _detectedEditor = "cursor";
        }
        const ppidOut = execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8", timeout: 1000 }).trim();
        parentPid = parseInt(ppidOut, 10) || 0;
      }
    } catch {
      break;
    }
    _pidChain.push(pid);
    if (!_detectedEditor && editorMap[name]) _detectedEditor = editorMap[name];
    // Hit system process — stop before escaping the user's session boundary.
    if (systemBoundary.has(name)) break;
    // Record but don't break: outermost terminal wins.
    if (terminalNames.has(name)) terminalPid = pid;
    lastGoodPid = pid;
    if (!parentPid || parentPid === pid || parentPid <= 1) break;
    pid = parentPid;
  }

  _stablePid = terminalPid || lastGoodPid;
  debugLog(`PID resolved stable=${_stablePid} editor=${_detectedEditor || "none"} chain=[${_pidChain.join(",")}]`);
  return _stablePid;
}

// Fire-and-forget POST to any Clawd endpoint. Tries cached port first;
// on failure walks runtime.json + fallback range. Caches the winning port.
// Never throws.
function postToClawd(urlPath, body, logTag) {
  // Enrich every outbound body with process-tree fields. Cached after first
  // call so this is just a few object assignments per POST.
  if (_stablePid) {
    body.source_pid = _stablePid;
    if (_pidChain.length) body.pid_chain = _pidChain;
    if (_detectedEditor) body.editor = _detectedEditor;
  }
  if (_cwd) body.cwd = _cwd;
  body.agent_pid = process.pid;
  const payload = JSON.stringify(body);
  const candidates = getPortCandidates();
  const reqId = ++_reqCounter;
  debugLog(`POST[${reqId}] ${logTag} start candidates=[${candidates.join(",")}]`);

  (async () => {
    for (const port of candidates) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
      const t0 = Date.now();
      try {
        const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          signal: controller.signal,
        });
        clearTimeout(timer);
        const elapsed = Date.now() - t0;
        const header = res.headers.get("x-clawd-server");
        debugLog(`POST[${reqId}] ${logTag} port=${port} status=${res.status} header=${header} elapsed=${elapsed}ms`);
        // Port range is unprivileged so another app could answer — require the
        // Clawd identity header before trusting the response.
        if (header === "clawd-on-desk") {
          _cachedPort = port;
          try { await res.text(); } catch {}
          debugLog(`POST[${reqId}] ${logTag} OK port=${port}`);
          return;
        }
      } catch (err) {
        clearTimeout(timer);
        const elapsed = Date.now() - t0;
        debugLog(`POST[${reqId}] ${logTag} port=${port} ERR ${err && err.name}/${err && err.message} elapsed=${elapsed}ms`);
      }
    }
    // All candidates failed — drop the cache so next call re-reads runtime.json.
    debugLog(`POST[${reqId}] ${logTag} EXHAUSTED all candidates failed`);
    _cachedPort = null;
  })().catch((err) => {
    debugLog(`POST[${reqId}] ${logTag} UNCAUGHT ${err && err.message}`);
  });
}

function postStateToClawd(body) {
  postToClawd(STATE_PATH, body, `STATE state=${body.state}`);
}

// Fire-and-forget permission forward. Clawd decides allow/deny/always in its
// bubble UI and — critically — replies to musacode's own REST API directly
// (POST ${server_url}permission/:request_id/reply). The plugin never waits.
function postPermissionToClawd(body) {
  postToClawd("/permission", body, `PERM tool=${body.tool_name} req=${body.request_id}`);
}

// Clawd uses PascalCase event names matching Claude Code's hook vocabulary so
// state.js transition rules are reusable across agents.
function sendState(state, eventName, sessionId) {
  if (!state || !eventName) return;

  if (state === "thinking" && ACTIVE_STATES_BLOCKING_THINKING.has(_lastState)) {
    debugLog(`GATE busy→thinking blocked (lastState=${_lastState}, session=${sessionId})`);
    return;
  }

  if (state === _lastState && sessionId === _lastSessionId) {
    return;
  }

  debugLog(`SEND ${_lastState || "null"} → ${state} event=${eventName} session=${sessionId}`);
  _lastState = state;
  _lastSessionId = sessionId;

  postStateToClawd({
    state,
    session_id: sessionId || "default",
    event: eventName,
    agent_id: AGENT_ID,
  });
}

// Translate a musacode event into a Clawd (state, eventName) pair, or null
// if Clawd should ignore it.
function translateEvent(event) {
  if (!event || typeof event.type !== "string") return null;
  const props = event.properties || {};

  switch (event.type) {
    case "session.created":
      return { state: "idle", event: "SessionStart" };

    case "session.status": {
      // Only busy drives thinking. session.idle is a separate event.
      const type = props.status && props.status.type;
      if (type === "busy") return { state: "thinking", event: "UserPromptSubmit" };
      return null;
    }

    case "message.part.updated": {
      const part = props.part;
      if (!part || typeof part !== "object") return null;

      if (part.type === "tool") {
        const status = part.state && part.state.status;
        if (status === "running") return { state: "working", event: "PreToolUse" };
        if (status === "completed") return { state: "working", event: "PostToolUse" };
        if (status === "error") return { state: "error", event: "PostToolUseFailure" };
        return null;
      }

      if (part.type === "compaction") {
        return { state: "sweeping", event: "PreCompact" };
      }

      return null;
    }

    case "session.compacted":
      return { state: "sweeping", event: "PreCompact" };

    case "session.idle":
      // Only the root session's idle fires the happy animation. Subtask
      // sessions (spawned by the `task` tool) end with SessionEnd so Clawd
      // removes them from its tracking map. If _rootSessionId is null (no
      // session seen yet), fall through to old behavior.
      if (_rootSessionId && props.sessionID && props.sessionID !== _rootSessionId) {
        return { state: "sleeping", event: "SessionEnd" };
      }
      return { state: "attention", event: "Stop" };

    case "session.error":
      return { state: "error", event: "StopFailure" };

    case "session.deleted":
    case "server.instance.disposed":
      return { state: "sleeping", event: "SessionEnd" };

    default:
      return null;
  }
}

// Normalize ctx.serverUrl into a string with a trailing slash. musacode passes
// a URL object in practice but we coerce defensively in case future versions
// hand us a plain string. Trailing slash lets Clawd concat cleanly:
//   `${server_url}permission/${request_id}/reply`
function normalizeServerUrl(raw) {
  if (!raw) return "";
  const s = String(raw);
  return s.endsWith("/") ? s : s + "/";
}

// Handle v2 permission.asked event. The payload has no sessionID in its
// properties (only `id` = requestID), so we borrow _lastSessionId which is
// kept fresh by session.*/message.part.updated events. Phase 1 dedup/state
// machine logic does not run for permission events — they ride a parallel
// channel and never translate to a Clawd state transition.
function handlePermissionAsked(event) {
  const p = (event && event.properties) || {};
  const requestId = p.id;
  if (!requestId) {
    debugLog(`PERM skip: no request id in permission.asked`);
    return;
  }
  postPermissionToClawd({
    agent_id: AGENT_ID,
    tool_name: p.permission || "unknown",
    tool_input: p.metadata || {},
    patterns: Array.isArray(p.patterns) ? p.patterns : [],
    always: Array.isArray(p.always) ? p.always : [],
    session_id: _lastSessionId || "default",
    request_id: requestId,
    server_url: _serverUrl,         // debug only, not used for replies
    bridge_url: _bridgeUrl,         // ← Clawd POSTs decisions here
    bridge_token: _bridgeTokenHex,  // ← and authenticates with this
  });
}

// Constant-time token comparison to thwart timing oracle attacks on the
// bridge auth. Any local process can see 127.0.0.1 binds so the token is
// the only thing keeping untrusted code from rubber-stamping tool calls.
function verifyBridgeToken(headerValue) {
  if (!headerValue || !_bridgeTokenBuf) return false;
  const m = /^Bearer\s+([a-f0-9]+)$/i.exec(headerValue);
  if (!m) return false;
  let candidate;
  try { candidate = Buffer.from(m[1], "hex"); } catch { return false; }
  if (candidate.length !== _bridgeTokenBuf.length) return false;
  try { return timingSafeEqual(candidate, _bridgeTokenBuf); } catch { return false; }
}

// Handle POST /reply from Clawd. Reads { request_id, reply } and forwards to
// the musacode in-process Hono router via ctx.client._client.post(). Return
// 200 on success, 4xx on auth/shape errors, 502 if the upstream call itself throws.
async function handleBridgeRequest(req) {
  const url = new URL(req.url);
  if (req.method !== "POST" || url.pathname !== "/reply") {
    return new Response("not found", { status: 404 });
  }
  if (!verifyBridgeToken(req.headers.get("authorization"))) {
    debugLog(`BRIDGE auth fail from=${req.headers.get("x-forwarded-for") || "local"}`);
    return new Response("unauthorized", { status: 401 });
  }
  let body;
  try { body = await req.json(); } catch {
    return new Response("bad json", { status: 400 });
  }
  const requestId = body && typeof body.request_id === "string" ? body.request_id : "";
  const reply = body && typeof body.reply === "string" ? body.reply : "";
  if (!requestId || !["once", "always", "reject"].includes(reply)) {
    debugLog(`BRIDGE bad payload requestId=${requestId} reply=${reply}`);
    return new Response("bad payload", { status: 400 });
  }
  if (!_ctxClient || !_ctxClient._client) {
    debugLog(`BRIDGE no ctx client available`);
    return new Response("plugin not ready", { status: 503 });
  }

  debugLog(`BRIDGE → musacode permission reply requestId=${requestId} reply=${reply}`);
  try {
    const result = await _ctxClient._client.post({
      url: `/permission/${encodeURIComponent(requestId)}/reply`,
      body: { reply },
      headers: { "Content-Type": "application/json" },
    });
    const hasError = result && result.error != null;
    debugLog(`BRIDGE reply done requestId=${requestId} hasError=${hasError}`);
    if (hasError) {
      return new Response(JSON.stringify({ ok: false, error: String(result.error) }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    debugLog(`BRIDGE reply THROW requestId=${requestId} msg=${err && err.message}`);
    return new Response(JSON.stringify({ ok: false, error: String(err && err.message) }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// Start the Bun.serve reverse bridge on a random localhost port. Called once
// at plugin init. Survives the plugin's lifetime; musacode owns the process
// so there's no explicit shutdown path — the server dies with the process.
function startBridge() {
  if (typeof Bun === "undefined" || !Bun.serve) {
    debugLog(`BRIDGE start FAILED: Bun.serve not available (not running under Bun?)`);
    return;
  }
  try {
    _bridgeTokenBuf = randomBytes(32);
    _bridgeTokenHex = _bridgeTokenBuf.toString("hex");
    _bridgeServer = Bun.serve({
      port: 0,              // ask the OS for an unused port
      hostname: "127.0.0.1",
      fetch: handleBridgeRequest,
    });
    const port = _bridgeServer.port;
    _bridgeUrl = `http://127.0.0.1:${port}`;
    debugLog(`BRIDGE listening on ${_bridgeUrl} (token ${_bridgeTokenHex.slice(0, 8)}…)`);
  } catch (err) {
    debugLog(`BRIDGE start THROW: ${err && err.message}`);
    _bridgeServer = null;
    _bridgeUrl = "";
    _bridgeTokenHex = "";
    _bridgeTokenBuf = null;
  }
}

// Plugin entrypoint (musacode loads this via default export).
export default async (ctx) => {
  resetDebugLog();
  _serverUrl = normalizeServerUrl(ctx && ctx.serverUrl);
  _ctxClient = ctx && ctx.client ? ctx.client : null;
  _cwd = ctx && typeof ctx.directory === "string" ? ctx.directory : "";
  debugLog(`INIT directory=${_cwd} serverUrl=${_serverUrl} pid=${process.pid} hasClient=${!!_ctxClient}`);
  // Resolve terminal PID synchronously at init.
  getStablePid();
  startBridge();

  return {
    event: async ({ event }) => {
      try {
        if (!event || typeof event.type !== "string") return;

        // Capture the root session on first sighting. Any later sessionID is
        // a subtask spawned by the parent's `task` tool, and its
        // session.idle will be downgraded to SessionEnd in translateEvent.
        const sid = event.properties && event.properties.sessionID;
        if (sid && !_rootSessionId) {
          _rootSessionId = sid;
          debugLog(`ROOT session captured id=${sid}`);
        }

        // Phase 2: permission.asked rides a parallel channel — forward to Clawd
        // and skip state translation. Clawd replies directly to musacode's own
        // REST API, so we don't need to watch permission.replied here.
        if (event.type === "permission.asked") {
          handlePermissionAsked(event);
          return;
        }

        const mapped = translateEvent(event);
        if (!mapped) {
          // Log ignored session.* events only — they are low-frequency and
          // occasionally useful for diagnosis. message.part.updated ignores
          // are skipped because they would trigger a sync fsync on every
          // text/reasoning/step streaming update (tens per session).
          if (event.type.startsWith("session.")) {
            const statusType = event.properties && event.properties.status && event.properties.status.type;
            debugLog(`IGNORE ${event.type}${statusType ? ` status=${statusType}` : ""}`);
          }
          return;
        }
        const sessionId = (event.properties && event.properties.sessionID) || "default";
        debugLog(`MAP ${event.type} → state=${mapped.state} event=${mapped.event}`);
        sendState(mapped.state, mapped.event, sessionId);
      } catch (err) {
        debugLog(`ERROR in event hook: ${err && err.message}`);
      }
    },
  };
};
