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
const fs = require('fs');
const path = require('path');

// Max chat history entries retained per session (bounds memory + reconnect payload).
const MAX_CHAT_HISTORY = 400;

/**
 * CC Remote's PRIVATE settings overlay, passed to every `claude` via
 * `--settings <file>`. This is the mechanism that lets CC Remote drive a
 * spawned process onto a chosen provider/profile WITHOUT writing the shared
 * ~/.claude/settings.json (which collides with the CC Switch desktop app).
 *
 * Why --settings and not env vars: settings.json's `env` block OVERRIDES real
 * process environment variables, so injecting ANTHROPIC_BASE_URL into the
 * child's env has no effect. `--settings` is a high-precedence overlay that
 * DOES win over the user's settings.json. (Verified empirically.)
 *
 * index.js owns writing this file (on startup and on every profile switch);
 * here we only read it (for --settings and for the launch model).
 */
const ACTIVE_SETTINGS_FILE = path.join(__dirname, '..', 'profiles', 'active-settings.json');

/**
 * Resolve the model to launch `claude` with, read fresh from CC Remote's
 * private active-settings.json overlay (the same file passed via --settings).
 *
 * Why force a model at all: `claude --resume` otherwise pins the model that is
 * recorded in the session's own history file. If the user has since switched to
 * a proxy that doesn't serve that model, resume fails with "model not found".
 * Passing `--model <current>` overrides the stale pin so a resumed session
 * follows whatever profile is active now. Returns '' to mean "don't pass
 * --model" (let claude pick its own default).
 */
