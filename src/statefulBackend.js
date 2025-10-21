/**
 * Stateful Backend for Extension Mode
 *
 * Manages connection states: passive -> active -> connected
 * - passive: Server ready, no connections, only connection tools available
 * - active: Port 5555 open, waiting for extension (standalone mode)
 * - connected: Extension connected
 *
 * Note: Authenticated mode (connecting to remote proxy) is handled separately
 */

const { OAuth2Client } = require('./oauth');
const { MCPConnection } = require('./mcpConnection');
const { UnifiedBackend } = require('./unifiedBackend');
const { ExtensionServer } = require('./extensionServer');
const { DirectTransport, ProxyTransport } = require('./transport');

// Helper function for debug logging
function debugLog(...args) {
  if (global.DEBUG_MODE) {
    console.error(...args);
  }
}

class StatefulBackend {
  constructor(config) {
    debugLog('[StatefulBackend] Constructor - starting in PASSIVE mode');
    this._config = config;
    this._state = 'passive'; // 'passive', 'active', 'connected'
    this._activeBackend = null;
    this._extensionServer = null; // Our WebSocket server for extension
    this._proxyConnection = null; // MCPConnection for proxy mode
    this._debugMode = config.debug || false;
    this._isAuthenticated = false; // Will be set based on stored tokens in initialize()
    this._userInfo = null; // Will contain {isPro, email} after authentication
    this._oauthClient = new OAuth2Client({
      authBaseUrl: process.env.AUTH_BASE_URL || 'https://mcp-for-chrome.railsblueprint.com'
    });
  }

  async initialize(server, clientInfo) {
    debugLog('[StatefulBackend] Initialize called - staying in passive mode');
    this._server = server;
    this._clientInfo = clientInfo;

    // Check for stored authentication tokens (async, in background)
    // Store promise so tools can await it before checking auth status
    this._authCheckPromise = this._oauthClient.isAuthenticated().then(isAuth => {
      this._isAuthenticated = isAuth;
      if (isAuth) {
        debugLog('[StatefulBackend] Found stored authentication tokens');
        return this._oauthClient.getUserInfo();
      }
      return null;
    }).then(userInfo => {
      if (userInfo) {
        this._userInfo = userInfo;
        debugLog('[StatefulBackend] User authenticated:', this._userInfo);
      } else if (this._isAuthenticated) {
        debugLog('[StatefulBackend] Failed to decode token, clearing auth state');
        this._isAuthenticated = false;
        this._oauthClient.clearTokens().catch(err => debugLog('[StatefulBackend] Error clearing tokens:', err));
      }
    }).catch(error => {
      debugLog('[StatefulBackend] Error checking authentication (non-fatal):', error);
      this._isAuthenticated = false;
    });

    // Don't initialize tools backend here - it will be lazy-initialized in listTools()
    debugLog('[StatefulBackend] Initialize complete (tools backend will be lazy-loaded)');
  }

  /**
   * Ensure auth check has completed before proceeding
   * Tools that need auth status should call this first
   */
  async _ensureAuthChecked() {
    if (this._authCheckPromise) {
      await this._authCheckPromise;
    }
  }

