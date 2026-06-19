/**
 * Claude Session — wraps ONE persistent Claude Code process per session.
 *
 * The process runs in headless stream-json mode:
 *   claude -p --input-format stream-json --output-format stream-json \
 *          --include-partial-messages --verbose --session-id <id>
 *
 * User messages are written to stdin as newline-delimited JSON (no shell
 * escaping), and the NDJSON event stream on stdout is parsed into:
 *   - session_delta   (streaming text chunks, P2)
 *   - session_response (final turn text — same shape as before, so existing
 *                       clients keep working)
 * The single process preserves full conversation context across turns.
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const readline = require('readline');

// Max chat history entries retained per session (bounds memory + reconnect payload).
const MAX_CHAT_HISTORY = 400;

class ClaudeSession extends EventEmitter {
  constructor(id, directory, options = {}) {
    super();
    this.id = id;                 // also used as the claude --session-id (UUID)
    this.directory = directory;
    this.permissionMode = options.permissionMode || '';
    this.createdAt = new Date();
    this.isRunning = false;
    this.exitCode = null;

    /** @type {Set<WebSocket>} */
    this.clients = new Set();

    /**
     * Chat history — persisted across client reconnections.
     * @type {Array<{role: 'user'|'claude', text: string, ts: number}>}
     */
    this._chatHistory = [];

    // Per-turn state
    this._chatBusy = false;
    this._chatPending = null;     // user message currently being processed
    this._turnText = '';          // accumulated assistant text for the active turn
    this._streaming = false;

    // claude session metadata (from system/init)
    this.claudeSessionId = null;
    this.model = null;

    /** @type {import('child_process').ChildProcess|null} */
    this.child = null;
    this._stdoutRl = null;
    this._resume = false;         // first launch creates the session; restarts resume it

    this._start();
  }

  // ==========================================================
  // Lifecycle
  // ==========================================================

  _start() {
    const parts = [
      'claude', '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
    ];
    if (this._resume) parts.push('--resume', this.id);
    else parts.push('--session-id', this.id);
    if (this.permissionMode) parts.push('--permission-mode', this.permissionMode);
    // Single command string + shell:true (rather than an args array) so Windows
    // resolves the `claude` launcher and we avoid Node's DEP0190 warning. Every
    // token here is fixed/trusted — the user prompt travels via stdin, never the
    // command line — so there is nothing for the shell to mis-parse or inject.
    const cmd = parts.join(' ');

    try {
      this.child = spawn(cmd, {
        cwd: this.directory,
        shell: true,
        env: Object.assign({}, process.env, { FORCE_COLOR: '0', NO_COLOR: '1' }),
      });

      this.isRunning = true;
      console.log(`[ClaudeSession ${this.id}] PID ${this.child.pid} (${this._resume ? 'resume' : 'new'})`);

      this._stdoutRl = readline.createInterface({ input: this.child.stdout });
      this._stdoutRl.on('line', (line) => this._onLine(line));

      this.child.stderr.on('data', (d) => {
        const s = d.toString().trim();
        if (s) console.error(`[ClaudeSession ${this.id}] stderr: ${s.substring(0, 500)}`);
      });

      this.child.on('error', (err) => {
        this.isRunning = false;
        console.error(`[ClaudeSession ${this.id}] spawn error:`, err.message);
        this.emit('error', err);
      });

      this.child.on('exit', (code) => {
        this.isRunning = false;
        this.exitCode = code;
        this._chatBusy = false;
        this._chatPending = null;
        console.log(`[ClaudeSession ${this.id}] Exited ${code}`);
        this._broadcast({ type: 'session_exited', session_id: this.id, exit_code: code });
        this.emit('exit', code);
      });
    } catch (err) {
      this.isRunning = false;
      this.emit('error', err);
      console.error(`[ClaudeSession ${this.id}] Start error:`, err.message);
    }
  }

  // ==========================================================
  // Output — parse the stream-json NDJSON event stream
  // ==========================================================

  _onLine(line) {
    line = line.trim();
    if (!line) return;
    let obj;
    try { obj = JSON.parse(line); } catch (e) { return; } // ignore non-JSON noise

    switch (obj.type) {
      case 'system':
        if (obj.subtype === 'init' && !this.claudeSessionId) {
          this.claudeSessionId = obj.session_id || null;
          this.model = obj.model || null;
          this._broadcast({
            type: 'session_meta', session_id: this.id,
            claude_session_id: this.claudeSessionId, model: this.model,
            tools: obj.tools || [],
          });
        }
        break;

      case 'stream_event': {
        const ev = obj.event;
        if (!ev) break;
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
          const t = ev.delta.text || '';
          if (t) {
            this._turnText += t;
            this._streaming = true;
            this._onTextDelta(t);
          }
        }
        break;
      }

      case 'result': {
        const text = (this._turnText && this._turnText.trim()) || obj.result || '';
        this._turnText = '';
        this._streaming = false;
        this._chatBusy = false;
        this._chatPending = null;
        this._pushHistory({ role: 'claude', text, ts: Date.now() });
        // Keep the historic `session_response` shape so existing clients work.
        this._broadcast({
          type: 'session_response', session_id: this.id, data: text,
          is_error: !!obj.is_error, cost_usd: obj.total_cost_usd, duration_ms: obj.duration_ms,
        });
        break;
      }
    }
  }

  /**
   * Streaming text chunk → broadcast as session_delta so clients can render
   * the response incrementally. The final session_response still arrives on
   * `result` and is the canonical/finalized text.
   */
  _onTextDelta(text) {
    this._broadcast({ type: 'session_delta', session_id: this.id, text });
  }

  /** Append a chat-history entry, trimming to MAX_CHAT_HISTORY. */
  _pushHistory(entry) {
    this._chatHistory.push(entry);
    if (this._chatHistory.length > MAX_CHAT_HISTORY) {
      this._chatHistory = this._chatHistory.slice(-MAX_CHAT_HISTORY);
    }
  }

  // ==========================================================
  // Input
  // ==========================================================

  /**
   * Send a user message to the persistent claude process via stdin.
   * @returns {{ok: boolean, error?: string}}
   */
  sendMessage(text) {
    const prompt = (text || '').replace(/[\r\n]+$/g, '');
    if (!prompt.trim()) return { ok: false, error: 'Empty message' };
    if (!this.isRunning || !this.child || !this.child.stdin.writable) {
      return { ok: false, error: 'Session is not running' };
    }
    if (this._chatBusy) {
      return { ok: false, error: 'Previous message still processing. Please wait.' };
    }

    this._chatBusy = true;
    this._chatPending = prompt;
    this._turnText = '';
    this._pushHistory({ role: 'user', text: prompt, ts: Date.now() });

    const envelope = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } };
    try {
      this.child.stdin.write(JSON.stringify(envelope) + '\n');
    } catch (e) {
      this._chatBusy = false;
      this._chatPending = null;
      return { ok: false, error: 'Failed to write to claude: ' + e.message };
    }
    console.log(`[ClaudeSession ${this.id}] -> message (${prompt.length} chars)`);
    return { ok: true };
  }

  /**
   * Interrupt the in-flight turn. Implemented by restarting the process and
   * resuming the same session (reliable across platforms; the control-message
   * interrupt path can replace this later). The partial text seen so far is
   * finalized so the client's streaming bubble settles.
   * @returns {{ok: boolean, error?: string}}
   */
  interrupt() {
    if (!this._chatBusy) return { ok: false, error: 'Nothing to interrupt' };
    const partial = (this._turnText && this._turnText.trim()) || '';
    this._restart();
    this._chatBusy = false;
    this._chatPending = null;
    this._streaming = false;
    this._turnText = '';
    const text = partial ? partial + '\n\n⏹ _(interrupted)_' : '⏹ _(interrupted)_';
    this._pushHistory({ role: 'claude', text, ts: Date.now() });
    this._broadcast({ type: 'session_response', session_id: this.id, data: text, interrupted: true });
    console.log(`[ClaudeSession ${this.id}] interrupted`);
    return { ok: true };
  }

  /** Kill the current process (silently) and relaunch it resuming the session. */
  _restart() {
    this._resume = true;
    if (this._stdoutRl) { try { this._stdoutRl.close(); } catch (e) {} this._stdoutRl = null; }
    const old = this.child;
    this.child = null;
    if (old) {
      // Detach listeners first so the kill doesn't fire our exit handler
      // (which would tell clients the whole session exited).
      try {
        old.removeAllListeners('exit');
        old.removeAllListeners('error');
        if (old.stdout) old.stdout.removeAllListeners('data');
      } catch (e) {}
      if (old.pid) {
        if (process.platform === 'win32') {
          try { spawn('taskkill', ['/PID', String(old.pid), '/T', '/F']); } catch (e) {}
        } else {
          try { old.kill('SIGTERM'); } catch (e) {}
        }
      }
    }
    this._start();
  }

  // ==========================================================
  // Client / lifecycle management
  // ==========================================================

  kill() {
    this.isRunning = false;
    if (this._stdoutRl) { try { this._stdoutRl.close(); } catch (e) {} }
    if (this.child && this.child.pid) {
      if (process.platform === 'win32') {
        // Kill the whole tree (shell launcher + claude) — child.kill() alone
        // would only reach the shell on Windows.
        try { spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F']); } catch (e) {}
      } else {
        try { this.child.stdin.end(); } catch (e) {}
        try { this.child.kill('SIGTERM'); } catch (e) {}
      }
    }
    this._broadcast({ type: 'session_killed', session_id: this.id });
    this.clients.clear();
  }

  addClient(ws) {
    this.clients.add(ws);
    console.log(`[ClaudeSession ${this.id}] +client (${this.clients.size})`);

    // Send full chat history so the client can rebuild the conversation.
    this._sendToClient(ws, {
      type: 'chat_history',
      session_id: this.id,
      entries: this._chatHistory,
      pending: this._chatPending,
    });

    // If a turn is streaming right now, send what we have so far.
    if (this._streaming && this._turnText) {
      this._sendToClient(ws, { type: 'session_delta', session_id: this.id, text: this._turnText, replay: true });
    }
  }

  removeClient(ws) {
    this.clients.delete(ws);
    console.log(`[ClaudeSession ${this.id}] -client (${this.clients.size})`);
  }

  getClientCount() { return this.clients.size; }
  getBufferSize() { return this._chatHistory.length; }

  _broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.clients) {
      try { if (ws.readyState === 1) ws.send(s); } catch (e) {}
    }
  }

  _sendToClient(ws, msg) {
    try { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch (e) {}
  }
}

module.exports = { ClaudeSession };
