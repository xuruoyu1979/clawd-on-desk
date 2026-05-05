const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const adapter = require("../src/codex-pet-adapter");
const themeLoader = require("../src/theme-loader");

const FIXTURE_DIR = path.join(__dirname, "fixtures", "codex-pets", "tiny-atlas-png");
const FRAME_WIDTH = 192;
const FRAME_HEIGHT = 208;
const COLUMNS = 8;
const ROWS = 9;
const ATLAS_WIDTH = FRAME_WIDTH * COLUMNS;
const ATLAS_HEIGHT = FRAME_HEIGHT * ROWS;
const USED_COLUMNS_BY_ROW = [6, 8, 8, 4, 5, 8, 6, 6, 6];
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-pet-"));
  tempDirs.push(dir);
  return dir;
}

function readPng(filePath) {
  const data = fs.readFileSync(filePath);
  assert.deepStrictEqual(
    [...data.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  );

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];

  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
    } else if (type === "IDAT") {
      idatChunks.push(chunk);
    } else if (type === "IEND") {
      break;
    }
  }

  const rgba = zlib.inflateSync(Buffer.concat(idatChunks));
  return { width, height, bitDepth, colorType, rgba };
}

function alphaAt(png, x, y) {
  const stride = 1 + png.width * 4;
  const rowStart = y * stride;
  assert.strictEqual(png.rgba[rowStart], 0, "fixture PNG should use unfiltered rows");
  return png.rgba[rowStart + 1 + x * 4 + 3];
}

function copyFixturePackage(parentDir, folderName = "tiny-atlas-png") {
  const targetDir = path.join(parentDir, folderName);
  fs.mkdirSync(targetDir, { recursive: true });
  for (const filename of ["pet.json", "spritesheet.png", "README.md"]) {
    fs.copyFileSync(path.join(FIXTURE_DIR, filename), path.join(targetDir, filename));
  }
  return targetDir;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function makeThemeLoaderFixture(userData) {
  const appRoot = path.join(makeTempDir(), "app");
  const appDir = path.join(appRoot, "src");
  fs.mkdirSync(path.join(appRoot, "assets", "svg"), { recursive: true });
  fs.mkdirSync(path.join(appRoot, "assets", "sounds"), { recursive: true });
  fs.mkdirSync(path.join(appRoot, "themes"), { recursive: true });
  fs.mkdirSync(appDir, { recursive: true });
  themeLoader.init(appDir, userData);
}

describe("Codex Pet fixture", () => {
  it("committed tiny Codex Pet fixture matches the atlas contract", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "pet.json"), "utf8"));
    assert.strictEqual(manifest.id, "tiny-atlas-png");
    assert.strictEqual(manifest.spritesheetPath, "spritesheet.png");

    const png = readPng(path.join(FIXTURE_DIR, manifest.spritesheetPath));
    assert.strictEqual(png.width, ATLAS_WIDTH);
    assert.strictEqual(png.height, ATLAS_HEIGHT);
    assert.strictEqual(png.bitDepth, 8);
    assert.strictEqual(png.colorType, 6);

    for (let row = 0; row < ROWS; row += 1) {
      const usedColumns = USED_COLUMNS_BY_ROW[row];
      const activeX = (usedColumns - 1) * FRAME_WIDTH + Math.floor(FRAME_WIDTH / 2);
      const activeY = row * FRAME_HEIGHT + Math.floor(FRAME_HEIGHT / 2);
      assert.strictEqual(alphaAt(png, activeX, activeY), 255, `row ${row} active cells should be visible`);

      if (usedColumns < COLUMNS) {
        const unusedX = usedColumns * FRAME_WIDTH + Math.floor(FRAME_WIDTH / 2);
        assert.strictEqual(alphaAt(png, unusedX, activeY), 0, `row ${row} unused cells should be transparent`);
      }
    }
  });
});

