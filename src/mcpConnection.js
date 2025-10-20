/**
 * Unified MCP Connection
 *
 * Handles both direct and proxy mode connections using JSON-RPC 2.0.
 *
 * Direct Mode:
 * - Connects directly to extension WebSocket (ws://localhost:XXXX)
 * - Starts sending tool commands immediately
 *
 * Proxy Mode:
 * - Connects to proxy server (wss://proxy-server/mcp)
 * - Authenticates with access token
 * - Lists and connects to an extension
 * - Then sends tool commands
 */

const WebSocket = require('ws');
const { randomUUID } = require('crypto');

// Helper function for debug logging
function debugLog(...args) {
  if (global.DEBUG_MODE) {
    console.error('[MCPConnection]', ...args);
  }
}

class MCPConnection {
  constructor(config) {
    this.mode = config.mode; // 'direct' or 'proxy'
    this.url = config.url;
    this.accessToken = config.accessToken; // Only for proxy mode
    this._ws = null;
    this._connected = false;
    this._authenticated = false; // For proxy mode
    this._connectionId = null; // For proxy mode - connection to specific extension
    this._pendingRequests = new Map(); // requestId -> { resolve, reject, timeoutId }
  }

  /**
   * Connect and initialize
   */
  async connect() {
    debugLog('Connecting in', this.mode, 'mode to:', this.url);

    await this._connectWebSocket(this.url);

    if (this.mode === 'proxy') {
      // Authenticate with proxy
      debugLog('Authenticating with proxy...');
      await this.sendRequest('mcp_handshake', { accessToken: this.accessToken });
      this._authenticated = true;
      debugLog('Authenticated successfully');

      // List available extensions
      debugLog('Listing extensions...');
      const extensionsResult = await this.sendRequest('list_extensions', {});
      debugLog('Available extensions:', extensionsResult);

      if (!extensionsResult || !extensionsResult.extensions || extensionsResult.extensions.length === 0) {
        throw new Error('No browser extensions are connected to the proxy.');
      }

      // Auto-connect to the first extension
      const firstExtension = extensionsResult.extensions[0];
      debugLog('Connecting to extension:', firstExtension.id);

      const connectResult = await this.sendRequest('connect', { extensionId: firstExtension.id });
      this._connectionId = connectResult.connection_id;
      debugLog('Connected to extension:', firstExtension.name, 'connectionId:', this._connectionId);
    }

    debugLog('Connection ready for tool calls');
  }

  /**
   * Establish WebSocket connection
   */
  async _connectWebSocket(url) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
      }, 30000);

      this._ws = new WebSocket(url);

      this._ws.on('open', () => {
        debugLog('WebSocket connected');
        this._connected = true;
        clearTimeout(timeout);
        resolve();
      });

      this._ws.on('message', (data) => {
        this._handleMessage(data);
      });

      this._ws.on('error', (error) => {
        debugLog('WebSocket error:', error);
        clearTimeout(timeout);
        reject(error);
      });

      this._ws.on('close', (code, reason) => {
        debugLog('WebSocket closed:', code, reason.toString());
        this._connected = false;
        this._authenticated = false;

        // Reject all pending requests
        for (const [requestId, { reject, timeoutId }] of this._pendingRequests) {
          clearTimeout(timeoutId);
          reject(new Error('Connection closed'));
        }
        this._pendingRequests.clear();
      });
    });
  }

  /**
   * Handle incoming WebSocket message
   */
  _handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());
      debugLog('Received message:', JSON.stringify(message).substring(0, 200));

      // Handle JSON-RPC responses (has id, no method)
      if (message.id !== undefined && !message.method) {
        this._handleResponse(message);
        return;
      }

      // Handle JSON-RPC notifications (has method, no id)
      if (message.method && message.id === undefined) {
        debugLog('Received notification:', message.method, message.params);
        // Just log notifications, don't respond
        return;
      }

      // Unknown message type
      debugLog('Received unknown message type:', message);
    } catch (error) {
      debugLog('Error parsing message:', error);
    }
  }

  /**
   * Handle JSON-RPC response
   */
  _handleResponse(message) {
    const requestId = message.id;
    const pending = this._pendingRequests.get(requestId);

    if (!pending) {
      debugLog('Received response for unknown request:', requestId);
      return;
    }

    clearTimeout(pending.timeoutId);
    this._pendingRequests.delete(requestId);

    if (message.error) {
      pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    } else {
      pending.resolve(message.result);
    }
  }

  /**
   * Send JSON-RPC request and wait for response
   */
  async sendRequest(method, params, timeout = 30000) {
    if (!this._connected) {
      throw new Error('Not connected');
    }

    const requestId = randomUUID();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this._pendingRequests.delete(requestId);
        reject(new Error(`Request timeout: ${method}`));
      }, timeout);

      this._pendingRequests.set(requestId, { resolve, reject, timeoutId });

      const message = {
        jsonrpc: '2.0',
        id: requestId,
        method,
        params
      };

      debugLog('Sending request:', method, 'id:', requestId);
      this._ws.send(JSON.stringify(message));
    });
  }

  /**
   * Send JSON-RPC notification (no response expected)
   */
  sendNotification(method, params) {
    if (!this._connected) {
      throw new Error('Not connected');
    }

    const message = {
      jsonrpc: '2.0',
      method,
      params
    };

    debugLog('Sending notification:', method);
    this._ws.send(JSON.stringify(message));
  }

  /**
   * Translate MCP tool call to extension command
   * This mimics what BrowserServerBackend does
   */
  _translateToolToCommand(name, args) {
    // Handle browser_tabs tool
    if (name === 'browser_tabs') {
      const action = args.action;

      if (action === 'new') {
        return {
          method: 'createTab',
          params: {
            url: args.url,
            activate: true,
            stealth: args.stealth || false
          }
        };
      } else if (action === 'list') {
        return {
          method: 'getTabs',
          params: {}
        };
      } else if (action === 'close') {
        return {
          method: 'closeTab',
          params: {}
        };
      }
    }

    // For CDP-based tools, keep as-is (they use forwardCDPCommand)
    return {
      method: name,
      params: args
    };
  }

  /**
   * Call a tool (translate MCP tool to extension command)
   */
  async callTool(name, args) {
    if (!this._connected) {
      throw new Error('Not connected');
    }

    if (this.mode === 'proxy' && !this._authenticated) {
      throw new Error('Not authenticated with proxy');
    }

    if (this.mode === 'proxy' && !this._connectionId) {
      throw new Error('Not connected to an extension');
    }

    // Translate MCP tool to extension command
    const command = this._translateToolToCommand(name, args);

    debugLog('Calling tool:', name, '→', command.method);

    // Use longer timeout for tool calls (2 minutes)
    return await this.sendRequest(command.method, command.params, 120000);
  }

  /**
   * Close connection
   */
  async close() {
    debugLog('Closing connection');

    if (this._ws) {
      this._ws.close(1000, 'Normal closure');
      this._ws = null;
    }

    this._connected = false;
    this._authenticated = false;
  }

  /**
   * Get backend capabilities (for MCP server)
   */
  capabilities() {
    return {
      tools: true
    };
  }
}

module.exports = { MCPConnection };
