const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeSession, ACTIVE_SETTINGS_FILE } = require('./claude-session');
const { CodexSession } = require('./codex-session');
const { OpenCodeSession, getOpenCodeEnv } = require('./opencode-session');
const ccSwitch = require('./cc-switch');

const DEFAULT_AGENT = 'claude';

const AGENTS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    checkCommand: 'claude --version',
    missingMessage: 'The "claude" CLI was not found in PATH on the server. Install Claude Code and ensure `claude` is runnable.',
    startError: 'Failed to start Claude Code. Make sure "claude" CLI is installed and in PATH.',
    Session: ClaudeSession,
    modelCommands: ['/model', '/models'],
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    checkCommand: 'codex --version',
    missingMessage: 'The "codex" CLI was not found in PATH on the server. Install Codex CLI and ensure `codex` is runnable.',
    startError: 'Failed to start Codex CLI. Make sure "codex" is installed, logged in, and available on PATH.',
    Session: CodexSession,
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    checkCommand: 'opencode --version',
    checkEnv: getOpenCodeEnv,
    missingMessage: 'The "opencode" CLI was not found in PATH on the server. Install OpenCode and ensure `opencode` is runnable.',
    startError: 'Failed to start OpenCode. Make sure "opencode" is installed, configured, and available on PATH.',
    Session: OpenCodeSession,
  },
};

const EMPTY_MODEL_LIST = Object.freeze([]);
const PROFILES_DIR = path.join(__dirname, '..', 'profiles');
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const modelListCache = new Map();

function quoteArg(value) {
  const s = String(value == null ? '' : value);
  if (process.platform === 'win32') return '"' + s.replace(/"/g, '\\"') + '"';
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function normalizeAgent(agent) {
  const id = String(agent || DEFAULT_AGENT).trim().toLowerCase();
  return id || DEFAULT_AGENT;
}

function getAgentDefinition(agent) {
  const id = normalizeAgent(agent);
  return AGENTS[id] || null;
}

function createAgentSession(id, directory, options = {}) {
  const agent = normalizeAgent(options.agent);
  const def = getAgentDefinition(agent);
  if (!def) throw new Error(`Unsupported agent: ${agent}`);
  return new def.Session(id, directory, Object.assign({}, options, { agent }));
}

function restoreAgentSession(data) {
  const agent = normalizeAgent(data && data.agent);
  const def = getAgentDefinition(agent);
  if (!def) throw new Error(`Unsupported agent: ${agent}`);
  return def.Session.fromSaved(Object.assign({}, data, { agent }));
}

function getSessionModel(session) {
  if (!session) return '';
  if (typeof session.getModel === 'function') return session.getModel() || '';
  return session.modelOverride || session.model || '';
}

function switchSessionModel(session, model) {
  if (!session) throw new Error('Session not found');
  if (typeof session.switchModel === 'function') {
    const result = session.switchModel(model);
    return typeof result === 'string' ? result : getSessionModel(session);
  }
  if (typeof session.setModel === 'function') {
    const result = session.setModel(model);
    return typeof result === 'string' ? result : getSessionModel(session);
  }
  throw new Error(`Session ${session.id || ''} does not support model switching`.trim());
}

function runModelCommand(def, slashCommand) {
  return new Promise((resolve) => {
    const parts = [def.id, '-p', quoteArg(slashCommand), '--output-format', 'json'];
    if (def.id === 'claude' && fs.existsSync(ACTIVE_SETTINGS_FILE)) {
      parts.push('--settings', quoteArg(ACTIVE_SETTINGS_FILE));
    }
    const cmd = parts.join(' ');
    exec(cmd, {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      env: Object.assign({}, process.env, { FORCE_COLOR: '0', NO_COLOR: '1' }),
    }, (err, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join('\n');
      resolve({ ok: !err, output, error: err ? err.message : '' });
    });
  });
}

function runCommand(command) {
  return new Promise((resolve) => {
    exec(command, {
      timeout: 15000,
      maxBuffer: 20 * 1024 * 1024,
      env: Object.assign({}, process.env, { FORCE_COLOR: '0', NO_COLOR: '1' }),
    }, (err, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join('\n');
      resolve({ ok: !err, output, error: err ? err.message : '' });
    });
  });
}

function extractText(output) {
  const raw = String(output || '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.result === 'string') return parsed.result;
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.text === 'string') return parsed.text;
    return '';
  } catch (_) {
    return raw;
  }
}

function cleanModelCandidate(value) {
  let s = String(value || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/^[\s>*•\-+[\](){}|]+/, '')
    .replace(/^\d+[\.)]\s*/, '')
    .replace(/^(current|selected|active|model)\s*[:=-]\s*/i, '')
    .replace(/\s+\((current|selected|active|default)\)\s*$/i, '')
    .trim();
  if (!s) return '';
  s = s.split(/\s{2,}/)[0].trim();
  if (s.includes(' - ')) s = s.split(' - ')[0].trim();
  if (s.includes(' — ')) s = s.split(' — ')[0].trim();
  if (s.includes(' – ')) s = s.split(' – ')[0].trim();
  s = s.replace(/[,;:]$/, '').trim();
  if (!s || s.length > 120) return '';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return '';
  if (/^(available models?|choose|select|use arrows|press enter|esc|cancel|current model)$/i.test(s)) return '';
  if (/\s/.test(s) && !/[A-Za-z0-9][A-Za-z0-9._:/+-]*-[A-Za-z0-9._:/+-]/.test(s)) return '';
  return s;
}

