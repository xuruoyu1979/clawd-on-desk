"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const createThemeContext = require("./theme-context");
const {
  sanitizeSvg,
  collectSafeRasterRefs: _collectSafeRasterRefs,
} = require("./theme-sanitizer");
const {
  REQUIRED_STATES,
  FULL_SLEEP_REQUIRED_STATES,
  MINI_REQUIRED_STATES,
  VISUAL_FALLBACK_STATES,
  validateTheme,
  mergeDefaults,
  isPlainObject: _isPlainObject,
  hasNonEmptyArray: _hasNonEmptyArray,
  getStateBindingEntry: _getStateBindingEntry,
  getStateFiles: _getStateFiles,
  hasStateFiles: _hasStateFiles,
  hasStateBinding: _hasStateBinding,
  normalizeStateBindings: _normalizeStateBindings,
  hasReactionBindings: _hasReactionBindings,
  supportsIdleTracking: _supportsIdleTracking,
  deriveIdleMode: _deriveIdleMode,
  deriveSleepMode: _deriveSleepMode,
  buildCapabilities: _buildCapabilities,
  collectRequiredAssetFiles: _collectRequiredAssetFiles,
  deepMergeObject: _deepMergeObject,
  basenameOnly: _basenameOnly,
  mergeFileHitBoxes: _mergeFileHitBoxes,
} = require("./theme-schema");

// ── Variant support (Phase 3b-swap) ──
// Allow-list of fields a variant may override. Anything else → ignored + warned
// (see docs/plans/plan-settings-panel-3b-swap.md §6.4 Validator Spec rule 1).
const VARIANT_ALLOWED_KEYS = new Set([
  // Metadata (not merged into runtime theme)
  "name", "description", "preview",
  // Runtime fields (see §6.1 allow-list table)
  "workingTiers", "jugglingTiers", "idleAnimations",
  "wideHitboxFiles", "sleepingHitboxFiles",
  "hitBoxes", "fileHitBoxes", "timings", "transitions",
  "objectScale", "displayHintMap",
]);
// Fields that replace wholesale instead of deep-merge.
// Arrays always replace; `displayHintMap` is explicitly replace per §6.1
// (deep-merge can't express "remove a hint").
const VARIANT_REPLACE_FIELDS = new Set([
  "workingTiers", "jugglingTiers", "idleAnimations",
  "wideHitboxFiles", "sleepingHitboxFiles",
  "displayHintMap",
]);

// ── State ──

let activeTheme = null;
let activeThemeContext = null;
let builtinThemesDir = null;   // set by init()
let assetsSvgDir = null;       // assets/svg/ for built-in theme
let assetsSoundsDir = null;    // assets/sounds/ for built-in theme
let userDataDir = null;        // app.getPath("userData") — set by init()
let userThemesDir = null;      // {userData}/themes/
let themeCacheDir = null;      // {userData}/theme-cache/
let soundOverridesRoot = null; // {userData}/sound-overrides/ — per-theme copied audio

// ── Public API ──

/**
 * Initialize the loader. Call once at startup from main.js.
 * @param {string} appDir - __dirname of the calling module (src/)
 * @param {string} userData - app.getPath("userData")
 */
function init(appDir, userData) {
  builtinThemesDir = path.join(appDir, "..", "themes");
  assetsSvgDir = path.join(appDir, "..", "assets", "svg");
  assetsSoundsDir = path.join(appDir, "..", "assets", "sounds");
  if (userData) {
    userDataDir = userData;
    userThemesDir = path.join(userData, "themes");
    themeCacheDir = path.join(userData, "theme-cache");
    soundOverridesRoot = path.join(userData, "sound-overrides");
  }
  if (activeTheme) activeThemeContext = _createThemeContext(activeTheme);
}

// Directory where sound-override files for `themeId` live. main.js creates /
// reads files here when the user picks a custom audio file. Returns null when
// userData hasn't been wired up yet (test harnesses that call init() without it).
function getSoundOverridesDir(themeId) {
  if (!soundOverridesRoot || typeof themeId !== "string" || !themeId) return null;
  return path.join(soundOverridesRoot, themeId);
}

function _createThemeContext(theme) {
  return createThemeContext(theme, {
    assetsSvgDir,
    assetsSoundsDir,
  });
}

/**
 * Discover all available themes.
 * Scans built-in themes dir + {userData}/themes/
 * @returns {{ id: string, name: string, path: string, builtin: boolean }[]}
 */
function discoverThemes() {
  const themes = [];
  const seen = new Set();

  // Built-in themes
  if (builtinThemesDir) {
    _scanThemesDir(builtinThemesDir, true, themes, seen);
  }

  // User-installed themes (same id as built-in is skipped — built-in takes priority)
  if (userThemesDir) {
    _scanThemesDir(userThemesDir, false, themes, seen);
  }

  return themes;
}

function _scanThemesDir(dir, builtin, themes, seen) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (seen.has(entry.name)) continue;
      const jsonPath = path.join(dir, entry.name, "theme.json");
      let cfg;
      try {
        cfg = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      } catch { continue; }
      if (builtin && cfg && cfg._scaffoldOnly === true) continue;
      themes.push({ id: entry.name, name: cfg.name || entry.name, path: jsonPath, builtin });
      seen.add(entry.name);
    }
  } catch { /* dir not found */ }
}

/**
 * Load and activate a theme by ID.
 *
 * Strict mode throws on missing/invalid; lenient falls back to "clawd".
 * Callers detect fallback by comparing the requested id against
 * `returnedTheme._id` / `returnedTheme._variantId` — no synthetic flag needed.
 *
 * Unknown variant ids always fall back to "default" (even in strict mode) —
 * a missing variant is a UX concern, not a theme-breaking condition.
 *
 * @param {string} themeId
 * @param {{ strict?: boolean, variant?: string, overrides?: object|null }} [opts]
 * @returns {object} merged theme config
 */
