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

const path = require('path');
const { BrowserServerBackend } = require(path.join(__dirname, '../node_modules/playwright/lib/mcp/browser/browserServerBackend'));
const { PrimaryServer } = require('./primaryServer');
const { OAuth2Client } = require('./oauth');

// Helper function for debug logging
function debugLog(...args) {
  if (global.DEBUG_MODE) {
    console.error(...args);
  }
}

class StatefulBackend {
  constructor(config, extensionContextFactory) {
    debugLog('[StatefulBackend] Constructor - starting in PASSIVE mode');
    this._config = config;
    this._extensionContextFactory = extensionContextFactory;
    this._state = 'passive'; // 'passive', 'active', 'connected'
    this._activeBackend = null;
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

    // Check for stored authentication tokens
    this._isAuthenticated = await this._oauthClient.isAuthenticated();
    if (this._isAuthenticated) {
      debugLog('[StatefulBackend] Found stored authentication tokens');
      // Verify tokens and get user info
      this._userInfo = await this._oauthClient.verifyTokens();
      if (!this._userInfo) {
        debugLog('[StatefulBackend] Token verification failed, clearing auth state');
        this._isAuthenticated = false;
        await this._oauthClient.clearTokens();
      } else {
        debugLog('[StatefulBackend] User authenticated:', this._userInfo);
      }
    }

    // Initialize a backend instance to get browser tools (but don't connect yet)
    debugLog('[StatefulBackend] About to initialize tools backend...');
    const path = require('path');
    const { BrowserServerBackend } = require(path.join(__dirname, '../node_modules/playwright/lib/mcp/browser/browserServerBackend'));
    debugLog('[StatefulBackend] BrowserServerBackend loaded, creating instance...');
    this._toolsBackend = new BrowserServerBackend(this._config, this._extensionContextFactory);
    debugLog('[StatefulBackend] BrowserServerBackend instance created, initializing...');
    await this._toolsBackend.initialize(server, clientInfo);
    debugLog('[StatefulBackend] Tools backend initialized successfully!');
  }

  async listTools() {
    debugLog(`[StatefulBackend] listTools() - state: ${this._state}, authenticated: ${this._isAuthenticated}, debug: ${this._debugMode}`);

    // Always return connection management tools
    const connectionTools = [
      {
        name: 'connect',
        description: 'Connect to browser extension to enable browser automation. Use browser_tabs to connect to existing tabs or create new ones with optional stealth mode.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      {
        name: 'disconnect',
        description: 'Disconnect from browser and return to passive mode.',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'status',
        description: 'Get current connection status and mode.',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'auth',
        description: 'Manage authentication with Blueprint MCP PRO account. Use action parameter to login, logout, or check status.',
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
        }
      }
    ];

    // Lazy initialize tools backend if not already done
    // This is needed because initialize() is only called on first tool invocation
    if (!this._toolsBackend) {
      debugLog('[StatefulBackend] Tools backend not yet initialized, creating now...');
      const path = require('path');
      const { BrowserServerBackend } = require(path.join(__dirname, '../node_modules/playwright/lib/mcp/browser/browserServerBackend'));
      this._toolsBackend = new BrowserServerBackend(this._config, this._extensionContextFactory);
      // Note: BrowserServerBackend.listTools() doesn't need initialize() to be called
      // The tools are set in the constructor from filteredTools(config)
      debugLog('[StatefulBackend] Tools backend created');
    }

    // Always return browser tools (even in passive mode) to avoid context overhead
    let browserTools = [];
    try {
      browserTools = await this._toolsBackend.listTools();

      // Filter debug-only tools if not in debug mode
      // Note: Extension tools (reload/list) are kept visible as they're useful for debugging ANY extension
      if (!this._debugMode) {
        browserTools = browserTools.filter(tool =>
          tool.name !== 'mcp_reload_server' &&
          tool.name !== 'browser_install'
        );
      }

      debugLog(`[StatefulBackend] Returning ${browserTools.length} browser tools (filtered: ${!this._debugMode})`);
    } catch (error) {
      debugLog('[StatefulBackend] Error getting browser tools:', error);
    }

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

