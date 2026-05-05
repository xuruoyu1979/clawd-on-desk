const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const importer = require("../src/codex-pet-importer");
const adapter = require("../src/codex-pet-adapter");

const FIXTURE_DIR = path.join(__dirname, "fixtures", "codex-pets", "tiny-atlas-png");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-pet-importer-"));
}

function fixtureManifest(overrides = {}) {
  return {
    id: "tiny-atlas-png",
    displayName: "Tiny Atlas PNG",
    description: "Importer fixture",
    spritesheetPath: "spritesheet.png",
    ...overrides,
  };
}

function fixtureSpritesheet() {
  return fs.readFileSync(path.join(FIXTURE_DIR, "spritesheet.png"));
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || "");
    const method = entry.method == null ? 0 : entry.method;
    const compressed = method === 8 ? zlib.deflateRawSync(raw) : raw;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralOffset = offset;
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, eocd]);
}

test("parses clawd import URLs and rejects unsafe remote hosts", () => {
  const parsed = importer.parseClawdImportUrl(
    "clawd://import-pet?url=https%3A%2F%2Fexample.test%2Fpets%2Ftiny%2Fpet.json"
  );
  assert.strictEqual(parsed.action, "import-pet");
  assert.strictEqual(parsed.url, "https://example.test/pets/tiny/pet.json");

  assert.throws(
    () => importer.parseClawdImportUrl("clawd://import-pet?url=http%3A%2F%2Fexample.test%2Fpet.json"),
    /https/
  );
  assert.throws(
    () => importer.parseClawdImportUrl("clawd://import-pet?url=https%3A%2F%2Flocalhost%2Fpet.json"),
    /blocked/
  );
});

test("blocks private DNS answers in guarded lookup", async () => {
  await assert.rejects(
    () => importer.guardedLookup("pets.example", {
      lookup: (_host, _opts, cb) => cb(null, [{ address: "192.168.1.10", family: 4 }]),
    }),
    /blocked/
  );

  const resolved = await importer.guardedLookup("pets.example", {
    lookup: (_host, _opts, cb) => cb(null, [{ address: "203.0.113.10", family: 4 }]),
  });
  assert.deepStrictEqual(resolved, { address: "203.0.113.10", family: 4 });
});

test("imports a direct pet.json only with same-directory spritesheet URLs", async () => {
  const root = makeTempDir();
  const manifest = fixtureManifest();
  const spritesheet = fixtureSpritesheet();
  const responses = new Map([
    ["https://example.test/pets/tiny/pet.json", Buffer.from(JSON.stringify(manifest), "utf8")],
    ["https://example.test/pets/tiny/spritesheet.png", spritesheet],
  ]);

  const imported = await importer.importCodexPetFromUrl("https://example.test/pets/tiny/pet.json", {
    codexPetsDir: path.join(root, "pets"),
    fetchBuffer: async (url) => responses.get(url),
  });

  assert.strictEqual(path.basename(imported.packageDir), "tiny-atlas-png");
  assert.strictEqual(fs.existsSync(path.join(imported.packageDir, importer.IMPORT_MARKER_FILENAME)), true);
  assert.strictEqual(adapter.validateCodexPetPackage(imported.packageDir).ok, true);

  await assert.rejects(
    () => importer.importCodexPetFromUrl("https://example.test/pets/tiny/pet.json", {
      codexPetsDir: path.join(root, "pets2"),
      fetchBuffer: async (url) => {
        if (url.endsWith("pet.json")) {
          return Buffer.from(JSON.stringify(fixtureManifest({ spritesheetPath: "../spritesheet.png" })), "utf8");
        }
        return spritesheet;
      },
    }),
    /package directory|manifest directory/
  );
});

test("imports zip packages from root or one top-level folder", async () => {
  const root = makeTempDir();
  const manifest = Buffer.from(JSON.stringify(fixtureManifest()), "utf8");
  const spritesheet = fixtureSpritesheet();
  const zip = makeZip([
    { name: "tiny/pet.json", data: manifest, method: 8 },
    { name: "tiny/spritesheet.png", data: spritesheet, method: 0 },
  ]);

  const imported = await importer.importCodexPetFromZipBuffer(zip, {
    codexPetsDir: path.join(root, "pets"),
  });

  assert.strictEqual(path.basename(imported.packageDir), "tiny-atlas-png");
  assert.strictEqual(adapter.validateCodexPetPackage(imported.packageDir).ok, true);
});

test("rejects unsafe zip paths and missing package files", () => {
  assert.throws(
    () => importer.extractCodexPetZip(makeZip([
      { name: "../pet.json", data: JSON.stringify(fixtureManifest()) },
      { name: "spritesheet.png", data: fixtureSpritesheet() },
    ])),
    /unsafe|absolute/
  );

  assert.throws(
    () => importer.extractCodexPetZip(makeZip([
      { name: "pet.json", data: JSON.stringify(fixtureManifest({ spritesheetPath: "missing.png" })) },
    ])),
    /missing spritesheet/
  );
});

test("does not overwrite non-pet directories in the Codex pets root", async () => {
  const root = makeTempDir();
  const petsDir = path.join(root, "pets");
  fs.mkdirSync(path.join(petsDir, "tiny-atlas-png"), { recursive: true });
  fs.writeFileSync(path.join(petsDir, "tiny-atlas-png", "notes.txt"), "keep", "utf8");

  assert.throws(
    () => importer.installCodexPetPackage({
      manifest: fixtureManifest(),
      files: [{ relativePath: "spritesheet.png", buffer: fixtureSpritesheet() }],
      codexPetsDir: petsDir,
    }),
    /refusing to overwrite/
  );
  assert.strictEqual(fs.readFileSync(path.join(petsDir, "tiny-atlas-png", "notes.txt"), "utf8"), "keep");
});
