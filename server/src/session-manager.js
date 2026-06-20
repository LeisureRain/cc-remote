/**
 * Session Manager - Manages all Claude Code process sessions
 *
 * Each session wraps a Claude Code process (via node-pty) and tracks:
 * - Connected WebSocket clients
 * - Output buffer (for reconnection catch-up)
 * - Session lifecycle
 */

const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { ClaudeSession } = require('./claude-session');

class SessionManager {
  constructor(options = {}) {
    /** @type {Map<string, ClaudeSession>} */
    this.sessions = new Map();

    this.persistSessions = options.persistSessions !== false; // default true
    this.sessionsDir = options.sessionsDir
      ? path.resolve(options.sessionsDir)
      : path.join(__dirname, '..', 'sessions');
    this._savePending = new Set();

    // Periodic safety save — every 30 seconds save all idle sessions
    this._saveInterval = setInterval(() => this.saveAllActive(), 30000);
    if (this._saveInterval.unref) this._saveInterval.unref();
  }

  /**
   * Create a new Claude Code session
   * @param {string} directory - Working directory for Claude Code
   * @param {object} [options] - { permissionMode }
   * @returns {ClaudeSession}
   */
  createSession(directory, options = {}) {
    const id = uuidv4();
    const session = new ClaudeSession(id, directory, options);

    session.on('exit', (code) => {
      console.log(`[SessionManager] Session ${id} exited with code ${code}`);
      this.saveSession(session);
      // Keep session in map for a while so clients can see the exit status
      // Will be cleaned up periodically
    });

    session.on('error', (error) => {
      console.error(`[SessionManager] Session ${id} error:`, error.message);
    });

    session.on('turnComplete', () => {
      // Debounce — batch rapid turn completions
      if (this._savePending.has(id)) return;
      this._savePending.add(id);
      setImmediate(() => {
        this._savePending.delete(id);
        this.saveSession(session);
      });
    });

    this.sessions.set(id, session);
    console.log(`[SessionManager] Created session ${id} in ${directory}`);
    return session;
  }

  /**
   * Get a session by ID
   * @param {string} id
   * @returns {ClaudeSession|undefined}
   */
  getSession(id) {
    return this.sessions.get(id);
  }

  /**
   * Kill and remove a session
   * @param {string} id
   * @returns {boolean}
   */
  killSession(id) {
    const session = this.sessions.get(id);
    if (!session) return false;

    session.kill();
    this.sessions.delete(id);
    this.deleteSessionFile(id);
    console.log(`[SessionManager] Killed and removed session ${id}`);
    return true;
  }

  /**
   * Get list of all sessions with summary info
   * @returns {Array<{id: string, directory: string, createdAt: string, status: string, clientCount: number}>}
   */
  listSessions() {
    const list = [];
    for (const [id, session] of this.sessions) {
      list.push({
        id,
        directory: session.directory,
        createdAt: session.createdAt.toISOString(),
        status: session.isRunning ? 'running' : 'exited',
        exitCode: session.exitCode,
        clientCount: session.getClientCount(),
        bufferSize: session.getBufferSize(),
      });
    }
    // Sort by creation time, newest first
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return list;
  }

  /**
   * Clean up exited sessions that have no clients
   */
  cleanup() {
    for (const [id, session] of this.sessions) {
      if (!session.isRunning && session.getClientCount() === 0) {
        this.sessions.delete(id);
        this.deleteSessionFile(id);
        console.log(`[SessionManager] Cleaned up exited session ${id}`);
      }
    }
  }

  // ==========================================================
  // Persistence — save/restore session state to disk
  // ==========================================================

  /** Create the sessions directory if it doesn't exist. */
  ensureSessionsDir() {
    if (!this.persistSessions) return false;
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
      console.log(`[SessionManager] Created sessions directory: ${this.sessionsDir}`);
    }
    return true;
  }

  /**
   * Save a single session's state to disk.
   * @param {ClaudeSession} session
   */
  saveSession(session) {
    if (!this.persistSessions) return;
    try {
      if (!fs.existsSync(this.sessionsDir)) {
        fs.mkdirSync(this.sessionsDir, { recursive: true });
      }
      const filePath = path.join(this.sessionsDir, `${session.id}.json`);
      const data = session.toJSON();
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error(`[SessionManager] Failed to save session ${session.id}:`, err.message);
    }
  }

  /** Delete the persisted file for a session. */
  deleteSessionFile(id) {
    if (!this.persistSessions) return;
    try {
      const filePath = path.join(this.sessionsDir, `${id}.json`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      console.error(`[SessionManager] Failed to delete session file ${id}:`, err.message);
    }
  }

  /** Save all active, idle sessions (safety net, called by periodic timer). */
  saveAllActive() {
    if (!this.persistSessions) return;
    for (const [id, session] of this.sessions) {
      if (session.isRunning && !session._chatBusy) {
        this.saveSession(session);
      }
    }
  }

  /**
   * Restore sessions from disk on server startup.
   * Called before the server starts accepting connections.
   */
  restoreSessions() {
    if (!this.persistSessions) return;
    if (!fs.existsSync(this.sessionsDir)) return;

    let files;
    try {
      files = fs.readdirSync(this.sessionsDir);
    } catch (err) {
      console.error('[SessionManager] Cannot read sessions directory:', err.message);
      return;
    }

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(this.sessionsDir, file);
      let data;
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        data = JSON.parse(raw);
      } catch (err) {
        console.warn(`[SessionManager] Corrupted session file ${file}, deleting`);
        try { fs.unlinkSync(filePath); } catch (_) {}
        continue;
      }

      // Validate required fields
      if (!data.id || !data.directory) {
        console.warn(`[SessionManager] Invalid session file ${file}, deleting`);
        try { fs.unlinkSync(filePath); } catch (_) {}
        continue;
      }

      // Check the directory still exists
      if (!fs.existsSync(data.directory)) {
        console.warn(`[SessionManager] Directory gone for session ${data.id}, deleting state file`);
        try { fs.unlinkSync(filePath); } catch (_) {}
        continue;
      }

      // Restore session
      try {
        const session = ClaudeSession.fromSaved(data);

        // Wire up events (same as createSession)
        session.on('exit', (code) => {
          console.log(`[SessionManager] Session ${session.id} exited with code ${code}`);
          this.saveSession(session);
        });

        session.on('error', (error) => {
          console.error(`[SessionManager] Session ${session.id} error:`, error.message);
        });

        session.on('turnComplete', () => {
          if (this._savePending.has(session.id)) return;
          this._savePending.add(session.id);
          setImmediate(() => {
            this._savePending.delete(session.id);
            this.saveSession(session);
          });
        });

        this.sessions.set(data.id, session);
        console.log(`[SessionManager] Restored session ${data.id} (resume=${session._resume})`);
      } catch (err) {
        console.error(`[SessionManager] Failed to restore session ${data.id}:`, err.message);
      }
    }

    console.log(`[SessionManager] Restored ${this.sessions.size} session(s)`);
  }
}

module.exports = { SessionManager };