function loadTheme(themeId, opts = {}) {
  const strict = !!opts.strict;
  const requestedVariant = typeof opts.variant === "string" && opts.variant ? opts.variant : "default";
  const userOverrides = _isPlainObject(opts.overrides) ? opts.overrides : null;
  const { raw, isBuiltin, themeDir } = _readThemeJson(themeId);

  if (!raw) {
    const msg = `Theme "${themeId}" not found`;
    if (strict) throw new Error(msg);
    console.error(`[theme-loader] ${msg}`);
    if (themeId !== "clawd") return loadTheme("clawd");
    throw new Error("Default theme 'clawd' not found");
  }

  const errors = validateTheme(raw);
  if (errors.length > 0) {
    const msg = `Theme "${themeId}" validation errors: ${errors.join("; ")}`;
    if (strict) throw new Error(msg);
    console.error(`[theme-loader] ${msg}`);
    if (themeId !== "clawd") return loadTheme("clawd");
  }

  // Resolve variant + apply patch BEFORE mergeDefaults so that geometry
  // derivation (imgWidthRatio/imgOffsetX/imgBottom), tier sorting, and
  // basename sanitization all run on the patched raw.
  const { resolvedId, spec: variantSpec } = _resolveVariant(raw, requestedVariant);
  const afterVariant = variantSpec ? _applyVariantPatch(raw, variantSpec, themeId, resolvedId) : raw;
  const patchedRaw = userOverrides ? _applyUserOverridesPatch(afterVariant, userOverrides) : afterVariant;

  // Merge defaults for optional fields
  const theme = mergeDefaults(patchedRaw, themeId, isBuiltin);
  theme._themeDir = themeDir;
  theme._variantId = resolvedId;
  theme._userOverrides = userOverrides;
  theme._bindingBase = _buildBaseBindingMetadata(afterVariant);
  theme._capabilities = _buildCapabilities(theme);

  // For external themes: sanitize SVGs + resolve asset paths
  if (!isBuiltin) {
    const assetsDir = _resolveExternalAssetsDir(themeId, themeDir, { strict });
    theme._assetsDir = assetsDir;
    theme._assetsFileUrl = pathToFileURL(assetsDir).href;
  } else {
    theme._assetsDir = assetsSvgDir;
    theme._assetsFileUrl = null; // built-in uses relative path
  }

  theme._soundOverrideFiles = _resolveSoundOverrideFiles(themeId, userOverrides);

  activeTheme = theme;
  activeThemeContext = _createThemeContext(theme);
  return theme;
}