  async listTools() {
    debugLog(`[StatefulBackend] listTools() - state: ${this._state}, authenticated: ${this._isAuthenticated}, debug: ${this._debugMode}`);

    // Always return connection management tools
    const connectionTools = [
      {
        name: 'connect',
        description: 'Activate browser automation by connecting to the Chrome extension. Must be called before using any browser_ tools. After connecting, use browser_tabs to select or create tabs.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        },
        annotations: {
          title: 'Connect to browser',
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false
        }
      },
      {
        name: 'disconnect',
        description: 'Stop browser automation and close the connection to the Chrome extension. Returns server to passive mode where browser_ tools are unavailable.',
        inputSchema: { type: 'object', properties: {}, required: [] },
        annotations: {
          title: 'Disconnect from browser',
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false
        }
      },
      {
        name: 'status',
        description: 'Check whether browser automation is currently active or passive. Shows if connect has been called and browser_ tools are available.',
        inputSchema: { type: 'object', properties: {}, required: [] },
        annotations: {
          title: 'Connection status',
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false
        }
      },
      {
        name: 'auth',
        description: 'Manage Blueprint MCP PRO authentication. Login to access unlimited browser tabs, logout to clear credentials, or check current authentication status.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['login', 'logout', 'status'],
              description: 'Action to perform: login (authenticate and get PRO access), logout (clear tokens), status (check current auth state)'
            }
          },
          required: ['action']
        },
        annotations: {
          title: 'Manage authentication',
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false
        }
      }
    ];

    // Get browser tools from UnifiedBackend (with null transport, just for schemas)
    const dummyBackend = new UnifiedBackend(this._config, null);
    const browserTools = await dummyBackend.listTools();

    debugLog(`[StatefulBackend] Returning ${connectionTools.length} connection tools + ${browserTools.length} browser tools`);

    return [...connectionTools, ...browserTools];
  }

  async callTool(name, rawArguments) {
    debugLog(`[StatefulBackend] callTool(${name}) - state: ${this._state}`);

    // Handle connection management tools
    switch (name) {
      case 'connect':
        return await this._handleConnect(rawArguments);

      case 'disconnect':
        return await this._handleDisconnect();

      case 'status':
        return await this._handleStatus();

      case 'auth':
        return await this._handleAuth(rawArguments);
    }

    // Forward to active backend
    if (!this._activeBackend) {
      return {
        content: [{
          type: 'text',
          text: `### Not Connected\n\nPlease call 'connect' first to start browser automation.`
        }],
        isError: true
      };
    }

    return await this._activeBackend.callTool(name, rawArguments);
  }

  async _handleConnect(args = {}) {
    if (this._state !== 'passive') {
      return {
        content: [{
          type: 'text',
          text: `### Already Connected\nCurrent state: ${this._state}\n\nUse disconnect first to return to passive mode.`
        }]
      };
    }

    // Wait for auth check to complete before deciding connection mode
    await this._ensureAuthChecked();

    debugLog('[StatefulBackend] Attempting to connect...');

    // Choose mode based on authentication
    if (this._isAuthenticated && this._userInfo?.connectionUrl) {
      debugLog('[StatefulBackend] Starting authenticated proxy mode');
      return await this._connectToProxy();
    } else {
      debugLog('[StatefulBackend] Starting standalone mode');
      return await this._becomePrimary();
    }
  }

  async _becomePrimary() {
    try {
      debugLog('[StatefulBackend] Starting extension server...');

      // Create our WebSocket server for extension connection
      this._extensionServer = new ExtensionServer(5555, '127.0.0.1');
      await this._extensionServer.start();

      // Create transport using the extension server
      const transport = new DirectTransport(this._extensionServer);

      // Create unified backend
      this._activeBackend = new UnifiedBackend(this._config, transport);
      await this._activeBackend.initialize(this._server, this._clientInfo);

      this._state = 'active';

      debugLog('[StatefulBackend] Standalone mode activated');

      // Notify client that tool list has changed (don't await - send async)
      this._notifyToolsListChanged().catch(err =>
        debugLog('[StatefulBackend] Error sending notification:', err)
      );

      return {
        content: [{
          type: 'text',
          text: `### ✅ Connected Successfully!\n\n` +
                `You can now use browser automation tools.\n\n` +
                `Use browser_tabs to connect to existing tabs or create new ones. Stealth mode can be enabled per-tab to avoid bot detection.`
        }]
      };
    } catch (error) {
      debugLog('[StatefulBackend] Failed to start standalone mode:', error);
      this._activeBackend = null;
      this._state = 'passive';

      // Check if it's a port binding error
      const isPortError = error.message && (
        error.message.includes('EADDRINUSE') ||
        error.message.includes('address already in use') ||
        error.message.includes('port 5555')
      );

      const errorMsg = isPortError
        ? `### Connection Failed\n\nPort 5555 is already in use by another application.\n\nPlease close the other application using port 5555 and try again.`
        : `### Connection Failed\n\nFailed to start server:\n${error.message}`;

      return {
        content: [{
          type: 'text',
          text: errorMsg
        }],
        isError: true
      };
    }
  }

  async _connectToProxy() {
    try {
      debugLog('[StatefulBackend] Connecting to remote proxy:', this._userInfo.connectionUrl);

      // Get stored tokens for authentication
      const tokens = await this._oauthClient.getStoredTokens();
      if (!tokens || !tokens.accessToken) {
        throw new Error('No access token found - please authenticate first');
      }

      // Create MCPConnection in proxy mode
      const mcpConnection = new MCPConnection({
        mode: 'proxy',
        url: this._userInfo.connectionUrl,
        accessToken: tokens.accessToken
      });

      // Connect (handles authentication, listing extensions, and connecting to first one)
      await mcpConnection.connect();

      // Monitor connection close events
      mcpConnection.onClose = (code, reason) => {
        debugLog('[StatefulBackend] Connection closed:', code, reason);
        console.error('[StatefulBackend] ⚠️  Connection lost - resetting to passive state');
        this._state = 'passive';
        this._activeBackend = null;
        this._proxyConnection = null;
      };

      // Create ProxyTransport using the MCPConnection
      const transport = new ProxyTransport(mcpConnection);

      // Create unified backend
      this._activeBackend = new UnifiedBackend(this._config, transport);
      await this._activeBackend.initialize(this._server, this._clientInfo);

      this._proxyConnection = mcpConnection;
      this._state = 'connected';

      debugLog('[StatefulBackend] Successfully connected to proxy and extension');

      return {
        content: [{
          type: 'text',
          text: `### ✅ Connected to Proxy\n\n` +
                `**Email:** ${this._userInfo.email}\n` +
                `**Proxy:** ${this._userInfo.connectionUrl}\n\n` +
                `Your Chrome browser is now accessible via the remote proxy. You can use all MCP tools.`
        }]
      };
    } catch (error) {
      debugLog('[StatefulBackend] Failed to connect to proxy:', error);

      return {
        content: [{
          type: 'text',
          text: `### Connection Failed\n\nFailed to connect to remote proxy:\n${error.message}`
        }],
        isError: true
      };
    }
  }

  async _handleDisconnect() {
    if (this._state === 'passive') {
      return {
        content: [{
          type: 'text',
          text: `### Already Disconnected\n\nCurrent state: passive`
        }]
      };
    }

    debugLog('[StatefulBackend] Disconnecting...');

    if (this._activeBackend) {
      this._activeBackend.serverClosed();
      this._activeBackend = null;
    }

    // Close proxy connection if we're in proxy mode
    if (this._proxyConnection) {
      await this._proxyConnection.close();
      this._proxyConnection = null;
    }

    // Stop extension server if in direct mode
    if (this._extensionServer) {
      debugLog('[StatefulBackend] Stopping ExtensionServer...');
      await this._extensionServer.stop();
      this._extensionServer = null;
      debugLog('[StatefulBackend] ExtensionServer stopped, port 5555 closed');
    }

    this._state = 'passive';

    // Notify client that tool list has changed (back to connection tools only, don't await - send async)
    this._notifyToolsListChanged().catch(err =>
      debugLog('[StatefulBackend] Error sending notification:', err)
    );

    return {
      content: [{
        type: 'text',
        text: `### Disconnected\n\nState: passive\n\nUse connect to reconnect.`
      }]
    };
  }

  async _handleStatus() {
    if (this._state === 'passive') {
      return {
        content: [{
          type: 'text',
          text: `### ❌ Not Connected\n\nUse the \`connect\` tool to start browser automation.`
        }]
      };
    }

    return {
      content: [{
        type: 'text',
        text: `### ✅ Connected\n\nBrowser automation is ready!\n\nUse browser_tabs to connect to existing tabs or create new ones with optional stealth mode.`
      }]
    };
  }

  async _notifyToolsListChanged() {
    if (!this._server) {
      debugLog('[StatefulBackend] Cannot send notification - no server reference');
      return;
    }

    try {
      debugLog('[StatefulBackend] Sending notifications/tools/list_changed');
      // Use the official MCP SDK helper method
      await this._server.sendToolListChanged();
      debugLog('[StatefulBackend] Notification sent successfully');
    } catch (error) {
      debugLog('[StatefulBackend] Failed to send tool list changed notification:', error);
    }
  }

  async _handleAuth(args) {
    const action = args?.action;

    if (!action) {
      return {
        content: [{
          type: 'text',
          text: `### Error\n\nMissing required 'action' parameter.\n\nValid actions: login, logout, status`
        }],
        isError: true
      };
    }

    switch (action) {
      case 'login':
        return await this._handleLogin();
      case 'logout':
        return await this._handleLogout();
      case 'status':
        return await this._handleAuthStatus();
      default:
        return {
          content: [{
            type: 'text',
            text: `### Error\n\nInvalid action: ${action}\n\nValid actions: login, logout, status`
          }],
          isError: true
        };
    }
  }

  async _handleLogin() {
    debugLog('[StatefulBackend] Handling login...');

    if (this._isAuthenticated) {
      return {
        content: [{
          type: 'text',
          text: `### Already Authenticated\n\nYou are already logged in as: ${this._userInfo?.email || 'Unknown'}\n\nUse auth action='logout' to sign out and authenticate with a different account.`
        }]
      };
    }

    try {
      debugLog('[StatefulBackend] Starting OAuth flow...');

      const tokens = await this._oauthClient.authenticate();

      debugLog('[StatefulBackend] Authentication successful, decoding token...');

      // Decode token and get user info
      this._userInfo = await this._oauthClient.getUserInfo();

      if (!this._userInfo) {
        debugLog('[StatefulBackend] Failed to decode token');
        await this._oauthClient.clearTokens();

        return {
          content: [{
            type: 'text',
            text: `### Authentication Failed\n\nFailed to decode authentication token. Please try again.`
          }],
          isError: true
        };
      }

      this._isAuthenticated = true;

      debugLog('[StatefulBackend] Authentication complete:', this._userInfo);

      return {
        content: [{
          type: 'text',
          text: `### ✅ Authentication Successful!\n\n` +
                `**Email:** ${this._userInfo.email}\n` +
                `**Status:** ✅ PRO Account\n\n` +
                `You now have access to PRO features including unlimited browser tabs!`
        }]
      };
    } catch (error) {
      debugLog('[StatefulBackend] Authentication error:', error);

      return {
        content: [{
          type: 'text',
          text: `### Authentication Failed\n\n${error.message}\n\nPlease try again or contact support if the problem persists.`
        }],
        isError: true
      };
    }
  }

  async _handleLogout() {
    debugLog('[StatefulBackend] Handling logout...');

    if (!this._isAuthenticated) {
      return {
        content: [{
          type: 'text',
          text: `### Not Authenticated\n\nYou are not currently logged in.\n\nUse auth action='login' to sign in.`
        }]
      };
    }

    try {
      await this._oauthClient.clearTokens();
      this._isAuthenticated = false;
      this._userInfo = null;

      debugLog('[StatefulBackend] Logout successful');

      return {
        content: [{
          type: 'text',
          text: `### ✅ Logged Out\n\nYou have been successfully logged out.\n\nUse auth action='login' to sign in again.`
        }]
      };
    } catch (error) {
      debugLog('[StatefulBackend] Logout error:', error);

      return {
        content: [{
          type: 'text',
          text: `### Logout Failed\n\n${error.message}`
        }],
        isError: true
      };
    }
  }

  async _handleAuthStatus() {
    debugLog('[StatefulBackend] Handling auth status...');

    // Wait for auth check to complete before returning status
    await this._ensureAuthChecked();

    if (!this._isAuthenticated || !this._userInfo) {
      return {
        content: [{
          type: 'text',
          text: `### ❌ Not Authenticated\n\nYou are not currently logged in.\n\nUse auth action='login' to sign in with your Blueprint MCP PRO account.`
        }]
      };
    }

    return {
      content: [{
        type: 'text',
        text: `### Authentication Status\n\n` +
              `**Email:** ${this._userInfo.email}\n` +
              `**Status:** ✅ PRO Account\n\n` +
              `You have access to all PRO features including unlimited browser tabs!`
      }]
    };
  }

  async serverClosed() {
    debugLog('[StatefulBackend] Server closing...');
    if (this._activeBackend) {
      this._activeBackend.serverClosed();
    }
    if (this._extensionServer) {
      await this._extensionServer.stop();
    }
    if (this._proxyConnection) {
      await this._proxyConnection.close();
    }
  }
}

module.exports = { StatefulBackend };
