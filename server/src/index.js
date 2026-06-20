/**
 * CC Remote Server
 *
 * WebSocket server that:
 * - Manages Claude Code process sessions
 * - Forwards input/output between clients and Claude Code processes
 * - Auth: auto-generated token stored in .cc-remote-token
 */

const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const { exec } = require('child_process');
const { SessionManager } = require('./session-manager');

// ============================================================
// Configuration
// ============================================================
const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

function loadConfig() {
  const defaults = {
    port: 11199,
    host: '0.0.0.0',
    maxSessions: 20,
    workspace: '',
    permissionMode: '',
    persistSessions: true,
    sessionsDir: 'sessions',
  };

  // Load from config file (if present)
  let fileConfig = {};
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    fileConfig = JSON.parse(raw);
    console.log(`[Server] Loaded config from ${CONFIG_FILE}`);
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log(`[Server] No config file found at ${CONFIG_FILE}, using defaults`);
    } else {
      console.warn(`[Server] Failed to parse ${CONFIG_FILE}: ${e.message}, using defaults`);
    }
  }

  // Merge: env vars > config file > hardcoded defaults
  const port = parseInt(process.env.PORT || `${fileConfig.port || defaults.port}`, 10);
  const host = process.env.HOST || fileConfig.host || defaults.host;
  const maxSessions = parseInt(process.env.MAX_SESSIONS || `${fileConfig.maxSessions || defaults.maxSessions}`, 10);
  const workspace = process.env.WORKSPACE || fileConfig.workspace || defaults.workspace;
  const permissionMode = process.env.PERMISSION_MODE || fileConfig.permissionMode || defaults.permissionMode;
  const persistSessions = process.env.PERSIST_SESSIONS !== undefined
    ? process.env.PERSIST_SESSIONS !== 'false' && process.env.PERSIST_SESSIONS !== '0'
    : (fileConfig.persistSessions !== undefined ? fileConfig.persistSessions : defaults.persistSessions);
  const sessionsDir = process.env.SESSIONS_DIR || fileConfig.sessionsDir || defaults.sessionsDir;

  // Normalize workspace path
  const normalizedWorkspace = workspace ? path.resolve(workspace.trim()) : '';

  return { port, host, maxSessions, workspace: normalizedWorkspace, permissionMode, persistSessions, sessionsDir };
}

const CONFIG = loadConfig();

/**
 * Check whether `targetPath` is within `workspaceRoot` (or equal to it).
 * Both paths are resolved to absolute and normalized before comparison.
 * On Windows the comparison is case-insensitive.
 */
function isPathWithin(workspaceRoot, targetPath) {
  if (!workspaceRoot) return true; // no restriction
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(targetPath);
  const rel = path.relative(root, target);
  if (rel === '') return true; // exactly the workspace root
  if (rel.startsWith('..')) return false;
  // On Windows, also check for different drive letters
  if (process.platform === 'win32') {
    const rootParsed = path.parse(root);
    const targetParsed = path.parse(target);
    if (rootParsed.root.toLowerCase() !== targetParsed.root.toLowerCase()) return false;
  }
  return true;
}

// ============================================================
// Auth token — generated once, persisted to file
// ============================================================
const TOKEN_FILE = path.join(__dirname, '..', '.cc-remote-token');

function loadOrCreateToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch (e) {
    // First run — generate a random token
    const token = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(TOKEN_FILE, token, 'utf8');
    return token;
  }
}

const AUTH_TOKEN = loadOrCreateToken();

// ============================================================
// Auth helpers
// ============================================================
function getToken(req) {
  try {
    const u = url.parse(req.url, true);
    return (u.query && u.query.token) || '';
  } catch (e) { return ''; }
}

function checkAuth(req) {
  return getToken(req) === AUTH_TOKEN;
}

// ============================================================
// Profile management — profiles stored in server/profiles/
// ============================================================
const PROFILES_DIR = path.join(__dirname, '..', 'profiles');
const PROFILES_INDEX = path.join(PROFILES_DIR, 'index.json');

