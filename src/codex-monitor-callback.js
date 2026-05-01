"use strict";

function isCodexMonitorPermissionEvent(state) {
  return state === "codex-permission";
}

function buildCodexMonitorUpdateOptions(extra, options = {}) {
  const input = extra && typeof extra === "object" ? extra : {};
  const out = {
    cwd: input.cwd,
    agentId: "codex",
    sessionTitle: input.sessionTitle,
  };
  if (options.includeHeadless) out.headless = input.headless === true;
  return out;
}

module.exports = {
  buildCodexMonitorUpdateOptions,
  isCodexMonitorPermissionEvent,
};