describe("codex-pet-adapter package validation", () => {
  it("accepts the deterministic PNG fixture and records source metadata", () => {
    const result = adapter.validateCodexPetPackage(FIXTURE_DIR);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.packageInfo.id, "tiny-atlas-png");
    assert.strictEqual(result.packageInfo.slug, "tiny-atlas-png");
    assert.strictEqual(result.packageInfo.spritesheetPath, "spritesheet.png");
    assert.strictEqual(result.packageInfo.image.width, adapter.ATLAS.width);
    assert.strictEqual(result.packageInfo.image.height, adapter.ATLAS.height);
    assert.strictEqual(result.packageInfo.image.checkedUnusedTransparency, true);
  });

  it("preserves Unicode pet ids while deriving an ASCII slug", () => {
    const root = makeTempDir();
    const packageDir = copyFixturePackage(root, "yoimiya宵宫");
    writeJson(path.join(packageDir, "pet.json"), {
      id: "yoimiya宵宫",
      displayName: "yoimiya宵宫",
      spritesheetPath: "spritesheet.png",
    });

    const result = adapter.validateCodexPetPackage(packageDir);
    assert.strictEqual(result.ok, true, result.errors.join("; "));
    assert.strictEqual(result.packageInfo.id, "yoimiya宵宫");
    assert.strictEqual(result.packageInfo.slug, "yoimiya");
  });

  it("reports missing or malformed manifests", () => {
    const root = makeTempDir();
    const missingDir = path.join(root, "missing");
    fs.mkdirSync(missingDir, { recursive: true });
    assert.match(adapter.validateCodexPetPackage(missingDir).errors.join("; "), /missing pet\.json/);

    const badDir = path.join(root, "bad");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "pet.json"), "{", "utf8");
    assert.match(adapter.validateCodexPetPackage(badDir).errors.join("; "), /invalid pet\.json/);
  });

  it("rejects unsafe or unsupported spritesheet paths", () => {
    const root = makeTempDir();

    const absoluteDir = path.join(root, "absolute");
    fs.mkdirSync(absoluteDir, { recursive: true });
    writeJson(path.join(absoluteDir, "pet.json"), {
      id: "absolute",
      spritesheetPath: "C:\\outside\\spritesheet.png",
    });
    assert.match(adapter.validateCodexPetPackage(absoluteDir).errors.join("; "), /must be relative/);

    const traversalDir = path.join(root, "traversal");
    fs.mkdirSync(traversalDir, { recursive: true });
    writeJson(path.join(traversalDir, "pet.json"), {
      id: "traversal",
      spritesheetPath: "../spritesheet.png",
    });
    assert.match(adapter.validateCodexPetPackage(traversalDir).errors.join("; "), /traversal/);

    const gifDir = copyFixturePackage(root, "gif");
    writeJson(path.join(gifDir, "pet.json"), {
      id: "gif",
      spritesheetPath: "spritesheet.gif",
    });
    fs.copyFileSync(path.join(gifDir, "spritesheet.png"), path.join(gifDir, "spritesheet.gif"));
    assert.match(adapter.validateCodexPetPackage(gifDir).errors.join("; "), /\.webp or \.png/);
  });

  it("rejects PNG atlases with wrong dimensions", () => {
    const root = makeTempDir();
    const packageDir = copyFixturePackage(root, "wrong-size");
    const spritesheetPath = path.join(packageDir, "spritesheet.png");
    const png = fs.readFileSync(spritesheetPath);
    png.writeUInt32BE(ATLAS_WIDTH - 1, 16);
    fs.writeFileSync(spritesheetPath, png);

    const result = adapter.validateCodexPetPackage(packageDir);
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("; "), /must be 1536x1872, got 1535x1872/);
  });
});