function ensureProfilesDir() {
  if (!fs.existsSync(PROFILES_DIR)) {
    fs.mkdirSync(PROFILES_DIR, { recursive: true });
    // Bootstrap default index
    const idx = { profiles: [], active: '' };
    fs.writeFileSync(PROFILES_INDEX, JSON.stringify(idx, null, 2), 'utf8');
    // Bootstrap default profile from the user's CURRENT settings.json so the
    // first switch back to "Default" restores their real config instead of
    // wiping it to an empty object.
    let existingSettings = {};
    try {
      const settingsRaw = fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');
      existingSettings = JSON.parse(settingsRaw);
    } catch (e) { /* no existing settings — start empty */ }
    const def = { id: 'default', name: 'Default', content: existingSettings };
    fs.writeFileSync(path.join(PROFILES_DIR, 'default.json'), JSON.stringify(def, null, 2), 'utf8');
    idx.profiles.push({ id: 'default', name: 'Default' });
    idx.active = 'default';
    fs.writeFileSync(PROFILES_INDEX, JSON.stringify(idx, null, 2), 'utf8');
    console.log('[Profiles] Initialized profiles directory with Default profile');
    return idx;
  }
  return null;
}

function readProfileIndex() {
  try {
    const raw = fs.readFileSync(PROFILES_INDEX, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    const idx = ensureProfilesDir();
    return idx || { profiles: [], active: '' };
  }
}

function writeProfileIndex(idx) {
  fs.writeFileSync(PROFILES_INDEX, JSON.stringify(idx, null, 2), 'utf8');
}

function readProfileFile(id) {
  const filePath = path.join(PROFILES_DIR, id + '.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function writeProfileFile(id, data) {
  fs.writeFileSync(path.join(PROFILES_DIR, id + '.json'), JSON.stringify(data, null, 2), 'utf8');
}

function generateProfileId() {
  return crypto.randomBytes(4).toString('hex');
}

function sendUnauth(res) {
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CC Remote — Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;height:100vh}
form{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:24px;width:320px}
h1{color:#ff6b6b;font-size:20px;margin-bottom:16px;text-align:center}
input{width:100%;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:10px;font-size:14px;margin-bottom:12px}
button{width:100%;background:#238636;color:#fff;border:none;border-radius:6px;padding:10px;font-size:14px;cursor:pointer}
button:hover{background:#2ea043}
.error{color:#f85149;font-size:12px;margin-bottom:8px;display:none}
</style></head>
<body>
<form id="f">
<h1>🦞 CC Remote</h1>
<p class="error" id="err">Invalid token</p>
<input id="t" type="password" placeholder="Auth Token" autofocus>
<button type="submit">Login</button>
<p style="color:#8b949e;font-size:11px;text-align:center;margin-top:12px">Token is set by the server administrator.</p>
</form>
<script>
document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();
var token=document.getElementById('t').value;
if(!token)return;
window.location.href='/?token='+encodeURIComponent(token);
});
// Show error if redirected back
if(location.search.includes('token='))document.getElementById('err').style.display='block';
</script>
</body></html>`);
}

// Common HTML head for terminal pages
function htmlHead(title) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>`;
}

// ============================================================
// Initialize
// ============================================================
const sessionManager = new SessionManager({
  persistSessions: CONFIG.persistSessions,
  sessionsDir: path.resolve(CONFIG.sessionsDir),
});

// Cached probe for the `claude` CLI. null = unknown; cached true once found
// so we don't pay the probe cost on every session create. A negative result
// is NOT cached, so installing claude after startup is picked up on retry.
let claudeAvailable = null;
function checkClaudeAvailable() {
  return new Promise((resolve) => {
    if (claudeAvailable === true) return resolve(true);
    exec('claude --version', { timeout: 8000 }, (err) => {
      if (!err) claudeAvailable = true;
      resolve(!err);
    });
  });
}

setInterval(() => { sessionManager.cleanup(); }, 60000);

// ============================================================
// HTTP Server
// ============================================================
const httpServer = http.createServer((req, res) => {
  // Health check is always public
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      auth: true,
      sessions: sessionManager.listSessions(),
      uptime: process.uptime(),
    }));
    return;
  }

  // Landing page — requires auth if enabled
  if (req.url === '/' || req.url.startsWith('/?')) {
    if (!checkAuth(req)) { sendUnauth(res); return; }
    const token = getToken(req);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlHead('CC Remote Server')+`
<style>body{font-family:monospace;max-width:800px;margin:40px auto;padding:20px;background:#1a1a2e;color:#e0e0e0}
h1{color:#ff6b6b}.status{color:#51cf66}a{color:#74c0fc}</style>
<body>
<h1>🦞 CC Remote Server</h1>
<p>Status: <span class="status">Running</span></p>
<p>Port: ${CONFIG.port}</p>
<p>Active sessions: ${sessionManager.listSessions().length}</p>
${CONFIG.workspace ? `<p>Workspace: ${CONFIG.workspace}</p>` : ''}
<p><a href="/health">Health Check (JSON)</a></p>
</body></html>`);
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// ============================================================
// WebSocket Server
// ============================================================
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const clientAddr = req.socket.remoteAddress;

  // Auth check on WebSocket connection
  const token = getToken(req);
  if (token !== AUTH_TOKEN) {
    console.log(`[Server] Rejected unauthorized client from ${clientAddr}`);
    ws.close(4001, 'Unauthorized — invalid or missing token');
    return;
  }

  console.log(`[Server] Client connected from ${clientAddr}`);
  let currentSessionId = null;

  ws.on('message', (rawData) => {
    let message;
    try {
      message = JSON.parse(rawData.toString());
    } catch (e) {
      sendToClient(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }
    handleMessage(ws, message).catch((err) => {
      console.error('[Server] Error handling message:', err);
      sendToClient(ws, { type: 'error', message: err.message });
    });
  });

  ws.on('close', () => {
    console.log(`[Server] Client disconnected from ${clientAddr}`);
    if (currentSessionId) {
      const session = sessionManager.getSession(currentSessionId);
      if (session) session.removeClient(ws);
    }
  });

  ws.on('error', (err) => {
    console.error(`[Server] WS error for ${clientAddr}:`, err.message);
  });

  async function handleMessage(ws, message) {
    const { type } = message;

    switch (type) {
      case 'list_sessions': {
        sendToClient(ws, { type: 'session_list', sessions: sessionManager.listSessions() });
        break;
      }
      case 'server_info': {
        const platform = os.platform();
        const homeDir = os.homedir();
        const sep = path.sep;
        let commonPaths = [];
        if (CONFIG.workspace) {
          // Workspace mode: only suggest workspace and its direct subdirs
          commonPaths.push(CONFIG.workspace);
          try {
            const entries = fs.readdirSync(CONFIG.workspace, { withFileTypes: true });
            for (const e of entries) {
              if (e.isDirectory()) {
                commonPaths.push(path.join(CONFIG.workspace, e.name));
              }
            }
          } catch (e) { /* ignore read errors */ }
        } else if (platform === 'win32') {
          commonPaths.push(homeDir, path.join(homeDir, 'Desktop'), path.join(homeDir, 'Documents'));
          const sysDrive = process.env.SystemDrive || 'C:';
          commonPaths.push(sysDrive + '\\');
          for (const d of ['D:', 'E:', 'F:']) {
            if (d !== sysDrive && fs.existsSync(d + '\\')) commonPaths.push(d + '\\');
          }
        } else {
          commonPaths.push(homeDir, '/', '/home', '/tmp', '/var', '/opt');
        }
        const info = { type: 'server_info', os: platform, homeDir, pathSeparator: sep, commonPaths };
        if (CONFIG.workspace) info.workspace = CONFIG.workspace;
        sendToClient(ws, info);
        break;
      }
      case 'list_directory': {
        const dirPath = message.path;
        if (!dirPath || typeof dirPath !== 'string') {
          sendToClient(ws, { type: 'error', message: 'path is required' });
          return;
        }
        try {
          const normalized = path.resolve(dirPath);
          // Enforce workspace restriction
          if (CONFIG.workspace && !isPathWithin(CONFIG.workspace, normalized)) {
            sendToClient(ws, { type: 'error', message: `Access denied: path is outside the configured workspace` });
            return;
          }
          const stat = fs.statSync(normalized);
          if (!stat.isDirectory()) {
            sendToClient(ws, { type: 'error', message: 'Path is not a directory' });
            return;
          }
          const entries = fs.readdirSync(normalized, { withFileTypes: true });
          const result = entries
            .filter(e => e.isDirectory() || e.isFile())
            .map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
              return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
            });
          // Clamp parent: don't allow navigating above the workspace root
          const fsParent = path.dirname(normalized);
          let parent = (fsParent !== normalized) ? fsParent : null;
          if (parent && CONFIG.workspace && !isPathWithin(CONFIG.workspace, parent)) {
            parent = null;
          }
          sendToClient(ws, {
            type: 'directory_list', path: normalized,
            parent, entries: result,
          });
        } catch (e) {
          sendToClient(ws, { type: 'error', message: `Cannot list directory: ${e.message}` });
        }
        break;
      }
      case 'create_session': {
        const directory = message.directory;
        if (!directory || typeof directory !== 'string') {
          sendToClient(ws, { type: 'error', message: 'directory is required' });
          return;
        }
        // Enforce workspace restriction
        if (CONFIG.workspace && !isPathWithin(CONFIG.workspace, directory)) {
          sendToClient(ws, { type: 'error', message: `Access denied: directory must be within the configured workspace` });
          return;
        }
        const running = sessionManager.listSessions().filter(s => s.status === 'running').length;
        if (running >= CONFIG.maxSessions) {
          sendToClient(ws, { type: 'error', message: `Max sessions (${CONFIG.maxSessions}) reached` });
          return;
        }
        // Verify the claude CLI is actually available before spawning a shell —
        // the shell will start fine even when `claude` is missing, so checking
        // the PTY alone never catches a missing CLI.
        if (!(await checkClaudeAvailable())) {
          sendToClient(ws, { type: 'error', message: 'The "claude" CLI was not found in PATH on the server. Install Claude Code and ensure `claude` is runnable.' });
          return;
        }
        try {
          const session = sessionManager.createSession(directory, { permissionMode: CONFIG.permissionMode });
          await new Promise(r => setTimeout(r, 1000));
          if (!session.isRunning) {
            sendToClient(ws, { type: 'session_error', session_id: session.id,
              error: 'Failed to start Claude Code. Make sure "claude" CLI is installed and in PATH.' });
            return;
          }
          sendToClient(ws, { type: 'session_created', session_id: session.id,
            directory: session.directory, createdAt: session.createdAt.toISOString() });
        } catch (error) {
          sendToClient(ws, { type: 'error', message: `Failed to create session: ${error.message}` });
        }
        break;
      }
      case 'connect_session': {
        const sessionId = message.session_id;
        if (!sessionId) { sendToClient(ws, { type: 'error', message: 'session_id is required' }); return; }
        const session = sessionManager.getSession(sessionId);
        if (!session) { sendToClient(ws, { type: 'error', message: `Session ${sessionId} not found` }); return; }
        if (currentSessionId) {
          const prev = sessionManager.getSession(currentSessionId);
          if (prev) prev.removeClient(ws);
        }
        currentSessionId = sessionId;
        session.addClient(ws);
        sendToClient(ws, { type: 'session_connected', session_id: sessionId,
          directory: session.directory, status: session.isRunning ? 'running' : 'exited',
          exitCode: session.exitCode });
        break;
      }
      case 'send_input': {
        // Retired: interactive PTY input is no longer supported. Sessions are
        // driven through the stream-json chat path (send_chat).
        sendToClient(ws, { type: 'error', message: 'send_input is not supported; use send_chat' });
        break;
      }
      case 'send_chat': {
        const sid = message.session_id || currentSessionId;
        if (!sid) { sendToClient(ws, { type: 'error', message: 'Not connected to any session' }); return; }
        const t = message.text;
        if (typeof t !== 'string') { sendToClient(ws, { type: 'error', message: 'text is required' }); return; }
        const s = sessionManager.getSession(sid);
        if (!s) { sendToClient(ws, { type: 'error', message: `Session ${sid} not found` }); return; }
        if (!s.isRunning) { sendToClient(ws, { type: 'error', message: 'Session is not running' }); return; }
        // Note: the persistent process always continues the conversation, so the
        // legacy `continue` flag is no longer meaningful.
        const r = s.sendMessage(t);
        if (!r.ok) sendToClient(ws, { type: 'error', message: r.error });
        break;
      }
      case 'interrupt': {
        const sid = message.session_id || currentSessionId;
        if (!sid) { sendToClient(ws, { type: 'error', message: 'No session specified' }); return; }
        const s = sessionManager.getSession(sid);
        if (!s) { sendToClient(ws, { type: 'error', message: `Session ${sid} not found` }); return; }
        const r = s.interrupt();
        if (!r.ok) sendToClient(ws, { type: 'error', message: r.error });
        break;
      }
      case 'disconnect_session': {
        const sid = message.session_id || currentSessionId;
        if (sid) {
          const s = sessionManager.getSession(sid);
          if (s) s.removeClient(ws);
          if (currentSessionId === sid) currentSessionId = null;
        }
        sendToClient(ws, { type: 'disconnected', session_id: sid });
        break;
      }
      case 'kill_session': {
        const sid = message.session_id || currentSessionId;
        if (!sid) { sendToClient(ws, { type: 'error', message: 'No session specified' }); return; }
        if (sessionManager.killSession(sid)) {
          if (currentSessionId === sid) currentSessionId = null;
          sendToClient(ws, { type: 'session_killed', session_id: sid });
        } else {
          sendToClient(ws, { type: 'error', message: `Session ${sid} not found` });
        }
        break;
      }

      // — Profile management —

      case 'list_profiles': {
        const idx = readProfileIndex();
        sendToClient(ws, { type: 'profile_list', profiles: idx.profiles, active: idx.active || '' });
        break;
      }

      case 'create_profile': {
        const pName = message.name;
        if (!pName || typeof pName !== 'string' || !pName.trim()) {
          sendToClient(ws, { type: 'error', message: 'Profile name is required' });
          return;
        }
        const ci = readProfileIndex();
        const trimmed = pName.trim();
        if (ci.profiles.some(p => p.name === trimmed)) {
          sendToClient(ws, { type: 'error', message: 'A profile with that name already exists' });
          return;
        }
        const pid = generateProfileId();
        const profile = { id: pid, name: trimmed, content: message.content || {} };
        writeProfileFile(pid, profile);
        ci.profiles.push({ id: pid, name: trimmed });
        writeProfileIndex(ci);
        sendToClient(ws, { type: 'profile_created', profile: { id: pid, name: trimmed } });
        break;
      }

      case 'update_profile': {
        const upId = message.id;
        if (!upId) { sendToClient(ws, { type: 'error', message: 'Profile ID is required' }); return; }
        const ui = readProfileIndex();
        const uIdx = ui.profiles.findIndex(p => p.id === upId);
        if (uIdx === -1) { sendToClient(ws, { type: 'error', message: 'Profile not found' }); return; }
        if (message.name) {
          const nTrimmed = message.name.trim();
          if (ui.profiles.some((p, i) => i !== uIdx && p.name === nTrimmed)) {
            sendToClient(ws, { type: 'error', message: 'A profile with that name already exists' });
            return;
          }
          ui.profiles[uIdx].name = nTrimmed;
        }
        const upFile = readProfileFile(upId);
        if (message.name) upFile.name = ui.profiles[uIdx].name;
        if (message.content) upFile.content = message.content;
        writeProfileFile(upId, upFile);
        writeProfileIndex(ui);
        sendToClient(ws, { type: 'profile_updated', profile: { id: upId, name: ui.profiles[uIdx].name } });
        break;
      }

      case 'delete_profile': {
        const dId = message.id;
        if (!dId) { sendToClient(ws, { type: 'error', message: 'Profile ID is required' }); return; }
        const di = readProfileIndex();
        const dIdx = di.profiles.findIndex(p => p.id === dId);
        if (dIdx === -1) { sendToClient(ws, { type: 'error', message: 'Profile not found' }); return; }
        if (di.active === dId) {
          sendToClient(ws, { type: 'error', message: 'Cannot delete the active profile. Switch to another profile first.' });
          return;
        }
        di.profiles.splice(dIdx, 1);
        writeProfileIndex(di);
        try { fs.unlinkSync(path.join(PROFILES_DIR, dId + '.json')); } catch (_) { /* ignore */ }
        sendToClient(ws, { type: 'profile_deleted', id: dId });
        break;
      }

      case 'switch_profile': {
        const sId = message.id;
        if (!sId) { sendToClient(ws, { type: 'error', message: 'Profile ID is required' }); return; }
        const si = readProfileIndex();
        const sIdx = si.profiles.findIndex(p => p.id === sId);
        if (sIdx === -1) { sendToClient(ws, { type: 'error', message: 'Profile not found' }); return; }
        const sProfile = readProfileFile(sId);
        const claudeDir = path.join(os.homedir(), '.claude');
        const settingsPath = path.join(claudeDir, 'settings.json');
        try {
          if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
          // Back up the current settings.json before overwriting, so a switch
          // never silently destroys an existing config.
          if (fs.existsSync(settingsPath)) {
            try { fs.copyFileSync(settingsPath, settingsPath + '.bak'); } catch (_) { /* best effort */ }
          }
          fs.writeFileSync(settingsPath, JSON.stringify(sProfile.content, null, 2), 'utf8');
          si.active = sId;
          writeProfileIndex(si);
          sendToClient(ws, { type: 'profile_switched', id: sId, name: si.profiles[sIdx].name });
        } catch (e) {
          sendToClient(ws, { type: 'error', message: 'Failed to switch profile: ' + e.message });
        }
        break;
      }

      case 'ping': sendToClient(ws, { type: 'pong' }); break;
      default: sendToClient(ws, { type: 'error', message: `Unknown message type: ${type}` }); break;
    }
  }
});

