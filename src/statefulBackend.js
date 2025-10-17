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
    this._isAuthenticated = false; // Will be set based on clientInfo in initialize()
  }

  async initialize(server, clientInfo) {
    debugLog('[StatefulBackend] Initialize called - staying in passive mode');
    this._server = server;
    this._clientInfo = clientInfo;

    // Check if client provided authentication (for remote proxy mode)
    // TODO: Implement authentication check when OAuth2 is added
    this._isAuthenticated = false;

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
