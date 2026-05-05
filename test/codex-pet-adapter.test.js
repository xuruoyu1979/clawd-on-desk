const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const FIXTURE_DIR = path.join(__dirname, "fixtures", "codex-pets", "tiny-atlas-png");
const FRAME_WIDTH = 192;
const FRAME_HEIGHT = 208;
const COLUMNS = 8;
const ROWS = 9;
const ATLAS_WIDTH = FRAME_WIDTH * COLUMNS;
const ATLAS_HEIGHT = FRAME_HEIGHT * ROWS;
const USED_COLUMNS_BY_ROW = [6, 8, 8, 4, 5, 8, 6, 6, 6];

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

test("committed tiny Codex Pet fixture matches the atlas contract", () => {
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
