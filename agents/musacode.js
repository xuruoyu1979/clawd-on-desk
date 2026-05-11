// musacode agent configuration
// Perception via musacode Plugin SDK: event hook → HTTP POST to Clawd
// Plugin registered in ~/.config/musacode/plugins/ directory (global scope)

module.exports = {
  id: "musacode",
  name: "MUSACode",
  processNames: { win: ["musacode.exe"], mac: ["musacode"], linux: ["musacode"] },
  eventSource: "plugin-event",
  // Clawd-internal event names (PascalCase) — musacode-plugin translates
  // musacode native events into these.
  // Reusing Claude Code event names lets state.js reuse existing transition logic
  // (e.g. SubagentStop → working whitelist).
  eventMap: {
    SessionStart: "idle",
    SessionEnd: "sleeping",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Stop: "attention",
    StopFailure: "error",
    PreCompact: "sweeping",
    PostCompact: "attention",
    // PermissionRequest handled by Phase 2 bridge (permission.asked event + reverse bridge)
  },
  capabilities: {
    httpHook: false,
    permissionApproval: true, // musacode 兼容 opencode，支持 permission bridge
    sessionEnd: true,
    subagent: false,
  },
  pidField: "musacode_pid",
};
