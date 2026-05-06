"use strict";

function isFocusableLocalHudSession(entry) {
  return !!entry
    && !!entry.id
    && !!entry.sourcePid
    && !entry.headless
    && entry.state !== "sleeping"
    && !entry.hiddenFromHud
    && !entry.host;
}

function getFocusableLocalHudSessionIds(snapshot) {
  const sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
  return sessions
    .filter(isFocusableLocalHudSession)
    .map((entry) => entry.id);
}

module.exports = {
  getFocusableLocalHudSessionIds,
  isFocusableLocalHudSession,
};
