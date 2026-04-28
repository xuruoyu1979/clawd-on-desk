"use strict";

(function initSettingsDoctorModal(root) {
  const state = {
    lastResult: null,
    initialRunStarted: false,
    runningPromise: null,
    indicator: null,
    dot: null,
    label: null,
    status: null,
    modalOpen: false,
    connectionTest: null,
    connectionTesting: false,
    connectionRemainingSeconds: 0,
    connectionTimer: null,
    repairingKey: null,
  };

  function t(core, key) {
    return core.helpers.t(key);
  }

  function escape(core, value) {
    return core.helpers.escapeHtml(value == null ? "" : value);
  }

  function overallClass(result) {
    const status = result && result.overall && result.overall.status;
    if (!result) return "unknown";
    if (status === "critical") return "critical";
    if (status === "warning") return "warning";
    return "pass";
  }

  function overallText(core, result) {
    const status = result && result.overall && result.overall.status;
    if (!result) return t(core, "doctorStatusUnknown");
    if (status === "critical") return t(core, "doctorStatusCritical");
    if (status === "warning") return t(core, "doctorStatusWarning");
    return t(core, "doctorStatusPass");
  }

  function updateIndicator(core, result) {
    if (!state.indicator) return;
    const cls = overallClass(result);
    state.indicator.classList.remove("unknown", "pass", "warning", "critical");
    state.indicator.classList.add(cls);
    if (state.status) state.status.textContent = overallText(core, result);
  }

  function checkLabel(core, check) {
    const map = {
      "local-server": "doctorCheckLocalServer",
      "agent-integrations": "doctorCheckAgentIntegrations",
      "permission-bubble-policy": "doctorCheckPermissionBubbles",
      "theme-health": "doctorCheckTheme",
    };
    return t(core, map[check.id] || "doctorCheckUnknown");
  }

  function checkStatusLabel(core, check) {
    if (!check) return t(core, "doctorStatusUnknown");
    if (check.level === "critical" || check.status === "critical") return t(core, "doctorStatusCritical");
    if (check.level === "warning" || check.status === "warning" || check.status === "fail") return t(core, "doctorStatusWarning");
    if (check.level === "info") return t(core, "doctorStatusInfo");
    return t(core, "doctorStatusPass");
  }

  function connectionStatusClass(test) {
    if (state.connectionTesting) return "warning";
    if (!test) return "unknown";
    if (test.level === "warning" || test.status === "http-dropped" || test.status === "http-blocked" || test.status === "no-activity" || test.status === "error") {
      return "warning";
    }
    return "pass";
  }

  function connectionStatusLabel(core, test) {
    if (state.connectionTesting) {
      return t(core, "doctorConnectionTesting").replace("{seconds}", String(state.connectionRemainingSeconds));
    }
    if (!test) return t(core, "doctorConnectionIdle");
    const map = {
      "http-verified": "doctorConnectionHttpVerified",
      "http-dropped": "doctorConnectionHttpDropped",
      "http-blocked": "doctorConnectionHttpBlocked",
      "no-activity": "doctorConnectionNoActivity",
      error: "doctorConnectionError",
    };
    return t(core, map[test.status] || "doctorConnectionError");
  }

  function pushIfValue(lines, label, value) {
    if (value === null || value === undefined || value === "") return;
    lines.push(`${label}: ${value}`);
  }

  function formatKiroScan(scan) {
    if (!scan || typeof scan !== "object") return null;
    const parts = [];
    if (Array.isArray(scan.fullyValidFiles) && scan.fullyValidFiles.length) {
      parts.push(`valid=${scan.fullyValidFiles.join(", ")}`);
    }
    if (Array.isArray(scan.brokenFiles) && scan.brokenFiles.length) {
      parts.push(`broken=${scan.brokenFiles.join(", ")}`);
    }
    if (Array.isArray(scan.corruptFiles) && scan.corruptFiles.length) {
      parts.push(`corrupt=${scan.corruptFiles.join(", ")}`);
    }
    if (Array.isArray(scan.noMarkerFiles) && scan.noMarkerFiles.length) {
      parts.push(`no-marker=${scan.noMarkerFiles.length}`);
    }
    return parts.length ? parts.join("; ") : null;
  }

  function agentDetailText(detail) {
    if (!detail || typeof detail !== "object") return "";
    const lines = [];
    if (detail.detail) lines.push(detail.detail);
    pushIfValue(lines, "permission", detail.permissionBubbleDetail);
    if (detail.supplementary && typeof detail.supplementary === "object") {
      const key = detail.supplementary.key || "supplementary";
      const value = detail.supplementary.value || "unknown";
      const suffix = detail.supplementary.detail ? ` (${detail.supplementary.detail})` : "";
      lines.push(`${key}=${value}${suffix}`);
    }
    pushIfValue(lines, "kiro", formatKiroScan(detail.kiroScan));
    pushIfValue(lines, "hook issue", detail.hookCommandIssue);
    pushIfValue(lines, "opencode issue", detail.opencodeEntryIssue);
    pushIfValue(lines, "opencode entry", detail.opencodeEntry);
    return lines.filter(Boolean).join("; ");
  }

  function fixActionKey(action) {
    if (!action || typeof action !== "object") return "";
    return `${action.type || "unknown"}:${action.agentId || ""}`;
  }

  function renderFixButton(core, action) {
    if (!action || typeof action !== "object" || !action.type) return "";
    const key = fixActionKey(action);
    const busy = state.repairingKey === key;
    const disabled = state.repairingKey ? " disabled" : "";
    const agentAttr = action.agentId ? ` data-agent-id="${escape(core, action.agentId)}"` : "";
    const label = busy ? t(core, "doctorFixing") : t(core, "doctorFix");
    return `<button type="button" class="doctor-fix-button" data-action="fix" data-fix-type="${escape(core, action.type)}"${agentAttr}${disabled}>${escape(core, label)}</button>`;
  }

  function confirmFixAction(core, action) {
    if (!action || action.type !== "agent-integration" || action.agentId !== "codex") return true;
    const confirmFn = typeof root.confirm === "function" ? root.confirm.bind(root) : null;
    if (!confirmFn) return true;
    return confirmFn(t(core, "doctorFixConfirmCodex"));
  }

  function renderCheckList(core, result) {
    const checks = result && Array.isArray(result.checks) ? result.checks : [];
    if (!checks.length) {
      return `<div class="doctor-empty">${escape(core, t(core, "doctorNoResult"))}</div>`;
    }
    return checks.map((check) => {
      const cls = check.level === "critical" ? "critical" : (check.level === "warning" ? "warning" : "pass");
      let agentRows = "";
      if (check.id === "agent-integrations" && Array.isArray(check.details)) {
        agentRows = `<div class="doctor-agent-list">${
          check.details.map((detail) => {
            const agentDetail = agentDetailText(detail);
            const fixButton = renderFixButton(core, detail.fixAction);
            return (
              `<div class="doctor-agent-item">` +
                `<div class="doctor-agent-row${fixButton ? " with-action" : ""}">` +
                  `<span>${escape(core, detail.agentName || detail.agentId)}</span>` +
                  `<span>${escape(core, detail.status || "")}</span>` +
                  fixButton +
                `</div>` +
                (agentDetail ? `<div class="doctor-agent-detail">${escape(core, agentDetail)}</div>` : "") +
              `</div>`
            );
          }).join("")
        }</div>`;
      }
      const fixButton = renderFixButton(core, check.fixAction);
      return (
        `<div class="doctor-check-row ${cls}">` +
          `<div class="doctor-check-main${fixButton ? " with-action" : ""}">` +
            `<span class="doctor-check-dot"></span>` +
            `<span class="doctor-check-label">${escape(core, checkLabel(core, check))}</span>` +
            `<span class="doctor-check-status">${escape(core, checkStatusLabel(core, check))}</span>` +
            fixButton +
          `</div>` +
          (check.detail ? `<div class="doctor-check-detail">${escape(core, check.detail)}</div>` : "") +
          agentRows +
        `</div>`
      );
    }).join("");
  }

  function renderConnectionTest(core) {
    const test = state.connectionTest;
    const detail = state.connectionTesting
      ? t(core, "doctorConnectionInstruction")
      : (test && test.detail) || t(core, "doctorConnectionInstruction");
    return (
      `<div class="doctor-connection-panel ${connectionStatusClass(test)}">` +
        `<div class="doctor-connection-main">` +
          `<span class="doctor-check-dot"></span>` +
          `<span class="doctor-check-label">${escape(core, t(core, "doctorConnectionTitle"))}</span>` +
          `<span class="doctor-check-status">${escape(core, connectionStatusLabel(core, test))}</span>` +
        `</div>` +
        `<div class="doctor-check-detail">${escape(core, detail)}</div>` +
      `</div>`
    );
  }

  function renderModalBody(core, result) {
    const issueCount = result && result.overall ? result.overall.issueCount || 0 : 0;
    const testDisabled = state.connectionTesting ? " disabled" : "";
    return (
      `<div class="doctor-modal">` +
        `<div class="doctor-modal-header">` +
          `<div>` +
            `<h2>${escape(core, t(core, "doctorTitle"))}</h2>` +
            `<div class="doctor-overall ${overallClass(result)}">` +
              `<span class="doctor-overall-dot"></span>` +
              `<span>${escape(core, overallText(core, result))}</span>` +
              `<span class="doctor-issue-count">${escape(core, t(core, "doctorIssueCount").replace("{count}", String(issueCount)))}</span>` +
            `</div>` +
          `</div>` +
          `<button type="button" class="doctor-close" aria-label="${escape(core, t(core, "doctorClose"))}">x</button>` +
        `</div>` +
        `<div class="doctor-privacy">${escape(core, t(core, "doctorPrivacy"))}</div>` +
        `<div class="doctor-check-list">${renderCheckList(core, result)}</div>` +
        renderConnectionTest(core) +
        `<div class="doctor-actions">` +
          `<button type="button" class="soft-btn" data-action="copy">${escape(core, t(core, "doctorCopyReport"))}</button>` +
          `<button type="button" class="soft-btn" data-action="open-log">${escape(core, t(core, "doctorOpenLog"))}</button>` +
          `<button type="button" class="soft-btn" data-action="test-connection"${testDisabled}>${escape(core, t(core, "doctorTestConnection"))}</button>` +
          `<button type="button" class="soft-btn accent" data-action="rerun">${escape(core, t(core, "doctorRerun"))}</button>` +
        `</div>` +
      `</div>`
    );
  }

  function closeModal() {
    state.modalOpen = false;
    const rootEl = document.getElementById("modalRoot");
    if (rootEl) rootEl.innerHTML = "";
  }

  function stopConnectionCountdown() {
    if (state.connectionTimer) {
      clearInterval(state.connectionTimer);
      state.connectionTimer = null;
    }
  }

  function refreshModal(core) {
    if (state.modalOpen) mountModal(core, state.lastResult);
  }

  function mountModal(core, result) {
    state.modalOpen = true;
    const rootEl = document.getElementById("modalRoot");
    if (!rootEl) return;
    rootEl.innerHTML = (
      `<div class="modal-backdrop doctor-modal-backdrop">` +
        renderModalBody(core, result) +
      `</div>`
    );
    const backdrop = rootEl.querySelector(".doctor-modal-backdrop");
    const modal = rootEl.querySelector(".doctor-modal");
    const close = rootEl.querySelector(".doctor-close");
    const copy = rootEl.querySelector('[data-action="copy"]');
    const rerun = rootEl.querySelector('[data-action="rerun"]');
    const testConnection = rootEl.querySelector('[data-action="test-connection"]');
    const openLog = rootEl.querySelector('[data-action="open-log"]');
    const fixButtons = rootEl.querySelectorAll('[data-action="fix"]');
    if (backdrop) {
      backdrop.addEventListener("click", (ev) => {
        if (ev.target === backdrop) closeModal();
      });
    }
    if (modal) modal.addEventListener("click", (ev) => ev.stopPropagation());
    if (close) close.addEventListener("click", closeModal);
    if (copy) {
      copy.addEventListener("click", async () => {
        try {
          const report = await root.doctor.getReport();
          await navigator.clipboard.writeText(report);
          core.helpers.showToast(t(core, "doctorCopied"));
        } catch (err) {
          core.helpers.showToast((err && err.message) || t(core, "doctorCopyFailed"), { error: true });
        }
      });
    }
    if (rerun) {
      rerun.addEventListener("click", () => runAndOpen(core));
    }
    if (testConnection) {
      testConnection.addEventListener("click", () => startConnectionTest(core));
    }
    if (openLog) {
      openLog.addEventListener("click", async () => {
        try {
          if (!root.doctor || typeof root.doctor.openClawdLog !== "function") throw new Error(t(core, "doctorOpenLogFailed"));
          const result = await root.doctor.openClawdLog();
          if (!result || result.status !== "ok") throw new Error((result && (result.message || result.reason)) || t(core, "doctorOpenLogFailed"));
          core.helpers.showToast(t(core, "doctorOpenLogOpened"));
        } catch (err) {
          core.helpers.showToast((err && err.message) || t(core, "doctorOpenLogFailed"), { error: true });
        }
      });
    }
    for (const button of fixButtons) {
      button.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const action = {
          type: button.getAttribute("data-fix-type") || "",
        };
        const agentId = button.getAttribute("data-agent-id");
        if (agentId) action.agentId = agentId;
        startFixAction(core, action);
      });
    }
  }

  async function startFixAction(core, action) {
    if (state.repairingKey) return;
    if (!root.settingsAPI || typeof root.settingsAPI.command !== "function") {
      core.helpers.showToast(t(core, "doctorFixFailed"), { error: true });
      return;
    }
    if (!confirmFixAction(core, action)) return;
    state.repairingKey = fixActionKey(action);
    refreshModal(core);
    try {
      const result = await root.settingsAPI.command("repairDoctorIssue", action);
      if (!result || result.status !== "ok") {
        throw new Error((result && result.message) || t(core, "doctorFixFailed"));
      }
      core.helpers.showToast(t(core, "doctorFixApplied"));
      await runChecks(core);
    } catch (err) {
      core.helpers.showToast((err && err.message) || t(core, "doctorFixFailed"), { error: true });
    } finally {
      state.repairingKey = null;
      refreshModal(core);
    }
  }

  async function startConnectionTest(core) {
    if (state.connectionTesting) return;
    if (!root.doctor || typeof root.doctor.testConnection !== "function") {
      core.helpers.showToast(t(core, "doctorConnectionError"), { error: true });
      return;
    }
    const durationMs = 10000;
    state.connectionTesting = true;
    state.connectionTest = null;
    state.connectionRemainingSeconds = Math.ceil(durationMs / 1000);
    stopConnectionCountdown();
    state.connectionTimer = setInterval(() => {
      state.connectionRemainingSeconds = Math.max(0, state.connectionRemainingSeconds - 1);
      refreshModal(core);
    }, 1000);
    refreshModal(core);
    try {
      state.connectionTest = await root.doctor.testConnection(durationMs);
    } catch (err) {
      state.connectionTest = {
        status: "error",
        level: "warning",
        detail: (err && err.message) || t(core, "doctorRunFailed"),
      };
    } finally {
      state.connectionTesting = false;
      state.connectionRemainingSeconds = 0;
      stopConnectionCountdown();
      refreshModal(core);
    }
  }

  async function runChecks(core) {
    if (!root.doctor || typeof root.doctor.runChecks !== "function") return null;
    if (state.runningPromise) return state.runningPromise;
    state.runningPromise = Promise.resolve(root.doctor.runChecks())
      .then((result) => {
        state.lastResult = result;
        updateIndicator(core, result);
        return result;
      })
      .catch((err) => {
        updateIndicator(core, null);
        throw err;
      })
      .finally(() => {
        state.runningPromise = null;
      });
    return state.runningPromise;
  }

  async function runAndOpen(core) {
    mountModal(core, state.lastResult);
    try {
      const result = await runChecks(core);
      mountModal(core, result);
    } catch (err) {
      core.helpers.showToast((err && err.message) || t(core, "doctorRunFailed"), { error: true });
      mountModal(core, state.lastResult);
    }
  }

  function renderSidebarIndicator(sidebar, core) {
    const item = document.createElement("div");
    item.className = "sidebar-item doctor-indicator";
    item.innerHTML =
      `<span class="doctor-indicator-dot"></span>` +
      `<span class="sidebar-item-label">${escape(core, t(core, "doctorSidebarLabel"))}</span>` +
      `<span class="doctor-indicator-status">${escape(core, t(core, "doctorStatusUnknown"))}</span>`;
    item.addEventListener("click", () => runAndOpen(core));
    sidebar.appendChild(item);
    state.indicator = item;
    state.dot = item.querySelector(".doctor-indicator-dot");
    state.label = item.querySelector(".sidebar-item-label");
    state.status = item.querySelector(".doctor-indicator-status");
    updateIndicator(core, state.lastResult);
    if (!state.initialRunStarted && !state.lastResult) {
      state.initialRunStarted = true;
      runChecks(core).catch(() => updateIndicator(core, null));
    }
  }

  root.ClawdSettingsDoctorModal = {
    renderSidebarIndicator,
    runChecks,
    open: runAndOpen,
  };
})(globalThis);