// Turn prefs.themeOverrides[themeId].sounds into an absolute-path map. Missing
// files are dropped silently so playback falls back to the theme's default
// without spamming the console every time a user deletes an override file by
// hand. main.js is responsible for copying picked audio into this directory.
function _resolveSoundOverrideFiles(themeId, userOverrides) {
  if (!_isPlainObject(userOverrides)) return null;
  const soundMap = _isPlainObject(userOverrides.sounds) ? userOverrides.sounds : null;
  if (!soundMap) return null;
  const dir = getSoundOverridesDir(themeId);
  if (!dir) return null;
  const out = {};
  for (const [soundName, entry] of Object.entries(soundMap)) {
    if (!_isPlainObject(entry)) continue;
    const filename = typeof entry.file === "string" ? _basenameOnly(entry.file) : null;
    if (!filename) continue;
    const absPath = path.join(dir, filename);
    if (!fs.existsSync(absPath)) continue;
    out[soundName] = absPath;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Read theme.json from built-in or user themes directory.
 */
function _readThemeJson(themeId) {
  // Built-in first
  if (builtinThemesDir) {
    const builtinPath = path.resolve(builtinThemesDir, themeId, "theme.json");
    if (!_isPathInsideDir(builtinThemesDir, builtinPath)) {
      console.error(`[theme-loader] Path traversal detected for built-in theme "${themeId}"`);
      return { raw: null, isBuiltin: false, themeDir: null };
    }
    if (fs.existsSync(builtinPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(builtinPath, "utf8"));
        return { raw, isBuiltin: true, themeDir: path.dirname(builtinPath) };
      } catch (e) {
        console.error(`[theme-loader] Failed to parse built-in theme "${themeId}":`, e.message);
      }
    }
  }

  // User themes
  if (userThemesDir) {
    const userPath = path.resolve(userThemesDir, themeId, "theme.json");
    if (fs.existsSync(userPath)) {
      // Path traversal check: resolved path must be within userThemesDir
      if (!_isPathInsideDir(userThemesDir, userPath)) {
        console.error(`[theme-loader] Path traversal detected for theme "${themeId}"`);
        return { raw: null, isBuiltin: false, themeDir: null };
      }
      try {
        const raw = JSON.parse(fs.readFileSync(userPath, "utf8"));
        return { raw, isBuiltin: false, themeDir: path.dirname(userPath) };
      } catch (e) {
        console.error(`[theme-loader] Failed to parse user theme "${themeId}":`, e.message);
      }
    }
  }

  return { raw: null, isBuiltin: false, themeDir: null };
}

/**
 * Resolve external theme assets: sanitize SVGs → cache dir, return cache path.
 * Non-SVG files (GIF/APNG/WebP) are used directly from theme dir (no sanitization needed).
 */
function _resolveExternalAssetsDir(themeId, themeDir, opts = {}) {
  const strict = !!(opts && opts.strict);
  const sourceAssetsDir = path.join(themeDir, "assets");
  if (!themeCacheDir) return sourceAssetsDir;

  const cacheDir = path.join(themeCacheDir, themeId, "assets");
  const cacheMetaPath = path.join(themeCacheDir, themeId, ".cache-meta.json");

  // Load existing cache meta
  let cacheMeta = _emptyCacheMeta();
  let metaChanged = false;
  let forceSvgRefresh = false;
  try {
    const rawMeta = JSON.parse(fs.readFileSync(cacheMetaPath, "utf8"));
    const normalized = _normalizeCacheMeta(rawMeta);
    cacheMeta = normalized.meta;
    metaChanged = normalized.changed;
    forceSvgRefresh = normalized.invalidateSvgs;
  } catch { /* no cache yet */ }

  // Ensure cache directory exists
  fs.mkdirSync(cacheDir, { recursive: true });

  // Scan source assets and sanitize SVGs
  const rasterRefs = new Map();
  try {
    const files = fs.readdirSync(sourceAssetsDir);
    for (const file of files) {
      const srcFile = path.join(sourceAssetsDir, file);

      // Path traversal check
      const resolvedSrc = path.resolve(srcFile);
      if (!resolvedSrc.startsWith(path.resolve(sourceAssetsDir) + path.sep) &&
          resolvedSrc !== path.resolve(sourceAssetsDir)) {
        console.warn(`[theme-loader] Skipping suspicious path: ${file}`);
        continue;
      }

      let stat;
      try { stat = fs.statSync(srcFile); } catch { continue; }
      if (!stat.isFile()) continue;

      if (file.endsWith(".svg")) {
        // Check cache freshness
        const cachedSvgPath = path.join(cacheDir, file);
        const cached = cacheMeta.svgs[file];
        let sanitized = null;
        if (!forceSvgRefresh && cached && cached.mtime === stat.mtimeMs && cached.size === stat.size && fs.existsSync(cachedSvgPath)) {
          try {
            sanitized = fs.readFileSync(cachedSvgPath, "utf8");
          } catch {
            sanitized = null;
          }
        }

        // Sanitize and cache when stale/missing
        try {
          if (sanitized == null) {
            const svgContent = fs.readFileSync(srcFile, "utf8");
            sanitized = sanitizeSvg(svgContent);
            fs.writeFileSync(cachedSvgPath, sanitized, "utf8");
            cacheMeta.svgs[file] = { mtime: stat.mtimeMs, size: stat.size };
            metaChanged = true;
          }
          for (const ref of _collectSafeRasterRefs(sanitized, sourceAssetsDir).values()) {
            rasterRefs.set(ref.destRel, ref);
          }
        } catch (e) {
          console.error(`[theme-loader] Failed to sanitize ${file}:`, e.message);
        }
      }
      // Unreferenced non-SVG files are still served directly from source.
      // Safe raster dependencies referenced by sanitized SVGs are copied below
      // so cached SVG documents can resolve them relatively.
    }
  } catch (e) {
    console.error(`[theme-loader] Failed to scan assets for theme "${themeId}":`, e.message);
  }

  const rasterCopyResult = _syncRasterCache(themeId, cacheDir, cacheMeta, rasterRefs);
  if (rasterCopyResult.changed) metaChanged = true;

  if (metaChanged) {
    try {
      fs.writeFileSync(cacheMetaPath, JSON.stringify(cacheMeta, null, 2), "utf8");
    } catch {}
  }

  if (strict && rasterCopyResult.missing.length > 0) {
    throw new Error(
      `Theme "${themeId}" missing raster dependencies: ${rasterCopyResult.missing.join(", ")}`
    );
  }

  return cacheDir; // SVGs from cache, non-SVGs resolved at getAssetPath() time
}

function _externalAssetsSourceDir(themeDir) {
  return path.join(themeDir, "assets");
}

function _emptyCacheMeta() {
  return { version: 2, svgs: {}, rasters: {} };
}

function _normalizeCacheMeta(value) {
  if (value && value.version === 2) {
    return {
      meta: {
        version: 2,
        svgs: _isPlainObject(value.svgs) ? value.svgs : {},
        rasters: _isPlainObject(value.rasters) ? value.rasters : {},
      },
      changed: false,
      invalidateSvgs: false,
    };
  }
  if (_isPlainObject(value)) {
    const svgs = {};
    for (const [file, entry] of Object.entries(value)) {
      if (file === "version" || file === "svgs" || file === "rasters") continue;
      if (!_isPlainObject(entry)) continue;
      svgs[file] = entry;
    }
    return { meta: { version: 2, svgs, rasters: {} }, changed: true, invalidateSvgs: true };
  }
  return { meta: _emptyCacheMeta(), changed: true, invalidateSvgs: true };
}

function _removeCachedRaster(cacheDir, relPath) {
  try {
    fs.rmSync(path.join(cacheDir, ...relPath.split("/")), { force: true });
  } catch {}
}

function _copyRasterToCache(sourceAbs, destAbs, stat) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  const tmp = `${destAbs}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.copyFileSync(sourceAbs, tmp);
    const tmpStat = fs.statSync(tmp);
    if (!tmpStat.isFile() || tmpStat.size !== stat.size) {
      throw new Error("copied raster size mismatch");
    }
    fs.renameSync(tmp, destAbs);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

function _syncRasterCache(themeId, cacheDir, cacheMeta, rasterRefs) {
  let changed = false;
  const missing = [];
  const referenced = new Set(rasterRefs.keys());
  const sourceStats = new Map();

  for (const [destRel, ref] of rasterRefs.entries()) {
    let stat = sourceStats.get(ref.sourceKey);
    if (!stat) {
      try {
        stat = fs.statSync(ref.sourceAbs);
      } catch {
        console.warn(`[theme-loader] Missing raster dependency for theme "${themeId}": ${ref.sourceRel}`);
        missing.push(ref.sourceRel);
        _removeCachedRaster(cacheDir, destRel);
        if (cacheMeta.rasters[destRel]) {
          delete cacheMeta.rasters[destRel];
          changed = true;
        }
        continue;
      }
      sourceStats.set(ref.sourceKey, stat);
    }
    if (!stat.isFile()) {
      console.warn(`[theme-loader] Raster dependency is not a file for theme "${themeId}": ${ref.sourceRel}`);
      missing.push(ref.sourceRel);
      _removeCachedRaster(cacheDir, destRel);
      if (cacheMeta.rasters[destRel]) {
        delete cacheMeta.rasters[destRel];
        changed = true;
      }
      continue;
    }

    const destAbs = path.join(cacheDir, ...destRel.split("/"));
    const cached = cacheMeta.rasters[destRel];
    let destStat = null;
    try { destStat = fs.statSync(destAbs); } catch {}
    if (
      cached
      && cached.source === ref.sourceRel
      && cached.mtime === stat.mtimeMs
      && cached.size === stat.size
      && destStat
      && destStat.isFile()
      && destStat.size === stat.size
    ) {
      continue;
    }

    try {
      _copyRasterToCache(ref.sourceAbs, destAbs, stat);
      cacheMeta.rasters[destRel] = {
        source: ref.sourceRel,
        mtime: stat.mtimeMs,
        size: stat.size,
      };
      changed = true;
    } catch (e) {
      console.error(`[theme-loader] Failed to cache raster ${ref.sourceRel} for theme "${themeId}":`, e.message);
      _removeCachedRaster(cacheDir, destRel);
      if (cacheMeta.rasters[destRel]) {
        delete cacheMeta.rasters[destRel];
        changed = true;
      }
    }
  }

  for (const relPath of Object.keys(cacheMeta.rasters)) {
    if (referenced.has(relPath)) continue;
    _removeCachedRaster(cacheDir, relPath);
    delete cacheMeta.rasters[relPath];
    changed = true;
  }

  return { changed, missing };
}

/**
 * @returns {object|null} current active theme config
 */
function getActiveTheme() {
  return activeTheme;
}

/**
 * Resolve a display hint filename to current theme's file.
 * @param {string} hookFilename - original filename from hook/server
 * @returns {string|null} theme-local filename, or null if not mapped
 */
function resolveHint(hookFilename) {
  if (!activeTheme || !activeTheme.displayHintMap) return null;
  return activeTheme.displayHintMap[hookFilename] || null;
}

/**
 * Get the absolute directory path for assets of the active theme.
 * Built-in: assets/svg/. External: theme-cache for SVGs, theme dir for non-SVGs.
 * @returns {string} absolute directory path
 */
/**
 * Get asset path for a specific file.
 * For external themes: SVGs come from cache, non-SVGs from source theme dir.
 * @param {string} filename
 * @returns {string} absolute file path
 */
function getAssetPath(filename) {
  if (activeThemeContext) return activeThemeContext.resolveAssetPath(filename);
  return _resolveAssetPath(activeTheme, filename);
}

function _resolveAssetPath(theme, filename) {
  if (theme === activeTheme && activeThemeContext) return activeThemeContext.resolveAssetPath(filename);
  return _createThemeContext(theme).resolveAssetPath(filename);
}

/**
 * Get asset path prefix for renderer (used in <object data="..."> and <img src="...">).
 * Built-in: relative path. External: file:// URL.
 * @returns {string} path prefix
 */
function getRendererAssetsPath() {
  return activeThemeContext ? activeThemeContext.getRendererAssetsPath() : "../assets/svg";
}

/**
 * Get the base file:// URL for non-SVG assets of external themes.
 * For <img> loading of GIF/APNG/WebP files that live in the source theme dir.
 * @returns {string|null} file:// URL or null for built-in
 */
function getRendererSourceAssetsPath() {
  return activeThemeContext ? activeThemeContext.getRendererSourceAssetsPath() : null;
}

/**
 * Build config object to inject into renderer process (via additionalArguments or IPC).
 * Contains only the subset renderer.js needs.
 */
function getRendererConfig() {
  return activeThemeContext ? activeThemeContext.getRendererConfig() : null;
}

/**
 * Build config object to inject into hit-renderer process.
 */
function getHitRendererConfig() {
  return activeThemeContext ? activeThemeContext.getHitRendererConfig() : null;
}

/**
 * Ensure the user themes directory exists.
 * @returns {string} absolute path to user themes dir
 */
function ensureUserThemesDir() {
  if (!userThemesDir) return null;
  try {
    fs.mkdirSync(userThemesDir, { recursive: true });
  } catch {}
  return userThemesDir;
}

// ── Validation ──

function validateThemeShape(themeId, opts = {}) {
  const variant = typeof opts.variant === "string" && opts.variant ? opts.variant : "default";
  const overrides = _isPlainObject(opts.overrides) ? opts.overrides : null;
  const { raw, isBuiltin, themeDir } = _readThemeJson(themeId);
  if (!raw) {
    return {
      ok: false,
      errors: [`Theme "${themeId}" not found`],
      themeId,
      variant,
      resolvedVariant: null,
    };
  }

  const rawErrors = validateTheme(raw);
  const { resolvedId, spec } = _resolveVariant(raw, variant);
  const afterVariant = spec ? _applyVariantPatch(raw, spec, themeId, resolvedId) : raw;
  const patched = overrides ? _applyUserOverridesPatch(afterVariant, overrides) : afterVariant;
  const effective = mergeDefaults(patched, themeId, isBuiltin);

  effective._builtin = isBuiltin;
  effective._themeDir = themeDir;
  effective._variantId = resolvedId;
  effective._assetsDir = isBuiltin ? assetsSvgDir : _externalAssetsSourceDir(themeDir);

  const effectiveErrors = validateTheme(patched);
  const resourceErrors = _validateRequiredAssets(effective);
  const errors = [...rawErrors, ...effectiveErrors, ...resourceErrors];

  return {
    ok: errors.length === 0,
    errors,
    themeId,
    variant,
    resolvedVariant: resolvedId,
  };
}

// ── Internal helpers ──

function _isPathInsideDir(baseDir, candidatePath) {
  if (!baseDir || !candidatePath) return false;
  const base = path.resolve(baseDir);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(base, candidate);
  const firstSegment = relative.split(/[\\/]/)[0];
  return relative === "" || (!!relative && firstSegment !== ".." && !path.isAbsolute(relative));
}

function _validateRequiredAssets(theme) {
  const errors = [];
  for (const filename of _collectRequiredAssetFiles(theme)) {
    const absPath = _resolveAssetPath(theme, filename);
    if (!fs.existsSync(absPath)) {
      errors.push(`missing asset: ${filename} (${absPath})`);
    }
  }
  return errors;
}

/**
 * Resolve a requested variant id against the theme's declared variants.
 * Synthesises a `default` variant when the author didn't declare one so the
 * UI can always show at least one option.
 * Unknown variant ids lenient-fallback to `default`.
 *
 * @returns {{ resolvedId: string, spec: object|null }}
 *   `spec` is null when the resolved variant is a synthetic default (no patch needed).
 */
function _resolveVariant(raw, requestedVariant) {
  const rawVariants = _isPlainObject(raw.variants) ? raw.variants : {};
  const hasExplicitDefault = _isPlainObject(rawVariants.default);
  const targetId = requestedVariant || "default";

  if (rawVariants[targetId] && _isPlainObject(rawVariants[targetId])) {
    return { resolvedId: targetId, spec: rawVariants[targetId] };
  }
  // Unknown variant → lenient fallback to default (synthetic or explicit)
  if (hasExplicitDefault) {
    return { resolvedId: "default", spec: rawVariants.default };
  }
  return { resolvedId: "default", spec: null };
}

/**
 * Apply a variant spec on top of raw theme config.
 * - allow-list fields are patched per `VARIANT_REPLACE_FIELDS` (replace vs deep-merge)
 * - out-of-list fields are ignored with a warning (author typos surface clearly)
 * - metadata fields (name/description/preview) are stripped — they belong to the
 *   variant metadata layer, not runtime theme config
 *
 * Runs on raw before mergeDefaults so downstream geometry derivation sees
 * the patched values (see §6.1 rationale in plan-settings-panel-3b-swap.md).
 */
function _applyVariantPatch(raw, variantSpec, themeId, variantId) {
  const patched = { ...raw };
  for (const [key, value] of Object.entries(variantSpec)) {
    // Metadata-only fields — don't copy into runtime config
    if (key === "name" || key === "description" || key === "preview") continue;
    if (!VARIANT_ALLOWED_KEYS.has(key)) {
      console.warn(`[theme-loader] variant "${themeId}:${variantId}" declares ignored field "${key}" (not in allow-list)`);
      continue;
    }
    if (key === "fileHitBoxes") {
      patched.fileHitBoxes = _mergeFileHitBoxes(patched.fileHitBoxes, value);
      continue;
    }
    if (VARIANT_REPLACE_FIELDS.has(key) || Array.isArray(value)) {
      patched[key] = value;
    } else if (_isPlainObject(value)) {
      patched[key] = _isPlainObject(patched[key]) ? _deepMergeObject(patched[key], value) : value;
    } else {
      patched[key] = value;
    }
  }
  return patched;
}

function _normalizeTransitionOverride(transition) {
  if (!_isPlainObject(transition)) return null;
  const out = {};
  if (Number.isFinite(transition.in)) out.in = transition.in;
  if (Number.isFinite(transition.out)) out.out = transition.out;
  return Object.keys(out).length > 0 ? out : null;
}

function _buildBaseBindingMetadata(raw) {
  const states = {};
  if (_isPlainObject(raw.states)) {
    for (const [stateKey, entry] of Object.entries(raw.states)) {
      if (stateKey.startsWith("_")) continue;
      const files = _getStateFiles(entry);
      if (files[0]) states[stateKey] = _basenameOnly(files[0]);
    }
  }
  const miniStates = {};
  if (_isPlainObject(raw.miniMode) && _isPlainObject(raw.miniMode.states)) {
    for (const [stateKey, entry] of Object.entries(raw.miniMode.states)) {
      if (stateKey.startsWith("_")) continue;
      if (Array.isArray(entry) && entry[0]) miniStates[stateKey] = _basenameOnly(entry[0]);
    }
  }
  const mapTierGroup = (tiers) =>
    Array.isArray(tiers)
      ? tiers
        .filter((tier) => _isPlainObject(tier))
        .map((tier) => ({
          minSessions: Number.isFinite(tier.minSessions) ? tier.minSessions : 0,
          originalFile: _basenameOnly(tier.file),
        }))
        .sort((a, b) => b.minSessions - a.minSessions)
      : [];
  const idleAnimations = Array.isArray(raw.idleAnimations)
    ? raw.idleAnimations
      .filter((entry) => _isPlainObject(entry) && typeof entry.file === "string" && entry.file)
      .map((entry, index) => ({
        index,
        originalFile: _basenameOnly(entry.file),
        duration: Number.isFinite(entry.duration) ? entry.duration : null,
      }))
    : [];
  const displayHintMap = {};
  if (_isPlainObject(raw.displayHintMap)) {
    for (const [key, value] of Object.entries(raw.displayHintMap)) {
      displayHintMap[_basenameOnly(key)] = _basenameOnly(value);
    }
  }
  return {
    states,
    miniStates,
    workingTiers: mapTierGroup(raw.workingTiers),
    jugglingTiers: mapTierGroup(raw.jugglingTiers),
    idleAnimations,
    displayHintMap,
  };
}

function _ensureTransitionsPatch(patched) {
  if (!_isPlainObject(patched.transitions)) patched.transitions = {};
  return patched.transitions;
}

function _applyTransitionOverride(patched, targetFile, transition) {
  const cleanTarget = _basenameOnly(targetFile);
  const cleanTransition = _normalizeTransitionOverride(transition);
  if (!cleanTarget || !cleanTransition) return;
  const nextTransitions = _ensureTransitionsPatch(patched);
  const prev = _isPlainObject(nextTransitions[cleanTarget]) ? nextTransitions[cleanTarget] : {};
  nextTransitions[cleanTarget] = { ...prev, ...cleanTransition };
}

function _applyUserOverridesPatch(raw, overrides) {
  if (!_isPlainObject(overrides)) return raw;
  const patched = { ...raw };

  const stateOverrides = _isPlainObject(overrides.states) ? overrides.states : {};
  if (Object.keys(stateOverrides).length > 0) {
    const nextStates = { ...raw.states };
    const nextMiniMode = _isPlainObject(raw.miniMode) ? { ...raw.miniMode } : null;
    const nextMiniStates = nextMiniMode && _isPlainObject(raw.miniMode.states)
      ? { ...raw.miniMode.states }
      : null;
    for (const [stateKey, entry] of Object.entries(stateOverrides)) {
      if (!_isPlainObject(entry)) continue;
      const rawStateEntry = nextStates[stateKey];
      const rawMiniEntry = nextMiniStates ? nextMiniStates[stateKey] : undefined;
      const targetCollection = rawStateEntry !== undefined
        ? nextStates
        : (rawMiniEntry !== undefined ? nextMiniStates : null);
      if (!targetCollection) continue;
      const currentState = _getStateBindingEntry(targetCollection[stateKey]);
      const currentFiles = currentState.files;
      if (currentFiles.length === 0 && !(typeof entry.file === "string" && entry.file)) continue;
      const nextFiles = [...currentFiles];
      if (typeof entry.file === "string" && entry.file) {
        if (nextFiles.length > 0) nextFiles[0] = entry.file;
        else nextFiles.push(entry.file);
      }
      if (Array.isArray(targetCollection[stateKey])) {
        targetCollection[stateKey] = nextFiles;
      } else if (_isPlainObject(targetCollection[stateKey])) {
        targetCollection[stateKey] = { ...targetCollection[stateKey], files: nextFiles };
      } else {
        targetCollection[stateKey] = nextFiles;
      }
      const transitionTarget = (typeof entry.file === "string" && entry.file) ? entry.file : nextFiles[0];
      _applyTransitionOverride(patched, transitionTarget, entry.transition);
    }
    patched.states = nextStates;
    if (nextMiniMode && nextMiniStates) {
      nextMiniMode.states = nextMiniStates;
      patched.miniMode = nextMiniMode;
    }
  }

  const tierGroups = _isPlainObject(overrides.tiers) ? overrides.tiers : {};
  for (const tierGroup of ["workingTiers", "jugglingTiers"]) {
    const tierOverrides = _isPlainObject(tierGroups[tierGroup]) ? tierGroups[tierGroup] : null;
    const rawTiers = Array.isArray(raw[tierGroup]) ? raw[tierGroup] : null;
    if (!tierOverrides || !rawTiers) continue;
    const nextTiers = rawTiers.map((tier) => (_isPlainObject(tier) ? { ...tier } : tier));
    for (const [originalFile, entry] of Object.entries(tierOverrides)) {
      if (!_isPlainObject(entry)) continue;
      const cleanOriginal = _basenameOnly(originalFile);
      const tier = nextTiers.find((candidate) =>
        _isPlainObject(candidate) && _basenameOnly(candidate.file) === cleanOriginal
      );
      if (!tier) continue;
      if (typeof entry.file === "string" && entry.file) {
        tier.file = entry.file;
      }
      const transitionTarget = (typeof entry.file === "string" && entry.file) ? entry.file : tier.file;
      _applyTransitionOverride(patched, transitionTarget, entry.transition);
    }
    patched[tierGroup] = nextTiers;
  }

  const timings = _isPlainObject(overrides.timings) ? overrides.timings : null;
  const autoReturn = timings && _isPlainObject(timings.autoReturn) ? timings.autoReturn : null;
  if (autoReturn) {
    const nextTimings = _isPlainObject(raw.timings) ? _deepMergeObject(raw.timings, {}) : {};
    nextTimings.autoReturn = _isPlainObject(nextTimings.autoReturn) ? { ...nextTimings.autoReturn } : {};
    for (const [stateKey, value] of Object.entries(autoReturn)) {
      if (!Number.isFinite(value)) continue;
      nextTimings.autoReturn[stateKey] = value;
    }
    patched.timings = nextTimings;
  }

  // Per-file wide-hitbox opt-in/opt-out. Only touches the file list the theme
  // publishes — doesn't regenerate HIT_BOXES. state.js rebuilds WIDE_SVGS from
  // theme.wideHitboxFiles on refreshTheme, so the merged list flows through.
  const hitboxOverrides = _isPlainObject(overrides.hitbox) ? overrides.hitbox : null;
  const wideOverrides = hitboxOverrides && _isPlainObject(hitboxOverrides.wide) ? hitboxOverrides.wide : null;
  if (wideOverrides && Object.keys(wideOverrides).length > 0) {
    const currentSet = new Set(
      (Array.isArray(patched.wideHitboxFiles) ? patched.wideHitboxFiles : []).map(_basenameOnly)
    );
    for (const [file, enabled] of Object.entries(wideOverrides)) {
      const bn = _basenameOnly(file);
      if (!bn) continue;
      if (enabled) currentSet.add(bn);
      else currentSet.delete(bn);
    }
    patched.wideHitboxFiles = [...currentSet];
  }

  const reactionOverrides = _isPlainObject(overrides.reactions) ? overrides.reactions : null;
  if (reactionOverrides && _isPlainObject(raw.reactions)) {
    const nextReactions = { ...raw.reactions };
    for (const [reactionKey, entry] of Object.entries(reactionOverrides)) {
      if (!_isPlainObject(entry)) continue;
      const rawReaction = nextReactions[reactionKey];
      if (!_isPlainObject(rawReaction)) continue;
      const nextReaction = { ...rawReaction };
      const hasNewFile = typeof entry.file === "string" && entry.file;
      if (hasNewFile) {
        // `double` reaction stores a files array (random pool). The MVP exposes
        // only files[0] to users, so overriding replaces the first entry while
        // keeping the rest of the pool intact.
        if (Array.isArray(nextReaction.files) && nextReaction.files.length > 0) {
          nextReaction.files = [entry.file, ...nextReaction.files.slice(1)];
        } else {
          nextReaction.file = entry.file;
        }
      }
      if (Number.isFinite(entry.durationMs)) {
        nextReaction.duration = entry.durationMs;
      }
      nextReactions[reactionKey] = nextReaction;
      const transitionTarget = hasNewFile
        ? entry.file
        : (nextReaction.file || (Array.isArray(nextReaction.files) ? nextReaction.files[0] : null));
      if (transitionTarget) _applyTransitionOverride(patched, transitionTarget, entry.transition);
    }
    patched.reactions = nextReactions;
  }

  const idleAnimationOverrides = _isPlainObject(overrides.idleAnimations) ? overrides.idleAnimations : null;
  if (idleAnimationOverrides && Array.isArray(raw.idleAnimations)) {
    const nextIdleAnimations = raw.idleAnimations.map((entry) => (_isPlainObject(entry) ? { ...entry } : entry));
    for (const [originalFile, entry] of Object.entries(idleAnimationOverrides)) {
      if (!_isPlainObject(entry)) continue;
      const cleanOriginal = _basenameOnly(originalFile);
      const idleAnimation = nextIdleAnimations.find((candidate) =>
        _isPlainObject(candidate) && _basenameOnly(candidate.file) === cleanOriginal
      );
      if (!idleAnimation) continue;
      if (typeof entry.file === "string" && entry.file) {
        idleAnimation.file = entry.file;
      }
      if (Number.isFinite(entry.durationMs)) {
        idleAnimation.duration = entry.durationMs;
      }
      const transitionTarget = (typeof entry.file === "string" && entry.file) ? entry.file : idleAnimation.file;
      _applyTransitionOverride(patched, transitionTarget, entry.transition);
    }
    patched.idleAnimations = nextIdleAnimations;
  }

  return patched;
}

/**
 * Build preview URL for a single variant. Fallback chain:
 *   variant.preview → variant.idleAnimations[0].file → root theme preview
 *
 * Avoids "all variant cards show the same preview" when variants only differ
 * in tiers/timings but not in any visible asset.
 */
function _buildVariantPreviewUrl(raw, variantSpec, themeDir, isBuiltin) {
  let previewFile = null;
  if (variantSpec) {
    if (typeof variantSpec.preview === "string" && variantSpec.preview) {
      previewFile = variantSpec.preview;
    } else if (Array.isArray(variantSpec.idleAnimations)
               && variantSpec.idleAnimations[0]
               && typeof variantSpec.idleAnimations[0].file === "string") {
      previewFile = variantSpec.idleAnimations[0].file;
    }
  }
  if (previewFile) {
    const filename = path.basename(previewFile);
    const themeLocal = path.join(themeDir, "assets", filename);
    if (fs.existsSync(themeLocal)) {
      try { return pathToFileURL(themeLocal).href; } catch {}
    }
    if (isBuiltin && assetsSvgDir) {
      const central = path.join(assetsSvgDir, filename);
      if (fs.existsSync(central)) {
        try { return pathToFileURL(central).href; } catch {}
      }
    }
  }
  return _buildPreviewUrl(raw, themeDir, isBuiltin);
}

/**
 * Normalize a theme's variants for metadata consumers (settings panel).
 * - Always includes a `default` entry (synthetic if author didn't declare one)
 * - Each entry: { id, name, description, previewFileUrl }
 * - `name` / `description` preserved as-is (string or {en,zh} — UI handles i18n)
 */
function _buildVariantMetadata(raw, themeDir, isBuiltin) {
  const rawVariants = _isPlainObject(raw.variants) ? raw.variants : {};
  const hasExplicitDefault = _isPlainObject(rawVariants.default);
  const out = [];

  if (!hasExplicitDefault) {
    // i18n object — settings-renderer's localizeField() picks the right key.
    // Don't reuse raw.name here: that would label the synthetic default with
    // the theme's own name (e.g. "Clawd"), creating a confusing duplicate of
    // the theme card's title inside its own variant strip.
    out.push({
      id: "default",
      name: { en: "Standard", zh: "标准" },
      description: null,
      previewFileUrl: _buildPreviewUrl(raw, themeDir, isBuiltin),
    });
  }
  for (const [id, spec] of Object.entries(rawVariants)) {
    if (!_isPlainObject(spec)) continue;
    out.push({
      id,
      name: (spec.name != null) ? spec.name : id,
      description: (spec.description != null) ? spec.description : null,
      previewFileUrl: _buildVariantPreviewUrl(raw, spec, themeDir, isBuiltin),
    });
  }
  return out;
}

/**
 * Resolve a logical sound name to an absolute file:// URL.
 * Built-in themes: assets/sounds/. External themes: {themeDir}/sounds/.
 * @param {string} soundName - logical name (e.g. "complete")
 * @returns {string|null} file:// URL, or null if sound not defined
 */
function getSoundUrl(soundName) {
  return activeThemeContext ? activeThemeContext.getSoundUrl(soundName) : null;
}

function getPreviewSoundUrl() {
  return getSoundUrl("confirm") || getSoundUrl("complete") || null;
}

// basename() strips any path segments in theme.json so a malicious
// `preview: "../../foo"` can't escape the theme dir.
function _buildPreviewUrl(raw, themeDir, isBuiltin) {
  const previewFile = (typeof raw.preview === "string" && raw.preview)
    || _getStateFiles(raw.states && raw.states.idle)[0]
    || null;
  if (!previewFile) return null;
  const filename = path.basename(previewFile);
  // clawd reuses assets/svg/ at repo root; calico + user themes have their own.
  let absPath = null;
  const themeLocal = path.join(themeDir, "assets", filename);
  if (fs.existsSync(themeLocal)) {
    absPath = themeLocal;
  } else if (isBuiltin && assetsSvgDir) {
    const central = path.join(assetsSvgDir, filename);
    if (fs.existsSync(central)) absPath = central;
  }
  if (!absPath) return null;
  try { return pathToFileURL(absPath).href; } catch { return null; }
}

/**
 * Read metadata for a single theme WITHOUT activating it.
 * Returns null for missing/malformed themes.
 */
function getThemeMetadata(themeId) {
  const { raw, isBuiltin, themeDir } = _readThemeJson(themeId);
  if (!raw) return null;
  return {
    id: themeId,
    name: raw.name || themeId,
    builtin: !!isBuiltin,
    previewFileUrl: _buildPreviewUrl(raw, themeDir, isBuiltin),
    previewContentRatio: _computePreviewContentRatio(raw),
    previewContentOffsetPct: _computePreviewContentOffsetPct(raw),
    variants: _buildVariantMetadata(raw, themeDir, isBuiltin),
    capabilities: _buildCapabilities(raw),
  };
}

// Ratio of the theme's actual pet content vs the full viewBox. Lets the
// settings panel normalize preview sizes across themes whose assets have
// wildly different canvas utilization (pixel pets with lots of transparent
// margin vs APNG cats that fill the whole frame).
function _computePreviewContentRatio(raw) {
  const vb = raw && raw.viewBox;
  const cb = raw && raw.layout && raw.layout.contentBox;
  if (!vb || !cb) return null;
  if (!(vb.width > 0) || !(vb.height > 0)) return null;
  if (!(cb.width > 0) || !(cb.height > 0)) return null;
  return Math.max(cb.width / vb.width, cb.height / vb.height);
}

// How far the contentBox center sits away from the viewBox center, as a
// percentage of viewBox size. Themes like clawd place the pet near the bottom
// of the viewBox (baseline-anchored) so the preview thumbnail looks bottom-
// heavy — the renderer applies a matching transform to recenter it visually.
function _computePreviewContentOffsetPct(raw) {
  const vb = raw && raw.viewBox;
  const cb = raw && raw.layout && raw.layout.contentBox;
  if (!vb || !cb) return null;
  if (!(vb.width > 0) || !(vb.height > 0)) return null;
  const cbCenterX = cb.x + cb.width / 2;
  const cbCenterY = cb.y + cb.height / 2;
  const vbCenterX = vb.x + vb.width / 2;
  const vbCenterY = vb.y + vb.height / 2;
  return {
    x: -((cbCenterX - vbCenterX) / vb.width) * 100,
    y: -((cbCenterY - vbCenterY) / vb.height) * 100,
  };
}

/**
 * Single-pass scan + metadata build — used by the settings panel.
 * Avoids the O(2N) read that `discoverThemes() + getThemeMetadata() per id`
 * would incur since this path fires on every theme-tab open and on every
 * `theme` / `themeOverrides` broadcast.
 */
function listThemesWithMetadata() {
  const themes = [];
  const seen = new Set();
  if (builtinThemesDir) _scanMetadata(builtinThemesDir, true, themes, seen);
  if (userThemesDir) _scanMetadata(userThemesDir, false, themes, seen);
  return themes;
}

function _scanMetadata(dir, builtin, themes, seen) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      const jsonPath = path.join(dir, entry.name, "theme.json");
      let raw;
      try { raw = JSON.parse(fs.readFileSync(jsonPath, "utf8")); } catch { continue; }
      if (builtin && raw && raw._scaffoldOnly === true) continue;
      const themeDir = path.join(dir, entry.name);
      themes.push({
        id: entry.name,
        name: raw.name || entry.name,
        builtin,
        previewFileUrl: _buildPreviewUrl(raw, themeDir, builtin),
        previewContentRatio: _computePreviewContentRatio(raw),
        previewContentOffsetPct: _computePreviewContentOffsetPct(raw),
        variants: _buildVariantMetadata(raw, themeDir, builtin),
        capabilities: _buildCapabilities(raw),
      });
      seen.add(entry.name);
    }
  } catch { /* dir missing */ }
}

module.exports = {
  init,
  discoverThemes,
  loadTheme,
  validateThemeShape,
  getActiveTheme,
  getThemeMetadata,
  listThemesWithMetadata,
  resolveHint,
  getAssetPath,
  getRendererAssetsPath,
  getRendererSourceAssetsPath,
  getRendererConfig,
  getHitRendererConfig,
  ensureUserThemesDir,
  getSoundUrl,
  getPreviewSoundUrl,
  getSoundOverridesDir,
  _resolveAssetPath,
  _externalAssetsSourceDir,
  _validateRequiredAssets,
  // Schema constants + helpers are re-exported for backward compatibility with
  // scripts/validate-theme.js and tests. New direct callers should require
  // "./theme-schema" once Round A2 lands.
  REQUIRED_STATES,
  FULL_SLEEP_REQUIRED_STATES,
  MINI_REQUIRED_STATES,
  VISUAL_FALLBACK_STATES,
  isPlainObject: _isPlainObject,
  hasNonEmptyArray: _hasNonEmptyArray,
  getStateBindingEntry: _getStateBindingEntry,
  getStateFiles: _getStateFiles,
  hasStateFiles: _hasStateFiles,
  hasStateBinding: _hasStateBinding,
  normalizeStateBindings: _normalizeStateBindings,
  hasReactionBindings: _hasReactionBindings,
  supportsIdleTracking: _supportsIdleTracking,
  deriveIdleMode: _deriveIdleMode,
  deriveSleepMode: _deriveSleepMode,
};
