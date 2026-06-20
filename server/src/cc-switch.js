/**
 * CC Switch integration — read-only adapter for ~/.cc-switch/cc-switch.db.
 *
 * CC Switch stores provider profiles in a local SQLite database. This module
 * reads them so CC Remote can list and switch between them without duplicating
 * configuration. CC Switch is the source of truth for its profiles; CC Remote
 * never writes to the database.
 *
 * Each provider's settings_config is a JSON object whose top-level keys
 * (env, model, permissions, etc.) map directly to ~/.claude/settings.json.
 * Switching to a provider writes its settings_config to that file.
 *
 * common_config_claude (from the settings table) holds base defaults that
 * providers can override — the deep-merge order is: common → provider.
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CC_SWITCH_DIR = path.join(os.homedir(), '.cc-switch');
const CC_SWITCH_DB = path.join(CC_SWITCH_DIR, 'cc-switch.db');

/**
 * Return true if the CC Switch database exists and is readable.
 * Used by index.js to decide whether to merge CC Switch profiles.
 */
function isAvailable() {
  return fs.existsSync(CC_SWITCH_DB);
}

/**
 * Open the CC Switch database (read-only, WAL-aware).
 * Returns null if the database doesn't exist or can't be opened.
 */
function _openDb() {
  if (!isAvailable()) return null;
  try {
    const db = new DatabaseSync(CC_SWITCH_DB);
    try {
      // Enable WAL mode for concurrent reads (CC Switch may be writing)
      db.exec('PRAGMA journal_mode=WAL');
    } catch (_) { /* not critical */ }
    return db;
  } catch (err) {
    console.warn(`[cc-switch] Cannot open database: ${err.message}`);
    return null;
  }
}

/**
 * Read the common_config_claude from the settings table.
 * Returns a parsed JSON object, or {} if not found.
 */
function readCommonConfig() {
  const db = _openDb();
  if (!db) return {};
  try {
    const stmt = db.prepare("SELECT value FROM settings WHERE key='common_config_claude'");
    const rows = stmt.all();
    if (rows.length > 0) {
      return JSON.parse(rows[0].value);
    }
    return {};
  } catch (err) {
    console.warn(`[cc-switch] Failed to read common_config_claude: ${err.message}`);
    return {};
  } finally {
    try { db.close(); } catch (_) {}
  }
}

/**
 * Read all Claude provider profiles from CC Switch.
 *
 * Each returned entry:
 *   { id, name, model, isCurrent, source: 'cc-switch' }
 *
 * model is extracted from settings_config.model.
 * Returns an empty array if the DB is unavailable.
 */
function readCCSwitchProfiles() {
  const db = _openDb();
  if (!db) return [];

  try {
    const stmt = db.prepare(
      "SELECT id, name, is_current, settings_config FROM providers WHERE app_type='claude' ORDER BY sort_index"
    );
    const rows = stmt.all();
    const profiles = [];
    for (const row of rows) {
      let model = '';
      try {
        const cfg = JSON.parse(row.settings_config);
        model = cfg.model || '';
      } catch (_) { /* settings_config may be malformed — skip model */ }

      profiles.push({
        id: row.id,
        name: row.name,
        model,
        isCurrent: row.is_current === 1,
        source: 'cc-switch',
      });
    }
    return profiles;
  } catch (err) {
    console.warn(`[cc-switch] Failed to read providers: ${err.message}`);
    return [];
  } finally {
    try { db.close(); } catch (_) {}
  }
}

/**
 * Return the merged settings JSON for a CC Switch provider.
 *
 * Deep-merge order: common_config_claude (base) ← provider settings_config (override).
 * This mirrors CC Switch's own merge logic: common settings apply to all
 * providers unless the provider explicitly overrides them.
 */
function getCCSwitchProfile(id) {
  const db = _openDb();
  if (!db) return null;

  try {
    const common = readCommonConfig();

    const stmt = db.prepare(
      "SELECT settings_config, name FROM providers WHERE app_type='claude' AND id=?"
    );
    const rows = stmt.all(id);
    if (rows.length === 0) return null;

    let providerCfg;
    try {
      providerCfg = JSON.parse(rows[0].settings_config);
    } catch (_) {
      providerCfg = {};
    }

    // Deep merge: common base + provider overrides
    const merged = deepMerge(common, providerCfg);

    return {
      id,
      name: rows[0].name,
      content: merged,
    };
  } catch (err) {
    console.warn(`[cc-switch] Failed to read profile ${id}: ${err.message}`);
    return null;
  } finally {
    try { db.close(); } catch (_) {}
  }
}

/**
 * Simple deep merge. Values from `override` take precedence.
 * Objects are merged recursively; arrays and primitives are replaced.
 */
function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      typeof override[key] === 'object' &&
      override[key] !== null &&
      !Array.isArray(override[key]) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

module.exports = {
  isAvailable,
  readCCSwitchProfiles,
  getCCSwitchProfile,
  readCommonConfig,
};
