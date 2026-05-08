"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const TABLE_READMES = ["README.md", "README.ko-KR.md", "README.ja-JP.md"];

function extractContributorTable(markdown, filename) {
  const tables = [...markdown.matchAll(/<table>[\s\S]*?<\/table>/g)].map(
    (match) => match[0],
  );
  const match = tables.find(
    (table) => table.includes("PixelCookie-zyf") && table.includes("jhseo-b"),
  );
  assert.ok(match, `${filename} should contain the contributors table`);
  return match;
}

function getRows(table) {
  return [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((match) => match[1]);
}

function countCells(row) {
  return (row.match(/<td\s/g) || []).length;
}

for (const filename of TABLE_READMES) {
  test(`${filename} fills the penultimate contributors row`, () => {
    const markdown = fs.readFileSync(path.join(ROOT, filename), "utf8");
    const rows = getRows(extractContributorTable(markdown, filename));
    const cellCounts = rows.map(countCells);
    const totalCells = cellCounts.reduce((sum, count) => sum + count, 0);
    const penultimateRow = rows[rows.length - 2];
    const finalRow = rows[rows.length - 1];

    assert.strictEqual(totalCells, 43);
    assert.strictEqual(cellCounts[cellCounts.length - 2], 7);
    assert.match(penultimateRow, /sunnysonx/);
    assert.match(penultimateRow, /YuChenYunn/);
    assert.strictEqual(cellCounts[cellCounts.length - 1], 1);
    assert.match(finalRow, /jhseo-b/);
  });
}
