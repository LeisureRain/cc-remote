/**
 * OpenCode run session adapter.
 *
 * MVP uses `opencode run --format json` once per user turn. OpenCode persists
 * its own session and returns a `sessionID`; later turns resume with
 * `opencode run --session <id> --format json`.
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');

const MAX_CHAT_HISTORY = 400;
const DEFAULT_MODEL_KEY = '__default__';
const MODEL_SWITCH_CONTEXT_MESSAGES = 12;
const MODEL_SWITCH_CONTEXT_CHARS = 6000;

function quoteArg(s) {
  return '"' + String(s).replace(/(["\\])/g, '\\$1') + '"';
}

function commandFor(args) {
  if (process.platform !== 'win32') return { file: 'opencode', args, shell: false };
  const appData = process.env.APPDATA || '';
  const exe = appData
    ? path.join(appData, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
    : 'opencode';
  return { file: exe, args, shell: false };
}

function summarizeTool(part) {
  if (!part || typeof part !== 'object') return null;
  const type = part.type || '';
  if (!type.includes('tool')) return null;
  return {
    name: part.tool || part.name || part.call || type,
    detail: part.title || part.command || part.path || part.input || '',
  };
}

function formatOpenCodeError(obj) {
  const err = obj && obj.error;
  const message = err && err.data && err.data.message
    ? err.data.message
    : (obj && (obj.message || obj.text));
  if (!message) return JSON.stringify(obj || {});
  const ref = err && err.data && err.data.ref ? ` (${err.data.ref})` : '';
  return `OpenCode error: ${message}${ref}`;
}

function modelKey(model) {
  return (model || '').trim() || DEFAULT_MODEL_KEY;
}

class OpenCodeSession extends EventEmitter {
  constructor(id, directory, options = {}) {
    super();
    this.agent = 'opencode';
    this.id = id;
    this.directory = directory;
    this.createdAt = new Date();
    this.isRunning = true;
    this.exitCode = null;
    this.model = options.model || '';
    this.openCodeSessionId = options.openCodeSessionId || null;
    this.openCodeSessionIdsByModel = Object.assign({}, options.openCodeSessionIdsByModel || {});
    if (this.openCodeSessionId) {
      this.openCodeSessionIdsByModel[modelKey(this.model)] = this.openCodeSessionId;
    }

    this.clients = new Set();
    this._chatHistory = [];
    this._chatBusy = false;
    this._chatPending = null;
    this._turnText = '';
    this._turnStartedAt = 0;
    this._modelChangedSinceLastTurn = false;
    this._stopped = false;
    this._finalSent = false;
    this.child = null;
    this._stdoutRl = null;
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
        openCodeSessionId: this.openCodeSessionId,
        openCodeSessionIdsByModel: this.openCodeSessionIdsByModel,
      },
    };
  }

  static fromSaved(data) {
    const state = data.agentState || {};
    const session = new OpenCodeSession(data.id, data.directory, {
      model: data.model || '',
      openCodeSessionId: state.openCodeSessionId || data.openCodeSessionId || null,
      openCodeSessionIdsByModel: state.openCodeSessionIdsByModel || {},
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
    const outboundPrompt = this._modelChangedSinceLastTurn
      ? this._withModelSwitchContext(prompt)
      : prompt;
    this._modelChangedSinceLastTurn = false;
    this._pushHistory({ role: 'user', text: prompt, ts: Date.now() });

    const args = ['run', '--format', 'json', '--dir', this.directory];
    if (this.model) args.push('--model', this.model);
    if (this.openCodeSessionId) args.push('--session', this.openCodeSessionId);
    args.push(outboundPrompt);

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
      return { ok: false, error: 'Failed to start opencode: ' + err.message };
    }

    console.log(`[OpenCodeSession ${this.id}] PID ${this.child.pid} (${this.openCodeSessionId ? 'resume' : 'new'})`);

    this.child.stdout.on('error', (err) => {
      console.error(`[OpenCodeSession ${this.id}] stdout error: ${err.message}`);
    });
    this._stdoutRl = readline.createInterface({ input: this.child.stdout });
    this._stdoutRl.on('line', (line) => this._onLine(line));
    this._stdoutRl.on('error', (err) => {
      console.error(`[OpenCodeSession ${this.id}] readline error: ${err.message}`);
    });

    this.child.stderr.on('error', (err) => {
      console.error(`[OpenCodeSession ${this.id}] stderr error: ${err.message}`);
    });
    this.child.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) console.error(`[OpenCodeSession ${this.id}] stderr: ${s.substring(0, 500)}`);
    });

    this.child.on('error', (err) => {
      this._finishTurn({ isError: true, text: 'Failed to run opencode: ' + err.message });
      this.emit('error', err);
    });

    this.child.on('exit', (code) => {
      this.exitCode = code;
      this.child = null;
      if (this._stdoutRl) { try { this._stdoutRl.close(); } catch (_) {} this._stdoutRl = null; }
      const text = this._turnText.trim() || (code !== 0 ? `OpenCode exited with code ${code}` : '');
      this._finishTurn({ isError: code !== 0, text });
    });

    return { ok: true };
  }

  _onLine(line) {
    line = String(line || '').trim();
    if (!line) return;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { return; }

    if (obj.sessionID && obj.sessionID !== this.openCodeSessionId) {
      this._setOpenCodeSessionId(obj.sessionID);
    }

    // Auto-approve: if opencode asks for approval (e.g. for tool execution),
    // write y\n to stdin so it doesn't hang waiting for user input.
    {
      const haystack = (String(obj.type || obj.event || obj.kind || '') + ' ' +
        String((obj.part || obj).type || (obj.part || obj).kind || '')).toLowerCase();
      if (/(approval|permission|confirm|escalat)/.test(haystack) &&
          !/(response|result|completed|denied|approved)/.test(haystack)) {
        try { if (this.child && this.child.stdin && this.child.stdin.writable) this.child.stdin.write('y\n'); } catch (_) {}
        this._broadcast({ type: 'operation_approval_request', session_id: this.id, agent: this.agent });
        return;
      }
    }

    const part = obj.part || obj;
    if (obj.type === 'text' && part && typeof part.text === 'string') {
      this._turnText += part.text;
      this._broadcast({ type: 'session_delta', session_id: this.id, text: part.text });
      return;
    }

    const tool = summarizeTool(part);
    if (tool) {
      this._broadcast({
        type: 'session_tool',
        session_id: this.id,
        status: obj.type && obj.type.includes('finish') ? 'done' : 'running',
        name: tool.name,
        detail: typeof tool.detail === 'string' ? tool.detail : JSON.stringify(tool.detail || ''),
      });
    }

    if (obj.type === 'error') {
      this._finishTurn({ isError: true, text: formatOpenCodeError(obj) });
    }
  }

  _finishTurn({ isError, text }) {
    if (this._finalSent) return;
    this._finalSent = true;
    this._chatBusy = false;
    this._chatPending = null;
    this._turnText = '';
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
    console.log(`[OpenCodeSession ${this.id}] interrupted`);
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
    const nextModel = (model || '').trim();
    if (nextModel === this.model) return this.model;

    if (this.openCodeSessionId) {
      this.openCodeSessionIdsByModel[modelKey(this.model)] = this.openCodeSessionId;
    }
    this.model = nextModel;
    const mappedSessionId = this.openCodeSessionIdsByModel[modelKey(this.model)] || null;
    if (mappedSessionId !== this.openCodeSessionId) {
      this.openCodeSessionId = mappedSessionId;
      this._broadcast({ type: 'session_meta', session_id: this.id, opencode_session_id: this.openCodeSessionId });
    }
    this._modelChangedSinceLastTurn = true;
    return this.model;
  }

  _setOpenCodeSessionId(sessionId) {
    this.openCodeSessionId = sessionId || null;
    if (this.openCodeSessionId) {
      this.openCodeSessionIdsByModel[modelKey(this.model)] = this.openCodeSessionId;
    }
    this._broadcast({ type: 'session_meta', session_id: this.id, opencode_session_id: this.openCodeSessionId });
  }

  _withModelSwitchContext(prompt) {
    const history = this._chatHistory
      .filter((entry) => entry && entry.text && (entry.role === 'user' || entry.role === 'claude'))
      .slice(-MODEL_SWITCH_CONTEXT_MESSAGES);
    if (history.length === 0) return prompt;

    let transcript = '';
    for (const entry of history) {
      const role = entry.role === 'user' ? 'User' : 'Assistant';
      transcript += `${role}: ${String(entry.text).trim()}\n`;
    }
    if (transcript.length > MODEL_SWITCH_CONTEXT_CHARS) {
      transcript = transcript.slice(-MODEL_SWITCH_CONTEXT_CHARS);
    }

    return [
      'The user switched models in the same CC Remote chat.',
      'Use the following recent transcript as prior conversation context. Do not mention this wrapper unless asked.',
      '<recent_context>',
      transcript.trim(),
      '</recent_context>',
      '',
      prompt,
    ].join('\n');
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

module.exports = { OpenCodeSession };
