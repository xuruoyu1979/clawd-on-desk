"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const RENDERER = path.join(__dirname, "..", "src", "renderer.js");
const PRELOAD = path.join(__dirname, "..", "src", "preload.js");

function readNormalized(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

describe("renderer low-power idle mode", () => {
  it("waits for an animation boundary before pausing the current SVG", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("function getLowPowerAnimationBoundaryDelayMs(root)"));
    assert.ok(source.includes("root.getAnimations({ subtree: true })"));
    assert.ok(source.includes("pauseCurrentSvgForLowPower({ waitForBoundary: true })"));
    assert.ok(source.includes("LOW_POWER_BOUNDARY_EPSILON_MS"));
  });

  it("keeps the disabled-mode eye-move path cheap", () => {
    const source = fs.readFileSync(RENDERER, "utf8");

    assert.ok(source.includes("if (!lowPowerIdleMode && !lowPowerSvgPaused) return;"));
  });
});

describe("renderer object-channel selection", () => {
  it("allows built-in trusted scripted SVG files to use <object>", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("_trustedScriptedSvgFiles = new Set"));
    assert.ok(source.includes("return needsEyeTracking(state) || _trustedScriptedSvgFiles.has(file);"));
  });

  it("keeps eye-tracking attachment state-based only", () => {
    const source = readNormalized(RENDERER);

    assert.ok(source.includes("function needsEyeTracking(state)"));
    assert.match(source, /if \(state && needsEyeTracking\(state\)\) {\r?\n\s+attachEyeTracking\(next\);/);
  });
});

describe("renderer Cloudling pointer bridge", () => {
  it("bridges only selected Cloudling pointer states through the exporter API", () => {
    const source = fs.readFileSync(RENDERER, "utf8");
    const preload = fs.readFileSync(PRELOAD, "utf8");

    assert.ok(source.includes('const CLOUDLING_POINTER_BRIDGE_STATES = new Set(["idle", "mini-idle", "mini-peek"]);'));
    assert.ok(source.includes('typeof svgWindow.__cloudlingSetPointer === "function"'));
    assert.ok(source.includes('svgWindow.__cloudlingSetPointer(payload);'));
    assert.ok(source.includes('window.electronAPI.onCloudlingPointer((payload) => {'));
    assert.ok(preload.includes('onCloudlingPointer: (callback) => ipcRenderer.on("cloudling-pointer", (_, payload) => callback(payload))'));
  });
});

describe("renderer glyph flip compensation", () => {
  it("notifies object-channel SVGs when mini-left glyph compensation changes", () => {
    const source = fs.readFileSync(RENDERER, "utf8");

    assert.ok(source.includes("typeof svgWindow.__clawdSetGlyphFlipCompensation === \"function\""));
    assert.ok(source.includes("svgWindow.__clawdSetGlyphFlipCompensation(true);"));
    assert.ok(source.includes("svgWindow.__clawdSetGlyphFlipCompensation(false);"));
  });
});
