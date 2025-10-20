/**
 * Proxy Client Backend
 *
 * Connects to a remote WebSocket proxy server instead of managing
 * the browser connection locally. Used when user is authenticated
 * with a PRO account that has a connection_url.
 *
 * Flow:
 * 1. Connect to proxy WebSocket (e.g., wss://mcp-for-chrome.railsblueprint.com/mcp)
 * 2. Send mcp_client_handshake with access token
 * 3. Forward tool calls to proxy
 * 4. Receive responses from extension via proxy
 */

const WebSocket = require('ws');
const { randomUUID } = require('crypto');

// Helper function for debug logging
function debugLog(...args) {
  if (global.DEBUG_MODE) {
    console.error('[ProxyClient]', ...args);
  }
}

class ProxyClientBackend {
  constructor(proxyUrl, accessToken) {
    this._proxyUrl = proxyUrl;
    this._accessToken = accessToken;
    this._ws = null;
    this._connected = false;
    this._authenticated = false;
    this._connectionId = null; // Connection ID from proxy after connecting to extension
    this._pendingRequests = new Map(); // requestId -> { resolve, reject, timeoutId }
    this._clientId = randomUUID();
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 3;
  }

  /**
   * Initialize connection to proxy
   */
  async initialize(server, clientInfo) {
    debugLog('Initializing proxy client connection...');
    debugLog('Proxy URL:', this._proxyUrl);
    debugLog('Client ID:', this._clientId);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout - proxy did not respond'));
      }, 30000); // 30 second timeout

      this._ws = new WebSocket(this._proxyUrl);

      this._ws.on('open', () => {
        debugLog('WebSocket connected to proxy');
        this._connected = true;
        this._sendHandshake();
      });

      this._ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          debugLog('Received message:', JSON.stringify(message).substring(0, 100));

          // Handle handshake confirmation (JSON-RPC style)
          if (message.method === 'handshake_ack') {
            debugLog('Handshake acknowledged, authenticated successfully');
            this._authenticated = true;
            clearTimeout(timeout);
            resolve();
            return;
          }

          // Handle status messages (legacy type field - can be removed later)
          if (message.type === 'status') {
            debugLog('Status update:', message.data);
            return;
          }

          // Handle error messages (legacy type field - can be removed later)
          if (message.type === 'error') {
            debugLog('Error from proxy:', message.error);
            if (!this._authenticated) {
              clearTimeout(timeout);
              reject(new Error(`Proxy error: ${message.error}`));
            }
            return;
          }

          // Handle tool response with id (standard JSON-RPC)
          if (message.id && !message.method) {
            this._handleResponse(message);
            return;
          }

          // Handle direct responses without id (proxy doesn't wrap responses)
          // Match by response structure to the oldest pending request
          if (!message.id && !message.method && !message.type) {
            // This is a direct response, match it to oldest pending request
            const oldestRequest = Array.from(this._pendingRequests.entries())[0];
            if (oldestRequest) {
              const [requestId, pending] = oldestRequest;
              debugLog('Matching direct response to request:', requestId);
              clearTimeout(pending.timeoutId);
              this._pendingRequests.delete(requestId);
              pending.resolve(message);
            } else {
              debugLog('Received direct response but no pending requests');
            }
            return;
          }
        } catch (error) {
          debugLog('Error parsing message:', error);
        }
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
   * Send handshake message with authentication
   */
  _sendHandshake() {
    debugLog('Sending MCP client handshake...');

    const handshake = {
      method: 'mcp_handshake',
      params: {
        accessToken: this._accessToken
      }
    };

    this._ws.send(JSON.stringify(handshake));
  }

  /**
   * Handle response from proxy
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
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.result);
    }
  }

  /**
   * List available extensions connected to the proxy
   */
  async listExtensions() {
    if (!this._connected || !this._authenticated) {
      throw new Error('Not connected to proxy');
    }

    return new Promise((resolve, reject) => {
      const requestId = randomUUID();

      const timeoutId = setTimeout(() => {
        this._pendingRequests.delete(requestId);
        reject(new Error('List extensions timeout'));
      }, 30000); // 30 second timeout

      this._pendingRequests.set(requestId, { resolve, reject, timeoutId });

      const message = {
        id: requestId,
        method: 'list_extensions',
        params: {}
      };

      debugLog('Listing extensions with request ID:', requestId);
      this._ws.send(JSON.stringify(message));
    });
  }

  /**
   * Connect to a specific extension
   * @param {string} extensionId - The extension ID to connect to
   */
  async connectToExtension(extensionId) {
    if (!this._connected || !this._authenticated) {
      throw new Error('Not connected to proxy');
    }

    return new Promise((resolve, reject) => {
      const requestId = randomUUID();

      const timeoutId = setTimeout(() => {
        this._pendingRequests.delete(requestId);
        reject(new Error('Connect to extension timeout'));
      }, 30000); // 30 second timeout

      this._pendingRequests.set(requestId, { resolve, reject, timeoutId });

      const message = {
        id: requestId,
        method: 'connect',
        params: {
          extensionId: extensionId
        }
      };

      debugLog('Connecting to extension:', extensionId, 'with request ID:', requestId);
      this._ws.send(JSON.stringify(message));
    }).then(result => {
      // Store connectionId from response
      if (result && result.connectionId) {
        this._connectionId = result.connectionId;
        debugLog('Connected! Connection ID:', this._connectionId);
      }
      return result;
    });
  }

  /**
   * Translate MCP tool call to extension command
   * This mimics what BrowserServerBackend does in standalone mode
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
   * Call a tool via the proxy
   */
  async callTool(name, args) {
    if (!this._connected || !this._authenticated) {
      throw new Error('Not connected to proxy');
    }

    if (!this._connectionId) {
      throw new Error('Not connected to an extension. Call connectToExtension() first.');
    }

    // Translate MCP tool to extension command
    const command = this._translateToolToCommand(name, args);

    return new Promise((resolve, reject) => {
      const requestId = randomUUID();

      const timeoutId = setTimeout(() => {
        this._pendingRequests.delete(requestId);
        reject(new Error('Tool call timeout'));
      }, 120000); // 2 minute timeout for tool calls

      this._pendingRequests.set(requestId, { resolve, reject, timeoutId });

      const message = {
        id: requestId,
        method: command.method,
        params: command.params,
        connectionId: this._connectionId  // Add connectionId for routing
      };

      debugLog('Calling tool:', name, '-> command:', command.method, 'with request ID:', requestId, 'connectionId:', this._connectionId);
      this._ws.send(JSON.stringify(message));
    });
  }

  /**
   * Close connection to proxy
   */
  async close() {
    debugLog('Closing proxy client connection');

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

module.exports = { ProxyClientBackend };