function parseModelList(output) {
  const text = extractText(output);
  if (/isn't available in this environment|not available in this environment/i.test(text)) {
    return [];
  }
  const models = [];
  const seen = new Set();
  const add = (value) => {
    const model = cleanModelCandidate(value);
    if (!model) return;
    const key = model.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      models.push(model);
    }
  };

  for (const match of text.matchAll(/`([^`\r\n]+)`/g)) add(match[1]);
  for (const match of text.matchAll(/\b([A-Za-z0-9][A-Za-z0-9._:/+-]*-[A-Za-z0-9._:/+-]+)\b/g)) add(match[1]);

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^([>*•\-+]|\d+[\.)]|\[[ x*✓-]\])\s+/i.test(trimmed)) add(trimmed);
  }
  return models;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function collectConfiguredClaudeModels() {
  const models = [];
  const seen = new Set();
  const add = (value) => {
    const model = cleanModelCandidate(value);
    if (!model) return;
    const key = model.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      models.push(model);
    }
  };

  add(process.env.ANTHROPIC_MODEL);
  const active = readJsonFile(ACTIVE_SETTINGS_FILE);
  if (active) add(active.model);

  const globalSettings = readJsonFile(path.join(os.homedir(), '.claude', 'settings.json'));
  if (globalSettings) add(globalSettings.model);

  try {
    if (fs.existsSync(PROFILES_DIR)) {
      for (const name of fs.readdirSync(PROFILES_DIR)) {
        if (!name.endsWith('.json') || name === 'index.json') continue;
        const profile = readJsonFile(path.join(PROFILES_DIR, name));
        if (profile && profile.content) add(profile.content.model);
        if (profile) add(profile.model);
      }
    }
  } catch (_) {}

  try {
    for (const profile of ccSwitch.readCCSwitchProfiles()) add(profile.model);
    add(ccSwitch.readCommonConfig().model);
  } catch (_) {}

  return models;
}

function createModelCollector() {
  const models = [];
  const seen = new Set();
  const add = (value) => {
    const model = cleanModelCandidate(value);
    if (!model) return;
    const key = model.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      models.push(model);
    }
  };
  return { models, add };
}

function collectConfiguredCodexModels() {
  const { models, add } = createModelCollector();
  add(process.env.CODEX_MODEL);
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  try {
    const text = fs.readFileSync(configPath, 'utf8');
    for (const match of text.matchAll(/^\s*model\s*=\s*["']([^"']+)["']/gm)) add(match[1]);
    for (const match of text.matchAll(/^\s*["']?([^"'\r\n=]+)["']?\s*=\s*\d+\s*$/gm)) {
      if (text.slice(Math.max(0, match.index - 80), match.index).includes('[tui.model_availability_nux]')) {
        add(match[1].trim());
      }
    }
  } catch (_) {}
  return models;
}

async function collectCodexCatalogModels() {
  const result = await runCommand('codex debug models');
  if (!result.ok || !result.output) return [];
  try {
    const data = JSON.parse(result.output);
    const { models, add } = createModelCollector();
    for (const model of data.models || []) {
      if (!model || model.visibility === 'hide') continue;
      add(model.slug || model.id || model.name);
    }
    return models;
  } catch (_) {
    return [];
  }
}

function collectConfiguredOpenCodeModels() {
  const { models, add } = createModelCollector();
  const addOpenCodeModel = (modelID, providerID) => {
    const model = String(modelID || '').trim();
    const provider = String(providerID || '').trim();
    if (!model) return;
    add(provider && !model.includes('/') ? `${provider}/${model}` : model);
  };
  add(process.env.OPENCODE_MODEL);

  const candidates = [
    path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
    path.join(os.homedir(), '.config', 'opencode', 'config.json'),
    path.join(os.homedir(), '.opencode.json'),
    path.join(process.env.APPDATA || '', 'ai.opencode.desktop', 'opencode.global.dat'),
  ];

  for (const filePath of candidates) {
    if (!filePath) continue;
    const data = readJsonFile(filePath);
    if (!data) continue;
    addOpenCodeModel(data.model, data.providerID);
    addOpenCodeModel(data.modelID, data.providerID);

    if (typeof data.model === 'string' && data.model.trim().startsWith('{')) {
      try {
        const state = JSON.parse(data.model);
        for (const item of state.user || []) {
          if (!item || item.visibility === 'hide') continue;
          addOpenCodeModel(item.modelID, item.providerID);
        }
        for (const item of state.recent || []) {
          if (item) addOpenCodeModel(item.modelID, item.providerID);
        }
      } catch (_) {}
    }
  }

  return models;
}

async function listAgentModels(agent) {
  const def = getAgentDefinition(agent);
  if (!def) return null;
  const cached = modelListCache.get(def.id);
  if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) {
    return Object.assign({}, cached.result, { cached: true });
  }

  let configuredModels = [];
  if (def.id === 'codex') {
    const catalogModels = await collectCodexCatalogModels();
    if (catalogModels.length > 0) {
      const result = {
        agent: def.id,
        models: catalogModels,
        supportsManual: true,
        source: 'codex-debug-models',
      };
      modelListCache.set(def.id, { at: Date.now(), result });
      return result;
    }
    configuredModels = collectConfiguredCodexModels();
  } else if (def.id === 'claude') configuredModels = collectConfiguredClaudeModels();
  else if (def.id === 'opencode') configuredModels = collectConfiguredOpenCodeModels();
  if (configuredModels.length > 0) {
    const result = {
      agent: def.id,
      models: configuredModels,
      supportsManual: true,
      source: 'configured',
    };
    modelListCache.set(def.id, { at: Date.now(), result });
    return result;
  }

  const commands = def.modelCommands || [];
  for (const command of commands) {
    const result = await runModelCommand(def, command);
    const models = parseModelList(result.output);
    if (models.length > 0) {
      const response = {
        agent: def.id,
        models,
        supportsManual: true,
        source: command,
      };
      modelListCache.set(def.id, { at: Date.now(), result: response });
      return response;
    }
  }

  const empty = {
    agent: def.id,
    models: EMPTY_MODEL_LIST,
    supportsManual: true,
  };
  modelListCache.set(def.id, { at: Date.now(), result: empty });
  return empty;
}

module.exports = {
  DEFAULT_AGENT,
  normalizeAgent,
  getAgentDefinition,
  createAgentSession,
  restoreAgentSession,
  getSessionModel,
  switchSessionModel,
  listAgentModels,
};