describe("codex-pet-adapter wrapper generation and materialization", () => {
  it("generates loop, once, and static wrappers without unused-frame references", () => {
    const jumpOnce = adapter.generateWrapperSvg({
      rowKey: "jumping",
      mode: "once",
      spritesheetHref: "spritesheet.png",
    });
    assert.match(jumpOnce, /animation-name: codex-pet-row-jumping-once/);
    assert.match(jumpOnce, /animation-iteration-count: 1/);
    assert.match(jumpOnce, /animation-fill-mode: forwards/);
    assert.ok(!jumpOnce.includes("translate(-960px, -832px)"));

    const runLoop = adapter.generateWrapperSvg({
      rowKey: "running",
      mode: "loop",
      spritesheetHref: "spritesheet.png",
    });
    assert.match(runLoop, /animation-iteration-count: infinite/);

    const idleStatic = adapter.generateWrapperSvg({
      rowKey: "idle",
      mode: "static",
      spritesheetHref: "spritesheet.png",
    });
    assert.ok(!idleStatic.includes("animation-name:"));
    assert.match(idleStatic, /transform: translate\(0px, 0px\)/);
  });

  it("materializes a managed Clawd theme that strict-loads through theme-loader", () => {
    const root = makeTempDir();
    const packageDir = copyFixturePackage(path.join(root, "pets"));
    const validation = adapter.validateCodexPetPackage(packageDir);
    assert.strictEqual(validation.ok, true, validation.errors.join("; "));

    const userData = path.join(root, "userData");
    const userThemesDir = path.join(userData, "themes");
    const materialized = adapter.materializeCodexPetTheme(validation.packageInfo, userThemesDir);

    assert.strictEqual(materialized.themeId, "codex-pet-tiny-atlas-png");
    assert.strictEqual(fs.existsSync(path.join(materialized.themeDir, "assets", "spritesheet.png")), true);
    assert.strictEqual(fs.existsSync(path.join(materialized.themeDir, "assets", "codex-pet-jumping-once.svg")), true);

    const themeJson = readJson(path.join(materialized.themeDir, "theme.json"));
    assert.strictEqual(themeJson.rendering.svgChannel, "object");
    assert.strictEqual(themeJson.eyeTracking.enabled, false);
    assert.strictEqual(themeJson.states.working[0], "codex-pet-running-loop.svg");
    assert.strictEqual(themeJson.states.notification[0], "codex-pet-waiting-loop.svg");
    assert.strictEqual(themeJson.states.error[0], "codex-pet-failed-loop.svg");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(themeJson, "objectScale"), false);

    const marker = readJson(path.join(materialized.themeDir, adapter.MARKER_FILENAME));
    assert.strictEqual(marker.adapterVersion, adapter.ADAPTER_VERSION);
    assert.strictEqual(marker.generatedThemeId, materialized.themeId);
    assert.strictEqual(marker.sourcePetId, "tiny-atlas-png");

    makeThemeLoaderFixture(userData);
    const loaded = themeLoader.loadTheme(materialized.themeId, { strict: true });
    assert.strictEqual(loaded._id, materialized.themeId);
    assert.strictEqual(loaded.rendering.svgChannel, "object");
    assert.strictEqual(loaded.states.sleeping[0], "codex-pet-idle-static.svg");
  });

  it("does not overwrite unmanaged theme IDs and keeps managed suffixes stable", () => {
    const root = makeTempDir();
    const packageDir = copyFixturePackage(path.join(root, "pets"));
    const validation = adapter.validateCodexPetPackage(packageDir);
    const userThemesDir = path.join(root, "userData", "themes");
    const unmanagedDir = path.join(userThemesDir, "codex-pet-tiny-atlas-png");
    fs.mkdirSync(unmanagedDir, { recursive: true });
    fs.writeFileSync(path.join(unmanagedDir, "theme.json"), "{\"name\":\"User Theme\"}\n", "utf8");

    const first = adapter.materializeCodexPetTheme(validation.packageInfo, userThemesDir);
    const second = adapter.materializeCodexPetTheme(validation.packageInfo, userThemesDir);

    assert.strictEqual(first.themeId, "codex-pet-tiny-atlas-png-2");
    assert.strictEqual(second.themeId, "codex-pet-tiny-atlas-png-2");
    assert.strictEqual(fs.readFileSync(path.join(unmanagedDir, "theme.json"), "utf8"), "{\"name\":\"User Theme\"}\n");
  });

  it("syncs valid packages and reports invalid packages without throwing", () => {
    const root = makeTempDir();
    const petsDir = path.join(root, "pets");
    copyFixturePackage(petsDir, "tiny-atlas-png");
    fs.mkdirSync(path.join(petsDir, "broken"), { recursive: true });

    const summary = adapter.syncCodexPetThemes({
      codexPetsDir: petsDir,
      userDataDir: path.join(root, "userData"),
    });

    assert.strictEqual(summary.imported, 1);
    assert.strictEqual(summary.updated, 0);
    assert.strictEqual(summary.invalid, 1);
    assert.deepStrictEqual(summary.themes.map((theme) => theme.themeId), ["codex-pet-tiny-atlas-png"]);
    assert.match(summary.diagnostics[0].errors.join("; "), /missing pet\.json/);
  });
});
