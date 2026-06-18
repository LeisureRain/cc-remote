/**
 * Claude Session — wraps a Claude Code process via node-pty.
 *
 * Supports dual output modes:
 *   - Interactive (Web / xterm.js): PTY streaming
 *   - Chat (Android): claude -p --continue per message
 */

const { EventEmitter } = require('events');
const { spawn } = require('node-pty');
const { exec } = require('child_process');
const os = require('os');

const DEBOUNCE_MS = 1500;

// ============================================================
// ANSI stripper (regex + rolling buffer)
// ============================================================
const ANSI_RE = /\x1b\[[\x20-\x3f]*[\x40-\x7e]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[^\[\]\x1b]/g;

class AnsiStripper {
  constructor() { this._pending = ''; }
  feed(chunk) {
    this._pending += chunk;
    // Find the last raw ESC position BEFORE stripping, so we can
    // hold back incomplete escape sequences for the next chunk.
    const lastEsc = this._pending.lastIndexOf('\x1b');
    const cleaned = this._pending.replace(ANSI_RE, '');
    if (lastEsc >= 0) {
      // Only output text before the last ESC; everything from ESC onward
      // may be part of an incomplete sequence — keep it in _pending.
      const out = cleaned.substring(0, lastEsc);
      this._pending = this._pending.substring(lastEsc);
      return out;
    }
    this._pending = '';
    return cleaned;
  }
  flush() { const o = this._pending.replace(/\x1b/g, ''); this._pending = ''; return o; }
}

// ============================================================
// Chat-output cleaning utilities
// ============================================================

/**
 * Collapse terminal \r-overwrites into final visible text.
 * For each line (splits on \n), keep only the text after the last \r.
 * This turns "✻ Baked 2s\r✻ Baked 8s\rDone" into just "Done".
 */
function collapseOverwrites(text) {
  return text.split('\n').map(line => {
    const lastCR = line.lastIndexOf('\r');
    return lastCR >= 0 ? line.substring(lastCR + 1) : line;
  }).join('\n');
}

/**
 * Remove terminal UI cruft AND thinking-process text from chat output.
 * The goal is to keep only the final conversational response — no
 * thinking steps, token counts, tool-run markers, progress bars, or
 * box-drawing art.
 */
function cleanForChat(text) {
  const out = [];
  let blanks = 0;
  const lines = text.split('\n');
  for (const line of lines) {
    const t = line.trim();
    // Track blank runs (collapsed later)
    if (!t) { blanks++; if (blanks <= 2) out.push(''); continue; }
    blanks = 0;

    // ---- Strip UI / drawing lines ----
    const draw = t.match(/[─═━╌╍╴╶╼╾▔▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓]/g);
    if (draw && draw.length > t.length * 0.5) continue;
    const dashes = t.match(/[-─]/g);
    if (dashes && dashes.length > 20 && dashes.length > t.length * 0.7) continue;

    // ---- Strip progress / timing lines ----
    if (/^(✻|\s*(Baked|Churned|Thinking|Checking|Reading|Writing|Analyzing|Indexing|Processing|Loading|Scanning|Computing|Waiting|Retrying|Fetching|Searching|Running|Executing|Collecting|Building|Compiling|Resolving|Downloading|Installing)[\s.]+(for\s+)?(\d+[ms]|…+))/i.test(t)) continue;
    // Duration: 3.2s  |  Tokens: 1234 / Budget: 200k  |  Cost: $0.05
    if (/^(Duration|Tokens?|Cost|Budget|In):?\s/i.test(t)) continue;
    // [Tokens: …]  [Cost: …] bracketed variants
    if (/^\[(Tokens?|Cost|Budget|Duration)[:\]]/i.test(t)) continue;

    // ---- Strip Claude Code internal markers ----
    // ⏺ tool-execution, ⎿ tool-result, ● context markers
    if (/^[⏺⎿●○◉◎▶▸]/u.test(t)) continue;
    // Numbered tool steps: "1. Reading…"  "2. Checking…"
    if (/^\d+\. (Reading|Checking|Looking|Searching|Found|Writing|Running|Analyzing|Processing|Loading|Opening)/.test(t)) continue;

    // ---- Strip thinking-process boilerplate ----
    // Only strip explicitly Claude-internal reflection markers,
    // NOT natural conversational openings (those are real responses).
    if (/^\[\s*(Thinking|Reflection|Reasoning|Planning)\s*\]/.test(t)) continue;

    // ---- Strip tool-output artifacts ----
    // File-list bullets: "    •   " "    -   " "     *   "
    if (/^\s{2,}[•·●-]\s/.test(t)) continue;
    // Path-like patterns (starts with / or drive letter)
    if (/^(├|\+--|\|--|└)/.test(t)) continue;

    // ---- Keep everything else (the response) ----
    out.push(t);
  }
  return out.join('\n');
}

// ============================================================
// ClaudeSession
// ============================================================
class ClaudeSession extends EventEmitter {
  constructor(id, directory, maxBufferLines = 5000) {
    super();
    this.id = id;
    this.directory = directory;
    this.maxBufferLines = maxBufferLines;
    this.createdAt = new Date();
    this.isRunning = false;
    this.exitCode = null;

    /** @type {Set<WebSocket>} */
    this.clients = new Set();

    /** @type {string[]} — raw output for xterm.js replay */
    this.outputBuffer = [];

    this.ansiStripper = new AnsiStripper();

    /** @type {string[]} — accumulated clean chat output */
    this._chatBuffer = [];
    this._debounceTimer = null;
    /** Cached last flushed chat response */
    this._lastChatResponse = null;

    // Chat mode state
    this._chatBusy = false;
    /** @type {string|null} — user message currently being processed */
    this._chatPending = null;
    /** @type {import('child_process').ChildProcess|null} — active claude -p child */
    this._chatChild = null;

    /**
     * Chat history — persisted across client reconnections.
     * @type {Array<{role: 'user'|'claude', text: string, ts: number}>}
     */
    this._chatHistory = [];

    this._isWin = os.platform() === 'win32';

    /** @type {import('node-pty').IPty | null} */
    this.ptyProcess = null;

    this._start();
  }

  // ==========================================================
  // Lifecycle
  // ==========================================================

  _start() {
    try {
      const shellCmd = this._isWin ? 'cmd.exe' : 'bash';
      this.ptyProcess = spawn(shellCmd, [], {
        name: 'xterm-256color',
        cols: 120, rows: 40,
        cwd: this.directory,
        env: Object.assign({}, process.env, {
          TERM: 'xterm-256color',
          FORCE_COLOR: '1',
          CLAUDE_CODE_USE_PTY: '1',
        }),
      });

      this.isRunning = true;
      console.log(`[ClaudeSession ${this.id}] PID ${this.ptyProcess.pid}`);

      this.ptyProcess.onData(d => this._onOutput(d));
      this.ptyProcess.onExit(({ exitCode }) => {
        this.isRunning = false;
        this.exitCode = exitCode;
        console.log(`[ClaudeSession ${this.id}] Exited ${exitCode}`);
        this._flushChat();
        this._broadcast({ type: 'session_exited', session_id: this.id, exit_code: exitCode });
        this.emit('exit', exitCode);
      });

      setTimeout(() => {
        if (!this.ptyProcess || !this.isRunning) return;
        if (this._isWin) {
          this.ptyProcess.write('chcp 65001 >nul\r\n');
          setTimeout(() => { if (this.ptyProcess && this.isRunning) this.ptyProcess.write('claude\r\n'); }, 500);
        } else {
          this.ptyProcess.write('claude\n');
        }
      }, 1000);
    } catch (err) {
      this.isRunning = false;
      this.emit('error', err);
      console.error(`[ClaudeSession ${this.id}] Start error:`, err.message);
    }
  }

  // ==========================================================
  // Output
  // ==========================================================

  _onOutput(data) {
    // Store raw for xterm replay
    this.outputBuffer.push(data);
    if (this.outputBuffer.length > this.maxBufferLines) {
      this.outputBuffer = this.outputBuffer.slice(-this.maxBufferLines);
    }

    // Stream raw to xterm.js clients
    this._broadcast({ type: 'session_output', session_id: this.id, data_raw: data });

    // Accumulate clean output for chat
    // Strip ANSI → CRLF→LF → collapse \r-overwrites → filter cruft
    let clean = this.ansiStripper.feed(data);
    clean = clean.replace(/\r\n/g, '\n');
    clean = collapseOverwrites(clean);
    clean = cleanForChat(clean);
    if (clean) this._chatBuffer.push(clean);

    // Reset debounce — wait for silence then flush
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this._flushChat(), DEBOUNCE_MS);
  }

  /**
   * Flush accumulated chat buffer.
   * Called on debounce timeout (Claude finished) OR user input (start new round).
   */
  _flushChat() {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = null;
    if (this._chatBuffer.length === 0) return;

    const text = this._chatBuffer.join('').replace(/\n{3,}/g, '\n\n').trim();
    this._chatBuffer = [];
    if (!text) return;

    this._lastChatResponse = text;
    this._broadcast({ type: 'session_response', session_id: this.id, data: text });
  }

  // ==========================================================
  // Input
  // ==========================================================

  write(text) {
    if (!this.ptyProcess || !this.isRunning) {
      console.warn(`[ClaudeSession ${this.id}] write: not running`);
      return false;
    }

    // Flush previous Claude response now
    this._flushChat();

    // Normalise to platform line ending
    const eol = this._isWin ? '\r\n' : '\n';
    const normalised = text.replace(/\r\n|\r(?!\n)|\n/g, eol);
    this.ptyProcess.write(normalised);

    const preview = normalised.length > 80
      ? normalised.substring(0, 80).replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '...'
      : normalised.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
    console.log(`[ClaudeSession ${this.id}] Wrote: ${preview}`);
    return true;
  }

  /**
   * Chat mode — run claude -p --continue for clean request/response.
   * After returning, the response survives client disconnect; reconnecting
   * clients receive the full chat history (including this message pair).
   *
   * @param {string} chatText - user message
   * @param {(err: Error|null, result: string|null) => void} cb
   */
  chat(chatText, useContinue, cb) {
    if (this._chatBusy) {
      cb(new Error('Previous message still processing. Please wait.'));
      return;
    }

    // Default: continue mode enabled
    if (useContinue === undefined) useContinue = true;

    const prompt = chatText.replace(/[\r\n]+$/g, '').trim();
    if (!prompt) { cb(null, ''); return; }

    this._chatBusy = true;

    // Record user message in history immediately
    this._chatPending = prompt;
    this._chatHistory.push({ role: 'user', text: prompt, ts: Date.now() });

    // Use exec (not spawn) so the shell handles argument quoting.
    // On Windows spawn {'-p', 'hello world'} gets split to two args;
    // exec 'claude -p "hello world" --continue' preserves it.
    const safePrompt = prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    const continueFlag = useContinue ? '--continue' : '';
    const cmd = `claude -p "${safePrompt}" ${continueFlag}`.replace(/\s+/g, ' ').trim();
    console.log(`[ClaudeSession ${this.id}] ${cmd.substring(0, 200)}`);

    exec(cmd, {
      cwd: this.directory,
      env: Object.assign({}, process.env, { FORCE_COLOR: '0', NO_COLOR: '1' }),
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    }, (error, stdout, stderr) => {
      this._chatBusy = false;
      this._chatPending = null;

      if (error) {
        const errMsg = (stderr || '').trim() || error.message;
        console.error(`[ClaudeSession ${this.id}] claude -p failed: ${errMsg}`);
        this._chatHistory.push({ role: 'claude', text: '❌ ' + errMsg, ts: Date.now() });
        cb(new Error(errMsg));
        return;
      }

      const raw = stdout || '';
      const text = raw.replace(ANSI_RE, '').trim();
      console.log(`[ClaudeSession ${this.id}] claude -p returned ${raw.length} chars (${text.length} after ANSI strip)`);

      this._chatHistory.push({ role: 'claude', text, ts: Date.now() });
      this._lastChatResponse = text;
      cb(null, text);
    });
  }

  // ==========================================================
  // Client / lifecycle management
  // ==========================================================

  resize(cols, rows) {
    try { if (this.ptyProcess && this.isRunning) this.ptyProcess.resize(Math.max(40, cols), Math.max(10, rows)); } catch (e) {}
  }

  kill() {
    clearTimeout(this._debounceTimer);
    this._flushChat();
    if (this.ptyProcess) {
      try { this.ptyProcess.write('\x03'); setTimeout(() => { if (this.ptyProcess && this.isRunning) this.ptyProcess.kill(); }, 1000); } catch (e) {}
    }
    this._broadcast({ type: 'session_killed', session_id: this.id });
    this.clients.clear();
  }

  addClient(ws) {
    this.clients.add(ws);
    console.log(`[ClaudeSession ${this.id}] +client (${this.clients.size})`);

    // Send full chat history so the client can rebuild the conversation.
    // Includes all completed messages + pending state if claude is busy.
    this._sendToClient(ws, {
      type: 'chat_history',
      session_id: this.id,
      entries: this._chatHistory,
      pending: this._chatPending,  // null | user message currently processing
    });

    // Raw PTY replay for xterm.js web clients
    if (this.outputBuffer.length > 0) {
      const recent = this.outputBuffer.slice(-200).join('');
      this._sendToClient(ws, { type: 'session_output', session_id: this.id, data_raw: recent, replay: true });
    }
  }

  removeClient(ws) {
    this.clients.delete(ws);
    console.log(`[ClaudeSession ${this.id}] -client (${this.clients.size})`);
  }

  getClientCount() { return this.clients.size; }
  getBufferSize() { return this.outputBuffer.length; }

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
