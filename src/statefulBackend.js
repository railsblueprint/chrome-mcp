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
    this._state = 'passive'; // 'passive', 'active', 'connected', 'authenticated_waiting'
    this._activeBackend = null;
    this._extensionServer = null; // Our WebSocket server for extension
    this._proxyConnection = null; // MCPConnection for proxy mode
    this._debugMode = config.debug || false;
    this._isAuthenticated = false; // Will be set based on stored tokens in initialize()
    this._userInfo = null; // Will contain {isPro, email} after authentication
    this._clientId = null; // Human-readable identifier from enable command
    this._availableBrowsers = null; // Cached list of available browsers from proxy (when multiple found)
    this._connectedBrowserName = null; // Name of currently connected browser
    this._attachedTab = null; // Currently attached tab {index, title, url}
    this._browserDisconnected = false; // Track if browser extension disconnected (proxy still connected)
    this._lastConnectedBrowserId = null; // Remember browser ID for auto-reconnect
    this._lastAttachedTab = null; // Remember last attached tab for auto-reattach
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

  /**
   * Generate status header for all responses (1-liner)
   */
  _getStatusHeader() {
    const parts = [];

    // State
    if (this._state === 'passive') {
      return '🔴 Disabled\n---\n\n';
    }

    if (this._state === 'authenticated_waiting') {
      return '⏳ Waiting for browser selection\n---\n\n';
    }

    // Mode
    const mode = this._isAuthenticated ? 'PRO' : 'Free';
    const version = require('../package.json').version;
    parts.push(`✅ ${mode} v${version}`);

    // Browser - show disconnected status if browser disconnected
    if (this._browserDisconnected) {
      parts.push(`⚠️ Browser Disconnected`);
    } else if (this._connectedBrowserName) {
      parts.push(`🌐 ${this._connectedBrowserName}`);
    }

    // Tab - only show if browser not disconnected
    if (!this._browserDisconnected) {
      if (this._attachedTab) {
        const tabTitle = this._attachedTab.title || 'Untitled';
        const shortTitle = tabTitle.length > 40 ? tabTitle.substring(0, 37) + '...' : tabTitle;
        parts.push(`📄 Tab ${this._attachedTab.index}: ${shortTitle}`);
      } else {
        parts.push(`⚠️ No tab attached`);
      }
    }

    return parts.join(' | ') + '\n---\n\n';
  }

  async listTools() {
    debugLog(`[StatefulBackend] listTools() - state: ${this._state}, authenticated: ${this._isAuthenticated}, debug: ${this._debugMode}`);

    // Always return connection management tools
    const connectionTools = [
      {
        name: 'enable',
        description: 'STEP 1: Enable browser automation. Activates the Chrome extension connection and makes browser_ tools available. Provide a client_id (e.g., your project name) for stable connection tracking. In PRO mode with multiple browsers, this will return a list to choose from.',
        inputSchema: {
          type: 'object',
          properties: {
            client_id: {
              type: 'string',
              description: 'Human-readable identifier for this MCP client (e.g., "my-project", "task-automation"). Used for stable connection IDs and reconnection after restarts.'
            }
          },
          required: ['client_id']
        },
        annotations: {
          title: 'Enable browser automation',
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false
        }
      },
      {
        name: 'disable',
        description: 'Disable browser automation and return to passive mode. Closes Chrome extension connection. After this, browser_ tools will not work until you call enable again.',
        inputSchema: { type: 'object', properties: {}, required: [] },
        annotations: {
          title: 'Disable browser automation',
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false
        }
      },
      {
        name: 'browser_connect',
        description: 'Connect to a specific browser when multiple browsers are available (PRO mode only). Called after enable returns a list of browsers to choose from.',
        inputSchema: {
          type: 'object',
          properties: {
            browser_id: {
              type: 'string',
              description: 'Browser extension ID from the list returned by enable'
            }
          },
          required: ['browser_id']
        },
        annotations: {
          title: 'Connect to browser',
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false
        }
      },
      {
        name: 'status',
        description: 'Check current state: passive (not connected) or active/connected (browser automation enabled). Use this to verify connection status before calling browser_ tools.',
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
      case 'enable':
        return await this._handleEnable(rawArguments);

      case 'disable':
        return await this._handleDisable();

      case 'browser_connect':
        return await this._handleBrowserConnect(rawArguments);

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
          text: `### ⚠️ Browser Automation Not Active\n\n**Current State:** Passive (disabled)\n\n**You must call \`enable\` first to activate browser automation.**\n\nAfter enabling:\n1. Browser automation will be active\n2. Then use \`browser_tabs\` to select or create a tab\n3. Then you can use other browser tools (navigate, interact, etc.)`
        }],
        isError: true
      };
    }

    return await this._activeBackend.callTool(name, rawArguments);
  }

  async _handleEnable(args = {}) {
    // Validate client_id parameter
    if (!args.client_id || typeof args.client_id !== 'string' || args.client_id.trim().length === 0) {
      return {
        content: [{
          type: 'text',
          text: `### ⚠️ Missing Required Parameter\n\n**Error:** \`client_id\` parameter is required\n\n**Example:**\n\`\`\`\nenable client_id='my-project'\n\`\`\`\n\nProvide a human-readable identifier (e.g., your project name). This enables stable connection IDs and seamless reconnection after restarts.`
        }],
        isError: true
      };
    }

    if (this._state !== 'passive') {
      return {
        content: [{
          type: 'text',
          text: `### ✅ Already Enabled\n\n**Current State:** ${this._state}\n**Client ID:** ${this._clientId || 'unknown'}\n\n**Browser automation is already active!**\n\nYou can now use browser tools:\n- \`browser_tabs\` - List, select, or create tabs\n- \`browser_navigate\` - Navigate to URLs\n- \`browser_interact\` - Click, type, etc.\n- And more...\n\nTo restart, call \`disable\` first.`
        }]
      };
    }

    // Store client_id for this session
    this._clientId = args.client_id.trim();
    debugLog('[StatefulBackend] Client ID set to:', this._clientId);

    // Wait for auth check to complete before deciding connection mode
    await this._ensureAuthChecked();

    debugLog('[StatefulBackend] Attempting to connect...');

    // Check if user has invalid token (authenticated but missing connectionUrl)
    if (this._isAuthenticated && !this._userInfo?.connectionUrl) {
      debugLog('[StatefulBackend] Invalid token: missing connection_url');
      return {
        content: [{
          type: 'text',
          text: `### ❌ Invalid Authentication Token\n\n` +
                `Your authentication token is missing required information (connection_url).\n\n` +
                `**This can happen if:**\n` +
                `- The relay server was updated and token format changed\n` +
                `- The token was corrupted\n\n` +
                `**Please choose one option:**\n\n` +
                `1. **Continue in free mode (standalone):**\n` +
                `   Use the auth tool to logout:\n` +
                `   \`\`\`\n   auth action='logout'\n   \`\`\`\n` +
                `   Then connect again - you'll use local browser only (port 5555)\n\n` +
                `2. **Login again for relay access:**\n` +
                `   First logout, then login:\n` +
                `   \`\`\`\n   auth action='logout'\n   auth action='login'\n   \`\`\`\n` +
                `   Then connect - you'll get a fresh token with relay access`
        }],
        isError: true
      };
    }

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

      // Handle extension reconnections (e.g., after extension reload)
      this._extensionServer.onReconnect = () => {
        debugLog('[StatefulBackend] Extension reconnected, resetting attached tab state...');
        this._attachedTab = null; // Clear attached tab since extension reloaded
        // Keep the same state and backend since the server connection is still valid
      };

      // Monitor tab info updates (keep _attachedTab in sync with actual browser state)
      this._extensionServer.onTabInfoUpdate = (tabInfo) => {
        debugLog('[StatefulBackend] Tab info update:', tabInfo);

        // If tabInfo is null, clear the attached tab (tab was closed/detached)
        if (tabInfo === null) {
          debugLog('[StatefulBackend] Tab detached, clearing cached state');
          this._attachedTab = null;
          return;
        }

        // Update cached tab info with fresh data from browser
        if (this._attachedTab && this._attachedTab.id === tabInfo.id) {
          this._attachedTab = {
            ...this._attachedTab,
            title: tabInfo.title,
            url: tabInfo.url,
            index: tabInfo.index
          };
          debugLog('[StatefulBackend] Updated cached tab info:', this._attachedTab);
        }
      };

      // Create transport using the extension server
      const transport = new DirectTransport(this._extensionServer);

      // Create unified backend
      this._activeBackend = new UnifiedBackend(this._config, transport);
      await this._activeBackend.initialize(this._server, this._clientInfo, this);

      this._state = 'active';
      this._connectedBrowserName = 'Local Chrome';  // Store browser name for standalone mode

      debugLog('[StatefulBackend] Standalone mode activated');

      // Notify client that tool list has changed (don't await - send async)
      this._notifyToolsListChanged().catch(err =>
        debugLog('[StatefulBackend] Error sending notification:', err)
      );

      return {
        content: [{
          type: 'text',
          text: this._getStatusHeader() +
                `### ✅ Browser Automation Activated!\n\n` +
                `**State:** Connected (standalone mode)\n` +
                `**Browser:** ${this._connectedBrowserName}\n\n` +
                `**Next Steps:**\n` +
                `1. Call \`browser_tabs action='list'\` to see available tabs\n` +
                `2. Call \`browser_tabs action='attach' index=N\` to attach to a tab\n` +
                `3. Or call \`browser_tabs action='new' url='https://...'\` to create a new tab\n\n` +
                `After attaching to a tab, you can use:\n` +
                `- \`browser_navigate\` - Navigate to URLs\n` +
                `- \`browser_interact\` - Click, type, etc.\n` +
                `- \`browser_snapshot\` - Get page content\n` +
                `- And more...`
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
        ? `### Connection Failed\n\nPort 5555 is already in use.\n\n**Possible causes:**\n- Another MCP server is already running\n- Another application is using port 5555\n\n**Solution:** Kill the process using port 5555:\n\`\`\`\nlsof -ti:5555 | xargs kill -9\n\`\`\`\n\nThen try connecting again.`
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
      debugLog('[StatefulBackend] Client ID:', this._clientId);

      // Get stored tokens for authentication
      const tokens = await this._oauthClient.getStoredTokens();
      if (!tokens || !tokens.accessToken) {
        throw new Error('No access token found - please authenticate first');
      }

      // Create temporary MCPConnection to list browsers
      const mcpConnection = new MCPConnection({
        mode: 'proxy',
        url: this._userInfo.connectionUrl,
        accessToken: tokens.accessToken,
        clientId: this._clientId
      });

      // Connect and authenticate, then list extensions
      await mcpConnection._connectWebSocket(this._userInfo.connectionUrl);

      const handshakeParams = { access_token: tokens.accessToken };
      if (this._clientId) {
        handshakeParams.client_id = this._clientId;
      }

      await mcpConnection.sendRequest('mcp_handshake', handshakeParams);
      debugLog('[StatefulBackend] Authenticated with proxy');

      // List available extensions
      const extensionsResult = await mcpConnection.sendRequest('list_extensions', {});
      debugLog('[StatefulBackend] Available extensions:', extensionsResult);

      if (!extensionsResult || !extensionsResult.extensions || extensionsResult.extensions.length === 0) {
        await mcpConnection.close();
        throw new Error('No browser extensions are connected to the proxy.');
      }

      const browsers = extensionsResult.extensions;

      if (browsers.length === 1) {
        // Single browser - auto-connect
        debugLog('[StatefulBackend] Single browser found, auto-connecting:', browsers[0].name);

        const connectResult = await mcpConnection.sendRequest('connect', { extension_id: browsers[0].id });
        mcpConnection._connectionId = connectResult.connection_id;
        mcpConnection._authenticated = true;
        mcpConnection._connected = true;

        // Monitor connection close events
        mcpConnection.onClose = (code, reason) => {
          debugLog('[StatefulBackend] Connection closed:', code, reason);
          console.error(`[StatefulBackend] ⚠️  Connection to browser "${browsers[0].name}" lost - resetting to passive state`);
          this._state = 'passive';
          this._activeBackend = null;
          this._proxyConnection = null;
        };

        // Monitor tab info updates (keep _attachedTab in sync with actual browser state)
        mcpConnection.onTabInfoUpdate = (tabInfo) => {
          console.error('[StatefulBackend] Tab info update callback called with:', tabInfo);
          console.error('[StatefulBackend] Current _attachedTab before update:', this._attachedTab);

          // If tabInfo is null, clear the attached tab (tab was closed/detached)
          if (tabInfo === null) {
            console.error('[StatefulBackend] Tab detached, clearing cached state');
            this._attachedTab = null;
            console.error('[StatefulBackend] _attachedTab after clearing:', this._attachedTab);
            return;
          }

          // Update cached tab info with fresh data from browser
          if (this._attachedTab && this._attachedTab.id === tabInfo.id) {
            this._attachedTab = {
              ...this._attachedTab,
              title: tabInfo.title,
              url: tabInfo.url,
              index: tabInfo.index
            };
            console.error('[StatefulBackend] Updated cached tab info:', this._attachedTab);
          }
        };

        // Create ProxyTransport using the MCPConnection
        const transport = new ProxyTransport(mcpConnection);

        // Create unified backend
        this._activeBackend = new UnifiedBackend(this._config, transport);
        await this._activeBackend.initialize(this._server, this._clientInfo, this);

        this._proxyConnection = mcpConnection;
        this._state = 'connected';
        this._connectedBrowserName = browsers[0].name || 'Chrome';  // Store browser name

        debugLog('[StatefulBackend] Successfully auto-connected to single browser');

        return {
          content: [{
            type: 'text',
            text: this._getStatusHeader() +
                  `### ✅ Browser Automation Activated!\n\n` +
                  `**State:** Connected (proxy mode)\n` +
                  `**Email:** ${this._userInfo.email}\n` +
                  `**Browser:** ${this._connectedBrowserName}\n` +
                  `**Client ID:** ${this._clientId}\n\n` +
                  `**Next Steps:**\n` +
                  `1. Call \`browser_tabs action='list'\` to see available tabs\n` +
                  `2. Call \`browser_tabs action='attach' index=N\` to attach to a tab\n` +
                  `3. Or call \`browser_tabs action='new' url='https://...'\` to create a new tab\n\n` +
                  `After attaching to a tab, you can use:\n` +
                  `- \`browser_navigate\` - Navigate to URLs\n` +
                  `- \`browser_interact\` - Click, type, etc.\n` +
                  `- \`browser_snapshot\` - Get page content\n` +
                  `- And more...`
          }]
        };
      } else {
        // Multiple browsers - close connection and wait for user selection
        debugLog('[StatefulBackend] Multiple browsers found, waiting for user selection');
        await mcpConnection.close();

        // Store browsers and enter waiting state
        this._availableBrowsers = browsers;
        this._state = 'authenticated_waiting';

        // Format the browser list
        let browserList = '### 🔍 Multiple Browsers Found\n\n';
        browserList += `Found ${browsers.length} Chrome browsers connected to the proxy:\n\n`;

        browsers.forEach((browser, index) => {
          browserList += `${index + 1}. **${browser.name || 'Chrome Browser'}**\n`;
          browserList += `   - ID: \`${browser.id}\`\n`;
          if (browser.version) {
            browserList += `   - Version: ${browser.version}\n`;
          }
          browserList += `\n`;
        });

        browserList += `\n**Next Step:**\n`;
        browserList += `Call \`browser_connect browser_id='<id>'\` to connect to your chosen browser.\n\n`;
        browserList += `**Example:**\n`;
        browserList += `\`\`\`\nbrowser_connect browser_id='${browsers[0].id}'\n\`\`\``;

        return {
          content: [{
            type: 'text',
            text: browserList
          }]
        };
      }
    } catch (error) {
      debugLog('[StatefulBackend] Failed to connect to proxy:', error);

      return {
        content: [{
          type: 'text',
          text: `### ❌ Connection Failed\n\nFailed to connect to remote proxy:\n${error.message}`
        }],
        isError: true
      };
    }
  }

  async _handleDisable() {
    if (this._state === 'passive') {
      return {
        content: [{
          type: 'text',
          text: this._getStatusHeader() +
                `### Already Disabled\n\n**State:** Passive (disabled)\n\nBrowser automation is not active. Call \`enable\` to activate it.`
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
    this._connectedBrowserName = null;  // Clear browser name
    this._attachedTab = null;  // Clear attached tab

    // Notify client that tool list has changed (back to connection tools only, don't await - send async)
    this._notifyToolsListChanged().catch(err =>
      debugLog('[StatefulBackend] Error sending notification:', err)
    );

    return {
      content: [{
        type: 'text',
        text: this._getStatusHeader() +
              `### ✅ Disabled Successfully\n\n**State:** Passive (disabled)\n\nBrowser automation has been deactivated. Browser_ tools are no longer available.\n\nTo reactivate, call \`enable\` again.`
      }]
    };
  }

  async _handleStatus() {
    if (this._state === 'passive') {
      return {
        content: [{
          type: 'text',
          text: this._getStatusHeader() +
                `### ❌ Disabled\n\n**State:** Passive\n\nBrowser automation is not active.\n\nUse the \`enable\` tool to activate browser automation.`
        }]
      };
    }

    if (this._state === 'authenticated_waiting') {
      return {
        content: [{
          type: 'text',
          text: this._getStatusHeader() +
                `### ⏳ Waiting for Browser Selection\n\n**State:** Authenticated, waiting\n\nMultiple browsers found. Use \`browser_connect\` to choose one.`
        }]
      };
    }

    const mode = this._isAuthenticated ? 'PRO' : 'Free';
    let statusText = `### ✅ Enabled\n\n`;
    statusText += `**Mode:** ${mode}\n`;

    if (this._connectedBrowserName) {
      statusText += `**Browser:** ${this._connectedBrowserName}\n`;
    }

    if (this._attachedTab) {
      statusText += `**Attached Tab:** #${this._attachedTab.index} - ${this._attachedTab.title || 'Untitled'}\n`;
      statusText += `**Tab URL:** ${this._attachedTab.url || 'N/A'}\n\n`;
      statusText += `✅ Ready for automation!`;
    } else {
      statusText += `\n⚠️  No tab attached yet. Use \`browser_tabs action='attach' index=N\` to attach to a tab.`;
    }

    return {
      content: [{
        type: 'text',
        text: this._getStatusHeader() + statusText
      }]
    };
  }

  async _handleBrowserConnect(args) {
    debugLog('[StatefulBackend] Handling browser_connect...');

    // Validate browser_id parameter
    if (!args?.browser_id || typeof args.browser_id !== 'string') {
      return {
        content: [{
          type: 'text',
          text: `### ⚠️ Missing Required Parameter\n\n` +
                `**Error:** \`browser_id\` parameter is required\n\n` +
                `**Example:**\n` +
                `\`\`\`\nbrowser_connect browser_id='chrome-abc123...'\n\`\`\`\n\n` +
                `Use the browser ID from the list shown by \`enable\`.`
        }],
        isError: true
      };
    }

    // Check if we're in the right state
    if (this._state !== 'authenticated_waiting') {
      return {
        content: [{
          type: 'text',
          text: `### ⚠️ Invalid State\n\n` +
                `**Current State:** ${this._state}\n\n` +
                `\`browser_connect\` can only be called after \`enable\` returns a list of multiple browsers.\n\n` +
                `**Correct Flow:**\n` +
                `1. Call \`enable client_id='my-project'\`\n` +
                `2. If multiple browsers found, you'll get a list\n` +
                `3. Then call \`browser_connect browser_id='...'\``
        }],
        isError: true
      };
    }

    // Check if we have cached browsers list
    if (!this._availableBrowsers || this._availableBrowsers.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `### ⚠️ No Browsers Available\n\n` +
                `No browsers list cached. Please call \`enable\` again.`
        }],
        isError: true
      };
    }

    const browserId = args.browser_id.trim();

    // Find the selected browser
    const selectedBrowser = this._availableBrowsers.find(b => b.id === browserId);
    if (!selectedBrowser) {
      const availableIds = this._availableBrowsers.map(b => `- \`${b.id}\``).join('\n');
      return {
        content: [{
          type: 'text',
          text: `### ⚠️ Browser Not Found\n\n` +
                `Browser ID \`${browserId}\` not found in available browsers.\n\n` +
                `**Available browser IDs:**\n${availableIds}`
        }],
        isError: true
      };
    }

    try {
      debugLog('[StatefulBackend] Connecting to selected browser:', selectedBrowser.name);

      // Get stored tokens
      const tokens = await this._oauthClient.getStoredTokens();
      if (!tokens || !tokens.accessToken) {
        throw new Error('No access token found - please authenticate first');
      }

      // Create new MCPConnection for this browser
      const mcpConnection = new MCPConnection({
        mode: 'proxy',
        url: this._userInfo.connectionUrl,
        accessToken: tokens.accessToken,
        clientId: this._clientId
      });

      // Connect and authenticate
      await mcpConnection._connectWebSocket(this._userInfo.connectionUrl);

      const handshakeParams = { access_token: tokens.accessToken };
      if (this._clientId) {
        handshakeParams.client_id = this._clientId;
      }

      await mcpConnection.sendRequest('mcp_handshake', handshakeParams);

      // Connect to the selected browser
      const connectResult = await mcpConnection.sendRequest('connect', { extension_id: browserId });
      mcpConnection._connectionId = connectResult.connection_id;
      mcpConnection._authenticated = true;
      mcpConnection._connected = true;

      // Monitor browser disconnection (extension disconnects, proxy stays connected)
      mcpConnection.onBrowserDisconnected = (params) => {
        debugLog('[StatefulBackend] Browser disconnected:', params);
        console.error(`[StatefulBackend] ⚠️  Browser extension "${this._connectedBrowserName}" disconnected`);

        // Mark browser as disconnected but keep proxy connection alive
        this._browserDisconnected = true;

        // Remember what we were connected to for auto-reconnect
        this._lastConnectedBrowserId = this._lastConnectedBrowserId || selectedBrowser.id;
        this._lastAttachedTab = this._attachedTab; // Remember current tab

        // Clear current connection state
        this._attachedTab = null;
      };

      // Monitor tab info updates (keep _attachedTab in sync with actual browser state)
      mcpConnection.onTabInfoUpdate = (tabInfo) => {
        debugLog('[StatefulBackend] Tab info update:', tabInfo);

        // If tabInfo is null, clear the attached tab (tab was closed/detached)
        if (tabInfo === null) {
          debugLog('[StatefulBackend] Tab detached, clearing cached state');
          this._attachedTab = null;
          return;
        }

        // Update cached tab info with fresh data from browser
        if (this._attachedTab && this._attachedTab.id === tabInfo.id) {
          this._attachedTab = {
            ...this._attachedTab,
            title: tabInfo.title,
            url: tabInfo.url,
            index: tabInfo.index
          };
          debugLog('[StatefulBackend] Updated cached tab info:', this._attachedTab);
        }
      };

      // Monitor connection close events (proxy connection lost)
      mcpConnection.onClose = (code, reason) => {
        debugLog('[StatefulBackend] Proxy connection closed:', code, reason);
        console.error(`[StatefulBackend] ⚠️  Proxy connection lost - resetting to passive state`);
        this._state = 'passive';
        this._activeBackend = null;
        this._proxyConnection = null;
        this._attachedTab = null;
        this._connectedBrowserName = null;
        this._browserDisconnected = false;
        this._lastConnectedBrowserId = null;
        this._lastAttachedTab = null;
      };

      // Create ProxyTransport using the MCPConnection
      const transport = new ProxyTransport(mcpConnection);

      // Create unified backend
      this._activeBackend = new UnifiedBackend(this._config, transport);
      await this._activeBackend.initialize(this._server, this._clientInfo, this);

      this._proxyConnection = mcpConnection;
      this._state = 'connected';
      this._connectedBrowserName = selectedBrowser.name || 'Chrome';  // Store browser name
      this._lastConnectedBrowserId = selectedBrowser.id; // Remember for auto-reconnect
      this._browserDisconnected = false; // Reset disconnected flag
      this._availableBrowsers = null; // Clear the cache

      debugLog('[StatefulBackend] Successfully connected to selected browser');

      return {
        content: [{
          type: 'text',
          text: this._getStatusHeader() +
                `### ✅ Browser Automation Activated!\n\n` +
                `**State:** Connected (proxy mode)\n` +
                `**Email:** ${this._userInfo.email}\n` +
                `**Browser:** ${this._connectedBrowserName}\n` +
                `**Client ID:** ${this._clientId}\n\n` +
                `**Next Steps:**\n` +
                `1. Call \`browser_tabs action='list'\` to see available tabs\n` +
                `2. Call \`browser_tabs action='attach' index=N\` to attach to a tab\n` +
                `3. Or call \`browser_tabs action='new' url='https://...'\` to create a new tab\n\n` +
                `After attaching to a tab, you can use:\n` +
                `- \`browser_navigate\` - Navigate to URLs\n` +
                `- \`browser_interact\` - Click, type, etc.\n` +
                `- \`browser_snapshot\` - Get page content\n` +
                `- And more...`
        }]
      };
    } catch (error) {
      debugLog('[StatefulBackend] Failed to connect to browser:', error);
      this._state = 'passive';
      this._availableBrowsers = null;

      return {
        content: [{
          type: 'text',
          text: `### ❌ Connection Failed\n\nFailed to connect to browser "${selectedBrowser.name}":\n${error.message}\n\nPlease try calling \`enable\` again.`
        }],
        isError: true
      };
    }
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