function resolveCurrentModel() {
  try {
    const raw = fs.readFileSync(ACTIVE_SETTINGS_FILE, 'utf8');
    const s = JSON.parse(raw);
    return (s && (s.model || (s.env && s.env.ANTHROPIC_MODEL))) || '';
  } catch (e) {
    return '';
  }
}

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

    // Tool-call tracking (P3)
    this._activeToolCount = 0;    // number of tool_use blocks in the current turn
    this._toolPhaseHasText = false; // true once text resumes after tool calls

    // claude session metadata (from system/init)
    this.claudeSessionId = null;
    this.model = null;

    /** @type {import('child_process').ChildProcess|null} */
    this.child = null;
    this._stdoutRl = null;
    this._resume = false;         // first launch creates the session; restarts resume it
    this._noConvoSeen = false;    // set when stderr reports a failed --resume lookup
    this._freshFallbackTried = false; // guards the resume→fresh recovery to once per start
    this._stopped = false;        // true when the user has Stopped (paused) this session

    this._start();
  }

  /**
   * Serialize persistable state for disk storage.
   */
  toJSON() {
    return {
      id: this.id,
      directory: this.directory,
      claudeSessionId: this.claudeSessionId,
      createdAt: this.createdAt.toISOString(),
      permissionMode: this.permissionMode,
      // NOTE: model is intentionally NOT persisted. The launch model is resolved
      // at start time from the live settings.json (see resolveCurrentModel), so a
      // resumed session follows the active profile rather than a stale recording.
      chatHistory: this._chatHistory,
      pending: this._chatPending,
      // Whether the user Stopped (paused) this session. Persisted so a stopped
      // session stays stopped across a server restart instead of auto-resuming.
      stopped: this._stopped,
    };
  }

  /**
   * Reconstruct a session from saved state (e.g. after server restart).
   * Uses --resume to pick up the claude conversation from disk.
   * @param {object} data — the plain object produced by toJSON()
   * @returns {ClaudeSession}
   */
  static fromSaved(data) {
    const session = Object.create(ClaudeSession.prototype);
    EventEmitter.call(session);

    session.id = data.id;
    session.directory = data.directory;
    session.claudeSessionId = data.claudeSessionId || null;
    session.createdAt = new Date(data.createdAt || Date.now());
    session.permissionMode = data.permissionMode || '';
    session.model = null; // not persisted; set later from the system/init event
    session._chatHistory = Array.isArray(data.chatHistory) ? data.chatHistory : [];
    session._chatPending = null; // process was restarted — turn is no longer in-flight
    session.isRunning = false;
    session.exitCode = null;
    session.clients = new Set();
    session._chatBusy = false;
    session._turnText = '';
    session._streaming = false;
    session._activeToolCount = 0;
    session._toolPhaseHasText = false;
    session.child = null;
    session._stdoutRl = null;
    session._resume = true;
    session._noConvoSeen = false;
    session._freshFallbackTried = false;
    session._stopped = !!data.stopped;

    // Trim chat history if over limit
    if (session._chatHistory.length > MAX_CHAT_HISTORY) {
      session._chatHistory = session._chatHistory.slice(-MAX_CHAT_HISTORY);
    }

    // A session the user Stopped stays stopped across a restart (Option B): keep
    // it in the list as a resumable, paused session — do NOT spawn a process.
    // Resuming later (resume()) launches it with --resume to restore context.
    if (session._stopped) {
      session.isRunning = false;
      session.exitCode = 0;
    } else {
      session._start();
    }
    return session;
  }

  // ==========================================================
  // Lifecycle
  // ==========================================================

  _start() {
    this._noConvoSeen = false; // re-armed each launch; set by stderr if --resume misses
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
    // CC Remote's private profile overlay — overrides ~/.claude/settings.json
    // (provider base_url/token/model) per-process without touching the global
    // file. See ACTIVE_SETTINGS_FILE. Quoted in case the path contains spaces.
    if (fs.existsSync(ACTIVE_SETTINGS_FILE)) {
      parts.push('--settings', '"' + ACTIVE_SETTINGS_FILE + '"');
    }
    // Force the currently-active model so `--resume` can't pin a stale model
    // from a proxy the user has since switched away from. Read fresh each start
    // so a resumed/restarted process follows the current profile.
    const model = resolveCurrentModel();
    if (model) parts.push('--model', model);
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
        if (s) {
          // A failed `--resume` lookup prints this. Flag it so the exit
          // handler can recover by starting fresh instead of bricking.
          if (/No conversation found/i.test(s)) this._noConvoSeen = true;
          console.error(`[ClaudeSession ${this.id}] stderr: ${s.substring(0, 500)}`);
        }
      });

      this.child.on('error', (err) => {
        this.isRunning = false;
        console.error(`[ClaudeSession ${this.id}] spawn error:`, err.message);
        this.emit('error', err);
      });

      this.child.on('exit', (code) => {
        this.isRunning = false;

        // Resume recovery: `--resume <id>` fails with exit 1 + "No conversation
        // found" when claude has no stored conversation for this id (e.g. the
        // session was restarted — say by a profile switch — before any turn was
        // ever persisted). Rather than bricking the session, fall back ONCE to a
        // fresh start under the same id so the user can keep chatting. claude's
        // own context is lost, but CC Remote's chat history is preserved, and the
        // fresh start re-creates the conversation so future resumes work.
        if (code !== 0 && this._resume && this._noConvoSeen && !this._freshFallbackTried) {
          this._freshFallbackTried = true;
          this._resume = false;
          this._chatBusy = false;
          this._chatPending = null;
          console.warn(`[ClaudeSession ${this.id}] resume failed (no stored conversation) — starting fresh under same id`);
          const note = '⚠️ Could not restore the previous conversation context; started a new conversation (chat history preserved).';
          this._pushHistory({ role: 'claude', text: '⚠️ _Could not restore the previous conversation context; started a new conversation (chat history preserved)._', ts: Date.now() });
          this._broadcast({ type: 'session_response', session_id: this.id, data: note });
          if (this._stdoutRl) { try { this._stdoutRl.close(); } catch (e) {} this._stdoutRl = null; }
          this.child = null;
          this._start();
          return;
        }

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
        if (obj.subtype === 'init') {
          // A clean init means the process started fine — re-arm the resume→fresh
          // fallback so a LATER restart can recover too (not just the first).
          this._freshFallbackTried = false;
          // Re-broadcast on EVERY init (not only the first) so a restart after
          // a profile switch propagates the freshly-resolved model to clients.
          this.claudeSessionId = obj.session_id || this.claudeSessionId;
          this.model = obj.model || this.model;
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

        // --- tool_use start (P3) ---
        if (ev.type === 'content_block_start' &&
            ev.content_block && ev.content_block.type === 'tool_use') {
          this._activeToolCount++;
          const toolName = ev.content_block.name || 'unknown';
          this._broadcast({
            type: 'session_tool', session_id: this.id,
            status: 'running', name: toolName,
          });
          break;
        }

        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
          const t = ev.delta.text || '';
          if (t) {
            // Resumption of text means all preceding tool calls are done.
            // Broadcast done BEFORE the delta so Android removes tool
            // indicators before updating the streaming bubble.
            if (this._activeToolCount > 0 && !this._toolPhaseHasText) {
              this._toolPhaseHasText = true;
              this._broadcast({ type: 'session_tool', session_id: this.id, status: 'done' });
            }
            this._turnText += t;
            this._streaming = true;
            this._onTextDelta(t);
          }
        }
        break;
      }

      case 'result': {
        // Flush any pending tool indicators (P3)
        if (this._activeToolCount > 0) {
          this._activeToolCount = 0;
          this._toolPhaseHasText = false;
          this._broadcast({ type: 'session_tool', session_id: this.id, status: 'done' });
        }
        const text = (this._turnText && this._turnText.trim()) || obj.result || '';
        this._turnText = '';
        this._streaming = false;
        this._chatBusy = false;
        this._chatPending = null;
        this._pushHistory({ role: 'claude', text, ts: Date.now() });
        this.emit('turnComplete');
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
    this._activeToolCount = 0;       // P3: new turn, reset tool tracking
    this._toolPhaseHasText = false;
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
    this._activeToolCount = 0;       // P3: clear any tool indicators
    this._toolPhaseHasText = false;
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

  /**
   * Restart the claude subprocess so it picks up the current model from
   * ~/.claude/settings.json. If a turn is in-flight it is interrupted
   * first (partial text saved to history). Otherwise it's a silent restart
   * — the session's chat history is preserved via --resume.
   */
  restart() {
    if (this._chatBusy) {
      // Interrupt first (saves partial text, broadcasts interrupted marker),
      // then _restart() kills and relaunches with the fresh model.
      this.interrupt();
      return;
    }
    // Idle restart — clear any stale state and relaunch.
    this._chatBusy = false;
    this._turnText = '';
    this._streaming = false;
    this._activeToolCount = 0;
    this._toolPhaseHasText = false;
    this._restart();
    console.log(`[ClaudeSession ${this.id}] restarted (model refresh)`);
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

  /**
   * Hard kill — terminate the process for good. Used by delete (the persisted
   * file is being purged) and by server shutdown. Detaches child + session
   * listeners BEFORE killing so the async 'exit' event can't trigger a resave
   * that would resurrect a just-deleted session.
   */
  kill() {
    this.isRunning = false;
    this._chatBusy = false;
    this._chatPending = null;
    if (this._stdoutRl) { try { this._stdoutRl.close(); } catch (e) {} this._stdoutRl = null; }

    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.removeAllListeners('exit');
        child.removeAllListeners('error');
        if (child.stdout) child.stdout.removeAllListeners('data');
      } catch (e) {}
      if (child.pid) {
        if (process.platform === 'win32') {
          // Kill the whole tree (shell launcher + claude) — child.kill() alone
          // would only reach the shell on Windows.
          try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch (e) {}
        } else {
          try { child.stdin.end(); } catch (e) {}
          try { child.kill('SIGTERM'); } catch (e) {}
        }
      }
    }
    this._broadcast({ type: 'session_killed', session_id: this.id });
    this.clients.clear();
    this.removeAllListeners();
  }

  /**
   * Stop (pause) the session: terminate the claude process but KEEP the session
   * as a resumable, persisted "stopped" state. The chat history and persisted
   * file are preserved; resume() can relaunch it later with --resume. Clients
   * stay connected so they can see the stopped status and resume in place.
   */
  stop() {
    this._stopped = true;
    this.isRunning = false;
    this.exitCode = 0;
    this._chatBusy = false;
    this._chatPending = null;
    this._streaming = false;
    this._turnText = '';
    this._activeToolCount = 0;
    this._toolPhaseHasText = false;
    if (this._stdoutRl) { try { this._stdoutRl.close(); } catch (e) {} this._stdoutRl = null; }

    // Detach child listeners so the async 'exit' doesn't broadcast session_exited
    // or trip the resume→fresh fallback — we own the lifecycle here and emit
    // session_stopped instead. The SessionManager saves the stopped state.
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.removeAllListeners('exit');
        child.removeAllListeners('error');
        if (child.stdout) child.stdout.removeAllListeners('data');
      } catch (e) {}
      if (child.pid) {
        if (process.platform === 'win32') {
          try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch (e) {}
        } else {
          try { child.stdin.end(); } catch (e) {}
          try { child.kill('SIGTERM'); } catch (e) {}
        }
      }
    }
    console.log(`[ClaudeSession ${this.id}] stopped (paused, resumable)`);
    this._broadcast({ type: 'session_stopped', session_id: this.id });
  }

  /**
   * Resume a stopped session: relaunch the claude process with --resume so it
   * picks up the conversation from disk. No-op if already running. Broadcasts
   * session_resumed; the fresh session_meta arrives on the process's init.
   */
  resume() {
    if (this.isRunning) return;
    this._stopped = false;
    this._resume = true;
    this._freshFallbackTried = false;
    this._chatBusy = false;
    this._chatPending = null;
    this._start();
    this._broadcast({ type: 'session_resumed', session_id: this.id });
    console.log(`[ClaudeSession ${this.id}] resumed`);
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

module.exports = { ClaudeSession, ACTIVE_SETTINGS_FILE };
