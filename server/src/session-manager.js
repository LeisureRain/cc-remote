/**
 * Session Manager - Manages all Claude Code process sessions
 *
 * Each session wraps a Claude Code process (via node-pty) and tracks:
 * - Connected WebSocket clients
 * - Output buffer (for reconnection catch-up)
 * - Session lifecycle
 */

const { v4: uuidv4 } = require('uuid');
const { ClaudeSession } = require('./claude-session');

class SessionManager {
  constructor() {
    /** @type {Map<string, ClaudeSession>} */
    this.sessions = new Map();
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
      // Keep session in map for a while so clients can see the exit status
      // Will be cleaned up when a new session is created or client disconnects
    });

    session.on('error', (error) => {
      console.error(`[SessionManager] Session ${id} error:`, error.message);
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
        console.log(`[SessionManager] Cleaned up exited session ${id}`);
      }
    }
  }
}

module.exports = { SessionManager };
