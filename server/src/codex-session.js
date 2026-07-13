/**
 * Codex exec session adapter.
 *
 * Codex MVP uses one `codex exec --json` process per user turn. The CC Remote
 * session remains logically alive between turns, while Codex persists its own
 * conversation and can be resumed with `codex exec resume <id> --json`.
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_CHAT_HISTORY = 400;
const CODEX_SANDBOX = process.env.CODEX_SANDBOX || 'workspace-write';
const CODEX_BYPASS_SANDBOX = /^(1|true|yes)$/i.test(
  process.env.CODEX_BYPASS_APPROVALS_AND_SANDBOX ||
  process.env.CODEX_DANGEROUSLY_BYPASS_APPROVALS_AND_SANDBOX ||
  ''
);

function quoteArg(s) {
  return '"' + String(s).replace(/(["\\])/g, '\\$1') + '"';
}

function promptArg(s) {
  return process.platform === 'win32'
    ? String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\\n')
    : s;
}

function commandFor(args) {
  if (process.platform !== 'win32') return { file: 'codex', args, shell: false };
  return { file: 'codex ' + args.map(quoteArg).join(' '), args: [], shell: true };
}

function flattenText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join('');
  if (!value || typeof value !== 'object') return '';

  if (typeof value.text === 'string') return value.text;
  if (typeof value.output_text === 'string') return value.output_text;
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.content)) return flattenText(value.content);
  if (value.type === 'text' && typeof value.value === 'string') return value.value;
  return '';
}

function summarizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  const type = item.type || '';
  if (type.includes('command') || type.includes('shell')) {
    return { name: 'shell', detail: item.command || item.cmd || item.summary || '' };
  }
  if (type.includes('tool') || type.includes('function')) {
    return { name: item.name || item.tool_name || type, detail: item.arguments || item.input || item.summary || '' };
  }
  return null;
}

function compact(value, max = 300) {
  let s = '';
  if (typeof value === 'string') s = value;
  else if (value != null) {
    try { s = JSON.stringify(value); } catch (_) { s = String(value); }
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '...' : s;
}

function findApprovalRequest(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const type = String(obj.type || obj.event || obj.kind || '');
  const payload = obj.payload || obj.data || obj.item || obj;
  const payloadType = String(payload.type || payload.kind || payload.name || '');
  const haystack = `${type} ${payloadType}`.toLowerCase();
  if (!/(approval|permission|confirm|escalat)/.test(haystack)) return null;
  if (/(response|result|completed|denied|approved)/.test(haystack)) return null;

  const args = payload.arguments || {};
  const input = payload.input || {};
  const command = payload.command || payload.cmd || args.command || input.command || '';
  const pathValue = payload.path || payload.file_path || payload.cwd ||
    args.path || args.file_path || input.path || input.file_path || '';
  const reason = payload.reason || payload.justification || payload.message ||
    payload.summary || payload.title || obj.message || '';
  const id = payload.id || payload.request_id || payload.approval_id ||
    obj.id || obj.request_id || obj.approval_id || `approval-${Date.now()}`;
  const action = String(payload.action || payload.operation || payload.tool ||
    payload.name || type || 'operation');

  return {
    request_id: String(id),
    action,
    command: compact(command, 800),
    path: compact(pathValue, 300),
    reason: compact(reason, 500),
    detail: compact(command || pathValue || reason || payload, 500),
    raw_type: type,
  };
}

function codexSessionsRoot() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
}

function collectJsonlFiles(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsonlFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function readSessionMeta(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const firstLine = buf.toString('utf8', 0, n).split(/\r?\n/, 1)[0];
    const obj = JSON.parse(firstLine);
    const payload = obj.payload || obj;
    if (obj.type !== 'session_meta' || !payload) return null;
    return {
      id: payload.session_id || payload.id,
      cwd: payload.cwd || '',
      source: payload.source || '',
      originator: payload.originator || '',
    };
  } catch (_) {
    return null;
  }
}

function findRecentCodexSessionId(directory, sinceMs) {
  const root = codexSessionsRoot();
  const dirResolved = path.resolve(directory).toLowerCase();
  const candidates = collectJsonlFiles(root)
    .map((file) => {
      try { return { file, mtimeMs: fs.statSync(file).mtimeMs }; } catch (_) { return null; }
    })
    .filter(Boolean)
    .filter((x) => x.mtimeMs >= sinceMs - 5000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const c of candidates) {
    const meta = readSessionMeta(c.file);
    if (!meta || !meta.id) continue;
    if (meta.originator && meta.originator !== 'codex_exec') continue;
    if (meta.source && meta.source !== 'exec') continue;
    if (meta.cwd && path.resolve(meta.cwd).toLowerCase() !== dirResolved) continue;
    return meta.id;
  }
  return null;
}

class CodexSession extends EventEmitter {
  constructor(id, directory, options = {}) {
    super();
    this.agent = 'codex';
    this.id = id;
    this.directory = directory;
    this.createdAt = new Date();
    this.isRunning = true;
    this.exitCode = null;
    this.model = options.model || '';
    this.codexSessionId = options.codexSessionId || null;

    this.clients = new Set();
    this._chatHistory = [];
    this._chatBusy = false;
    this._chatPending = null;
    this._turnText = '';
    this._turnStartedAt = 0;
    this._stopped = false;
    this.child = null;
    this._stdoutRl = null;
    this._lastMessageFile = null;
    this._finalSent = false;
    this._processStartedAt = 0;
    this._pendingApprovals = new Set();
  }

  toJSON() {
    return {
      id: this.id,
      agent: this.agent,
      directory: this.directory,
      model: this.model || '',
      createdAt: this.createdAt.toISOString(),
      chatHistory: this._chatHistory,
      pending: this._chatPending,
      stopped: this._stopped,
      agentState: {
        codexSessionId: this.codexSessionId,
      },
    };
  }

  static fromSaved(data) {
    const state = data.agentState || {};
    const session = new CodexSession(data.id, data.directory, {
      model: data.model || '',
      codexSessionId: state.codexSessionId || data.codexSessionId || null,
    });
    session.createdAt = new Date(data.createdAt || Date.now());
    session._chatHistory = Array.isArray(data.chatHistory) ? data.chatHistory : [];
    if (session._chatHistory.length > MAX_CHAT_HISTORY) {
      session._chatHistory = session._chatHistory.slice(-MAX_CHAT_HISTORY);
    }
    session._stopped = !!data.stopped;
    session.isRunning = !session._stopped;
    session.exitCode = session._stopped ? 0 : null;
    return session;
  }

  sendMessage(text) {
    const prompt = (text || '').replace(/[\r\n]+$/g, '');
    if (!prompt.trim()) return { ok: false, error: 'Empty message' };
    if (!this.isRunning || this._stopped) return { ok: false, error: 'Session is not running' };
    if (this._chatBusy) return { ok: false, error: 'Previous message still processing. Please wait.' };

    this._chatBusy = true;
    this._chatPending = prompt;
    this._turnText = '';
    this._turnStartedAt = Date.now();
    this._finalSent = false;
    this._processStartedAt = Date.now();
    this._pushHistory({ role: 'user', text: prompt, ts: Date.now() });

    const outDir = path.join(os.tmpdir(), 'cc-remote-codex');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
    this._lastMessageFile = path.join(outDir, `${this.id}-${Date.now()}.txt`);

    const outboundPrompt = promptArg(prompt);
    const args = ['exec'];
    if (CODEX_BYPASS_SANDBOX) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('--sandbox', CODEX_SANDBOX);
    }
    args.push('--cd', this.directory);
    if (this.codexSessionId) args.push('resume');
    args.push('--json', '--skip-git-repo-check', '--output-last-message', this._lastMessageFile);
    if (this.codexSessionId) args.push(this.codexSessionId);
    args.push(outboundPrompt);
    if (this.model) {
      const insertAt = this.codexSessionId ? args.indexOf('resume') + 1 : args.indexOf('exec') + 1;
      args.splice(insertAt, 0, '--model', this.model);
    }

    const cmd = commandFor(args);
    try {
      this.child = spawn(cmd.file, cmd.args, {
        cwd: this.directory,
        shell: cmd.shell,
        env: Object.assign({}, process.env, { FORCE_COLOR: '0', NO_COLOR: '1' }),
      });
    } catch (err) {
      this._chatBusy = false;
      this._chatPending = null;
      return { ok: false, error: 'Failed to start codex: ' + err.message };
    }

    const sandboxLabel = CODEX_BYPASS_SANDBOX ? 'bypass-approvals-and-sandbox' : CODEX_SANDBOX;
    console.log(`[CodexSession ${this.id}] PID ${this.child.pid} (${this.codexSessionId ? 'resume' : 'new'}, sandbox=${sandboxLabel})`);

    this._stdoutRl = readline.createInterface({ input: this.child.stdout });
    this._stdoutRl.on('line', (line) => this._onLine(line));

    this.child.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) console.error(`[CodexSession ${this.id}] stderr: ${s.substring(0, 500)}`);
    });

    this.child.on('error', (err) => {
      this._finishTurn({ isError: true, text: 'Failed to run codex: ' + err.message });
      this.emit('error', err);
    });

    this.child.on('exit', (code) => {
      this.exitCode = code;
      this.child = null;
      if (this._stdoutRl) { try { this._stdoutRl.close(); } catch (_) {} this._stdoutRl = null; }

      let finalText = '';
      try {
        if (this._lastMessageFile && fs.existsSync(this._lastMessageFile)) {
          finalText = fs.readFileSync(this._lastMessageFile, 'utf8').trim();
          try { fs.unlinkSync(this._lastMessageFile); } catch (_) {}
        }
      } catch (_) {}

      if (!finalText) finalText = this._turnText.trim();
      if (!finalText && code !== 0) finalText = `Codex exited with code ${code}`;
      if (!this.codexSessionId) {
        const discovered = findRecentCodexSessionId(this.directory, this._processStartedAt || Date.now());
        if (discovered) {
          this.codexSessionId = discovered;
          this._broadcast({ type: 'session_meta', session_id: this.id, codex_session_id: this.codexSessionId });
          console.log(`[CodexSession ${this.id}] discovered codex session ${this.codexSessionId}`);
        }
      }
      this._finishTurn({ isError: code !== 0, text: finalText });
    });

    try { this.child.stdin.end(); } catch (_) {}

    return { ok: true };
  }

  _onLine(line) {
    line = String(line || '').trim();
    if (!line) return;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { return; }

    const type = obj.type || obj.event || '';
    if ((type.includes('thread') || type.includes('session')) && (obj.thread_id || obj.session_id || obj.id)) {
      this.codexSessionId = obj.thread_id || obj.session_id || obj.id;
      this._broadcast({ type: 'session_meta', session_id: this.id, codex_session_id: this.codexSessionId });
      return;
    }

    if (type === 'session_meta' && obj.payload && (obj.payload.session_id || obj.payload.id)) {
      this.codexSessionId = obj.payload.session_id || obj.payload.id;
      this._broadcast({ type: 'session_meta', session_id: this.id, codex_session_id: this.codexSessionId });
      return;
    }

    const approval = findApprovalRequest(obj);
    if (approval) {
      this._pendingApprovals.add(approval.request_id);
      this._broadcast(Object.assign({
        type: 'operation_approval_request',
        session_id: this.id,
        agent: this.agent,
      }, approval));
      return;
    }

    const item = obj.item || obj.data || obj;
    const tool = summarizeItem(item);
    if (tool && (type.startsWith('item.') || type.includes('tool') || type.includes('command'))) {
      this._broadcast({
        type: 'session_tool',
        session_id: this.id,
        status: type.includes('completed') ? 'done' : 'running',
        name: tool.name,
        detail: typeof tool.detail === 'string' ? tool.detail : JSON.stringify(tool.detail || ''),
      });
    }

    const text = flattenText(item);
    if (text && item.role !== 'user') {
      this._turnText += text;
      this._broadcast({ type: 'session_delta', session_id: this.id, text });
    }

    if (type === 'turn.failed') {
      const err = obj.error || obj.message || 'Codex turn failed';
      this._finishTurn({ isError: true, text: typeof err === 'string' ? err : JSON.stringify(err) });
    }
  }

  respondToApproval(requestId, approved) {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) {
      return { ok: false, error: 'No active Codex process is waiting for approval' };
    }
    const id = String(requestId || '');
    if (id) this._pendingApprovals.delete(id);
    try {
      this.child.stdin.write(approved ? 'y\n' : 'n\n');
      this._broadcast({
        type: 'operation_approval_resolved',
        session_id: this.id,
        request_id: id,
        approved: !!approved,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: 'Failed to write approval response: ' + err.message };
    }
  }

  _finishTurn({ isError, text }) {
    if (this._finalSent) return;
    this._finalSent = true;
    this._chatBusy = false;
    this._chatPending = null;
    this._turnText = '';
    this._pendingApprovals.clear();
    const finalText = text || '';
    if (finalText) this._pushHistory({ role: 'claude', text: finalText, ts: Date.now() });
    this.emit('turnComplete');
    this._broadcast({ type: 'session_response', session_id: this.id, data: finalText, is_error: !!isError });
  }

  interrupt() {
    if (!this._chatBusy) return { ok: false, error: 'Nothing to interrupt' };
    this._killChild();
    const partial = this._turnText.trim();
    const text = partial ? partial + '\n\n(interrupted)' : '(interrupted)';
    this._finishTurn({ isError: false, text });
    console.log(`[CodexSession ${this.id}] interrupted`);
    return { ok: true };
  }

  restart() {
    if (this._chatBusy) this.interrupt();
  }

  getModel() {
    return this.model || '';
  }

  switchModel(model) {
    return this.setModel(model);
  }

  setModel(model) {
    this.model = (model || '').trim();
    return this.model;
  }

  stop() {
    this._stopped = true;
    this.isRunning = false;
    this.exitCode = 0;
    if (this._chatBusy) this.interrupt();
    this._broadcast({ type: 'session_stopped', session_id: this.id });
  }

  resume() {
    if (this.isRunning) return;
    this._stopped = false;
    this.isRunning = true;
    this.exitCode = null;
    this._broadcast({ type: 'session_resumed', session_id: this.id });
  }

  kill() {
    this.isRunning = false;
    this._killChild();
    this._broadcast({ type: 'session_killed', session_id: this.id });
    this.clients.clear();
    this.removeAllListeners();
  }

  _killChild() {
    const child = this.child;
    this.child = null;
    if (this._stdoutRl) { try { this._stdoutRl.close(); } catch (_) {} this._stdoutRl = null; }
    if (!child) return;
    try {
      child.removeAllListeners('exit');
      child.removeAllListeners('error');
      if (child.stdout) child.stdout.removeAllListeners('data');
    } catch (_) {}
    if (child.pid) {
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch (_) {}
      } else {
        try { child.kill('SIGTERM'); } catch (_) {}
      }
    }
  }

  addClient(ws) {
    this.clients.add(ws);
    this._sendToClient(ws, {
      type: 'chat_history',
      session_id: this.id,
      entries: this._chatHistory,
      pending: this._chatPending,
      pendingMs: this._chatPending && this._turnStartedAt ? Date.now() - this._turnStartedAt : null,
    });
    if (this._chatBusy && this._turnText) {
      this._sendToClient(ws, { type: 'session_delta', session_id: this.id, text: this._turnText, replay: true });
    }
  }

  removeClient(ws) { this.clients.delete(ws); }
  getClientCount() { return this.clients.size; }
  getBufferSize() { return this._chatHistory.length; }

  _pushHistory(entry) {
    this._chatHistory.push(entry);
    if (this._chatHistory.length > MAX_CHAT_HISTORY) {
      this._chatHistory = this._chatHistory.slice(-MAX_CHAT_HISTORY);
    }
  }

  _broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.clients) {
      try { if (ws.readyState === 1) ws.send(s); } catch (_) {}
    }
  }

  _sendToClient(ws, msg) {
    try { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch (_) {}
  }
}

module.exports = { CodexSession };