    // For browser tools, use active backend if connected, otherwise use tools backend
    const backend = this._activeBackend || this._toolsBackend;

    if (!backend) {
      return {
        content: [{
          type: 'text',
          text: `### Error\nBackend not initialized. State: ${this._state}`
        }],
        isError: true
      };
    }

    // Forward to backend (active or tools)
    return await backend.callTool(name, rawArguments);
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

    debugLog('[StatefulBackend] Attempting to connect...');

    // For now, only support standalone mode
    // TODO: Add authenticated remote proxy mode when OAuth2 is implemented
    if (this._isAuthenticated) {
      return {
        content: [{
          type: 'text',
          text: `### Authentication Detected\n\nAuthenticated remote proxy mode is not yet implemented.\nPlease connect without authentication for standalone mode.`
        }],
        isError: true
      };
    }

    debugLog('[StatefulBackend] Starting standalone mode');
    return await this._becomePrimary();
  }

  async _becomePrimary() {
    try {
      debugLog('[StatefulBackend] Creating PrimaryServer...');

      this._activeBackend = new PrimaryServer(this._config, this._extensionContextFactory);
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

    // Stop the CDPRelayServer to actually close port 5555
    const cdpRelayServer = this._extensionContextFactory.getCdpRelayServer();
    if (cdpRelayServer) {
      debugLog('[StatefulBackend] Stopping CDPRelayServer...');
      cdpRelayServer.stop();
      // Clear the relay promise and server reference so a new one is created on next connect
      this._extensionContextFactory._relayPromise = null;
      this._extensionContextFactory._cdpRelayServer = null;
      debugLog('[StatefulBackend] CDPRelayServer stopped, port 5555 closed');
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

      debugLog('[StatefulBackend] Authentication successful, verifying tokens...');

      // Verify tokens and get user info
      this._userInfo = await this._oauthClient.verifyTokens();

      if (!this._userInfo) {
        debugLog('[StatefulBackend] Token verification failed');
        await this._oauthClient.clearTokens();

        return {
          content: [{
            type: 'text',
            text: `### Authentication Failed\n\nFailed to verify authentication tokens. Please try again.`
          }],
          isError: true
        };
      }

      this._isAuthenticated = true;

      debugLog('[StatefulBackend] Authentication complete:', this._userInfo);

      const proStatus = this._userInfo.isPro ? '✅ PRO Account' : '❌ Free Account';

      return {
        content: [{
          type: 'text',
          text: `### ✅ Authentication Successful!\n\n` +
                `**Email:** ${this._userInfo.email}\n` +
                `**Status:** ${proStatus}\n\n` +
                `${this._userInfo.isPro ? 'You now have access to PRO features!' : 'Upgrade to PRO to unlock advanced features.'}`
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

    if (!this._isAuthenticated || !this._userInfo) {
      return {
        content: [{
          type: 'text',
          text: `### ❌ Not Authenticated\n\nYou are not currently logged in.\n\nUse auth action='login' to sign in with your Blueprint MCP PRO account.`
        }]
      };
    }

    const proStatus = this._userInfo.isPro ? '✅ PRO Account' : '❌ Free Account';

    return {
      content: [{
        type: 'text',
        text: `### Authentication Status\n\n` +
              `**Email:** ${this._userInfo.email}\n` +
              `**Status:** ${proStatus}\n\n` +
              `${this._userInfo.isPro ? 'You have access to all PRO features!' : 'Upgrade to PRO to unlock advanced features.'}`
      }]
    };
  }

  serverClosed() {
    debugLog('[StatefulBackend] Server closing...');
    if (this._activeBackend) {
      this._activeBackend.serverClosed();
    }
    if (this._toolsBackend) {
      this._toolsBackend.serverClosed();
    }
  }
}

module.exports = { StatefulBackend };
