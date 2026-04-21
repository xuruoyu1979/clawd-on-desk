"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SETTINGS_HTML = path.join(__dirname, "..", "src", "settings.html");
const SETTINGS_RENDERER = path.join(__dirname, "..", "src", "settings-renderer.js");

describe("settings renderer browser environment", () => {
  it("loads the size-slider helper as a plain script before settings-renderer", () => {
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    const helperIndex = html.indexOf('<script src="settings-size-slider.js"></script>');
    const rendererIndex = html.indexOf('<script src="settings-renderer.js"></script>');
    assert.notStrictEqual(helperIndex, -1, "settings.html should load the size-slider helper");
    assert.notStrictEqual(rendererIndex, -1, "settings.html should load settings-renderer.js");
    assert.ok(helperIndex < rendererIndex, "size-slider helper must load before settings-renderer.js");
  });

  it("does not use CommonJS require in settings-renderer.js", () => {
    const source = fs.readFileSync(SETTINGS_RENDERER, "utf8");
    assert.ok(!source.includes('require("./settings-size-slider")'));
    assert.ok(source.includes("globalThis.ClawdSettingsSizeSlider"));
  });

  it("does not animate the size bubble's horizontal position", () => {
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    const match = html.match(/\.size-bubble\s*\{([\s\S]*?)\n\}/);
    assert.ok(match, "settings.html should define a .size-bubble rule");
    assert.ok(!/transition:\s*left\b/.test(match[1]));
    assert.ok(/transition:\s*transform 0\.14s ease,\s*box-shadow 0\.18s ease;/.test(match[1]));
  });

  it("renders the size bubble tail as a separated double-layer callout instead of overlapping the pill", () => {
    const html = fs.readFileSync(SETTINGS_HTML, "utf8");
    assert.ok(/--size-bubble-tail-size:\s*4px;/.test(html));
    assert.ok(/--size-bubble-tail-inner-size:\s*3px;/.test(html));
    assert.ok(/--size-bubble-tail-gap:\s*1px;/.test(html));
    assert.ok(/padding-top:\s*29px;/.test(html));
    assert.ok(/\.size-bubble\s*\{[\s\S]*top:\s*6px;[\s\S]*border-radius:\s*9px;[\s\S]*padding:\s*0 7px;[\s\S]*line-height:\s*1\.2;[\s\S]*\}/.test(html));
    assert.ok(/\.size-bubble::before,\s*\.size-bubble::after\s*\{/.test(html));
    assert.ok(/\.size-bubble::before\s*\{[\s\S]*top:\s*calc\(100%\s*\+\s*var\(--size-bubble-tail-gap\)\);[\s\S]*border-top:\s*var\(--size-bubble-tail-size\)\s+solid\s+var\(--accent\);[\s\S]*\}/.test(html));
    assert.ok(/\.size-bubble::after\s*\{[\s\S]*top:\s*calc\(100%\s*\+\s*var\(--size-bubble-tail-gap\)\);[\s\S]*border-top:\s*var\(--size-bubble-tail-inner-size\)\s+solid\s+var\(--panel-bg\);[\s\S]*\}/.test(html));
    assert.ok(!/\.size-bubble::after\s*\{[\s\S]*margin-top:\s*-1px;/.test(html));
  });
});