// ============================================================
// Helpers
// ============================================================
function sendToClient(ws, message) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(message)); }
  catch (e) { console.error('[Server] Send error:', e.message); }
}

// ============================================================
// Start
// ============================================================

// Restore previously persisted sessions before accepting connections
sessionManager.ensureSessionsDir();
sessionManager.restoreSessions();

httpServer.listen(CONFIG.port, CONFIG.host, () => {
  console.log('══════════════════════════════════════════════');
  console.log('  🦞 CC Remote Server');
  console.log('══════════════════════════════════════════════');
  console.log(`  HTTP:      http://${CONFIG.host === '0.0.0.0' ? '127.0.0.1' : CONFIG.host}:${CONFIG.port}`);
  console.log(`  WebSocket: ws://${CONFIG.host === '0.0.0.0' ? '127.0.0.1' : CONFIG.host}:${CONFIG.port}`);
  console.log(`  Max Sessions: ${CONFIG.maxSessions}`);
  if (CONFIG.workspace) console.log(`  Workspace:   ${CONFIG.workspace}`);
  console.log(`  Auth token: ${AUTH_TOKEN}`);
  console.log('══════════════════════════════════════════════');
});

// ============================================================
// Graceful shutdown
// ============================================================
function shutdown() {
  console.log('\n[Server] Shutting down...');
  // Save all active sessions before killing processes
  sessionManager.saveAllActive();
  for (const [id, session] of sessionManager.sessions) { session.kill(); }
  wss.close(() => console.log('[Server] WebSocket closed'));
  httpServer.close(() => { console.log('[Server] HTTP closed'); process.exit(0); });
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err.stack || err);
  shutdown();
  setTimeout(() => process.exit(1), 5000);
});
