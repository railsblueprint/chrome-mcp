/**
 * Extension WebSocket Server
 *
 * Simple WebSocket server that extension connects to.
 * Replaces Playwright's CDPRelayServer with our own lightweight implementation.
 */

const http = require('http');
const { WebSocketServer } = require('ws');

function debugLog(...args) {
  if (global.DEBUG_MODE) {
    console.error('[ExtensionServer]', ...args);
  }
}

class ExtensionServer {
  constructor(port = 5555, host = '127.0.0.1') {
    this._port = port;
    this._host = host;
    this._httpServer = null;
    this._wss = null;
    this._extensionWs = null; // Current extension WebSocket connection
    this._pendingRequests = new Map(); // requestId -> {resolve, reject}
    this.onReconnect = null; // Callback when extension reconnects (replaces old connection)
  }

  /**
   * Start the server
   */
  async start() {
    return new Promise((resolve, reject) => {
      // Create HTTP server
      this._httpServer = http.createServer((req, res) => {
        res.writeHead(200);
        res.end('Extension WebSocket Server');
      });

      // Create WebSocket server
      this._wss = new WebSocketServer({ server: this._httpServer });

      // Register WebSocket server error handler
      this._wss.on('error', (error) => {
        debugLog('WebSocketServer error:', error);
        reject(error);
      });

      this._wss.on('connection', (ws) => {
        debugLog('Extension connected');

        // Close previous connection if any
        const isReconnection = !!this._extensionWs;
        if (this._extensionWs) {
          debugLog('Closing previous extension connection - RECONNECTION DETECTED');
          this._extensionWs.close();
        }

        this._extensionWs = ws;

        // Notify about reconnection after setting the new connection
        if (isReconnection && this.onReconnect) {
          debugLog('Calling onReconnect callback');
          this.onReconnect();
        }

        ws.on('message', (data) => {
          this._handleMessage(data);
        });

        ws.on('close', () => {
          debugLog('Extension disconnected');
          if (this._extensionWs === ws) {
            this._extensionWs = null;
          }
        });

        ws.on('error', (error) => {
          debugLog('WebSocket error:', error);
        });
      });

      // Register HTTP server error handler BEFORE calling listen() to catch port-in-use errors
      this._httpServer.on('error', (error) => {
        debugLog('HTTP Server error:', error);
        reject(error);
      });

      // Start listening
      this._httpServer.listen(this._port, this._host, () => {
        debugLog(`Server listening on ${this._host}:${this._port}`);
        resolve();
      });
    });
  }

  /**
   * Handle incoming message from extension
   */
  _handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());
      debugLog('Received from extension:', message.method || 'response');

      // Check if it's a response (has id but no method)
      if (message.id !== undefined && !message.method) {
        const pending = this._pendingRequests.get(message.id);
        if (pending) {
          this._pendingRequests.delete(message.id);

          if (message.error) {
            pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
          } else {
            pending.resolve(message.result);
          }
        }
        return;
      }

      // Handle notifications (has method but no id) - just log
      if (message.method && message.id === undefined) {
        debugLog('Received notification:', message.method);
        return;
      }
    } catch (error) {
      debugLog('Error handling message:', error);
    }
  }

  /**
   * Send a command to the extension and wait for response
   */
  async sendCommand(method, params = {}, timeout = 30000) {
    if (!this._extensionWs || this._extensionWs.readyState !== 1) {
      throw new Error('Extension not connected. Please click the extension icon and click "Connect".');
    }

    const id = Math.random().toString(36).substring(7);

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeout);

      this._pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      });

      const message = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };

      debugLog('Sending to extension:', method);
      this._extensionWs.send(JSON.stringify(message));
    });
  }

  /**
   * Check if extension is connected
   */
  isConnected() {
    return this._extensionWs && this._extensionWs.readyState === 1;
  }

  /**
   * Stop the server
   */
  async stop() {
    debugLog('Stopping server');

    if (this._extensionWs) {
      this._extensionWs.close();
      this._extensionWs = null;
    }

    if (this._wss) {
      this._wss.close();
      this._wss = null;
    }

    if (this._httpServer) {
      return new Promise((resolve) => {
        this._httpServer.close(() => {
          debugLog('Server stopped');
          resolve();
        });
      });
    }
  }
}

module.exports = { ExtensionServer };
