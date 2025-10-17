/**
 * Primary MCP Server with Proxy Support
 *
 * The first MCP instance to start becomes the primary server:
 * - Listens on port 5555 for extension connection
 * - Listens on port 5556 for proxy connections from other MCP instances
 * - Multiplexes requests from all proxies to the extension
 * - Routes responses back to the correct proxy
 */

const { wsServer: WebSocketServer } = require('playwright-core/lib/utilsBundle');
const path = require('path');
const { BrowserServerBackend } = require(path.join(__dirname, '../node_modules/playwright/lib/mcp/browser/browserServerBackend'));
const { randomUUID } = require('crypto');

class PrimaryServer {
  constructor(config, extensionContextFactory) {
    console.error('[PrimaryServer] Constructor called');
    this._config = config;
    this._extensionContextFactory = extensionContextFactory;
    this._backend = null;
    this._proxies = new Map(); // proxyId -> { ws, clientInfo, pendingRequests }
    this._extensionReady = false;
    this._initialized = false;
    this._proxyHandlerInstalled = false;

    console.error('[PrimaryServer] Primary server will use single port 5555 with paths:');
    console.error('  - ws://127.0.0.1:5555/extension (for browser extension)');
    console.error('  - ws://127.0.0.1:5555/proxy (for MCP proxy instances)');
  }

  async initialize(server, clientInfo) {
    if (this._initialized) {
      console.error('[PrimaryServer] Already initialized, skipping');
      return;
    }

    console.error('[PrimaryServer] Initialize called');

    // Initialize the main backend (handles extension connection on port 5555)
    this._backend = new BrowserServerBackend(this._config, this._extensionContextFactory);
    await this._backend.initialize(server, clientInfo);

    // Force immediate relay creation to open port 5555
    console.error('[PrimaryServer] Forcing immediate CDPRelayServer creation');
    const abortController = new AbortController();
    await this._extensionContextFactory.ensureRelay(clientInfo, abortController.signal, 'initialize');
    console.error('[PrimaryServer] CDPRelayServer created, port 5555 is now open');

    // Hook into the CDPRelayServer's HTTP server to add /proxy WebSocket handler
    await this._installProxyHandler();

    this._initialized = true;
    console.error('[PrimaryServer] Backend and proxy handler initialized');
  }

  async _installProxyHandler() {
    if (this._proxyHandlerInstalled) {
      console.error('[PrimaryServer] Proxy handler already installed, skipping');
      return;
    }

    // CDPRelayServer is now guaranteed to exist because we force its creation in initialize()
    const cdpRelayServer = this._extensionContextFactory.getCdpRelayServer();

    if (!cdpRelayServer) {
      throw new Error('CDPRelayServer should exist at this point. This is a bug.');
    }

    console.error('[PrimaryServer] Installing proxy WebSocket handler on /proxy path');

    // Get the existing WebSocket server from CDPRelayServer
    const wss = cdpRelayServer._wss;

    if (!wss) {
      console.error('[PrimaryServer] Warning: CDPRelayServer._wss not found, cannot install proxy handler');
      return;
    }

    // Hook into connection events to handle /proxy path
    const originalConnectionHandler = wss.listeners('connection')[0];

    if (!originalConnectionHandler) {
      console.error('[PrimaryServer] Warning: No existing connection handler found');
    }

    wss.removeAllListeners('connection');
    wss.on('connection', (ws, request) => {
      const url = new URL(`http://localhost${request.url}`);
      console.error(`[PrimaryServer] WebSocket connection to ${url.pathname}`);

      if (url.pathname === '/proxy') {
        console.error('[PrimaryServer] Handling as PROXY connection');
        this._handleProxyConnection(ws);
      } else {
        // Forward to original handler for /extension and /cdp
        console.error('[PrimaryServer] Forwarding to original handler (extension/cdp)');
        if (originalConnectionHandler) {
          originalConnectionHandler(ws, request);
        } else {
          console.error('[PrimaryServer] Warning: No original handler to forward to!');
          ws.close(1011, 'No handler for this path');
        }
      }
    });

    this._proxyHandlerInstalled = true;
    console.error('[PrimaryServer] Proxy handler installed successfully on ws://127.0.0.1:5555/proxy');
  }

  _handleProxyConnection(ws) {
    let proxyId = null;

    console.error('[PrimaryServer] New proxy connection');

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        switch (message.type) {
          case 'register':
            proxyId = randomUUID();
            this._proxies.set(proxyId, {
              ws,
              clientInfo: message.clientInfo,
              pendingRequests: new Map()
            });

            ws.send(JSON.stringify({
              type: 'registered',
              proxyId
            }));

            console.error(`[PrimaryServer] Proxy registered: ${proxyId}`);
            break;

          case 'listTools':
            if (!proxyId) {
              ws.send(JSON.stringify({
                type: 'error',
                requestId: message.requestId,
                error: 'Not registered. Send register message first.'
              }));
              return;
            }

            try {
              const tools = await this._backend.listTools();
              ws.send(JSON.stringify({
                type: 'toolsList',
                requestId: message.requestId,
                tools
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                requestId: message.requestId,
                error: error.message
              }));
            }
            break;

          case 'callTool':
            if (!proxyId) {
              ws.send(JSON.stringify({
                type: 'error',
                requestId: message.requestId,
                error: 'Not registered. Send register message first.'
              }));
              return;
            }

            try {
              const response = await this._backend.callTool(
                message.toolName,
                message.arguments
              );

              ws.send(JSON.stringify({
                type: 'toolResponse',
                requestId: message.requestId,
                response
              }));
            } catch (error) {
              ws.send(JSON.stringify({
                type: 'error',
                requestId: message.requestId,
                error: error.message
              }));
            }
            break;

          default:
            console.error(`[PrimaryServer] Unknown message type: ${message.type}`);
        }
      } catch (error) {
        console.error('[PrimaryServer] Error handling proxy message:', error);
      }
    });

    ws.on('close', () => {
      if (proxyId) {
        console.error(`[PrimaryServer] Proxy disconnected: ${proxyId}`);
        this._proxies.delete(proxyId);
      }
    });

    ws.on('error', (error) => {
      console.error('[PrimaryServer] Proxy WebSocket error:', error);
    });
  }

  async listTools() {
    // Backend might not be initialized yet (lazy init on first tool call)
    // Return empty list for now - tools will be available after first callTool
    if (!this._backend) {
      console.error('[PrimaryServer] Backend not yet initialized, returning empty tool list');
      return [];
    }
    return await this._backend.listTools();
  }

  async callTool(name, rawArguments) {
    // Ensure backend is initialized
    if (!this._backend) {
      throw new Error('Backend not initialized. This should not happen - initialize() should be called before callTool()');
    }

    // Proxy handler should already be installed during initialize()
    if (!this._proxyHandlerInstalled) {
      throw new Error('Proxy handler should be installed during initialize(). This is a bug.');
    }

    return await this._backend.callTool(name, rawArguments);
  }

  serverClosed() {
    console.error('[PrimaryServer] Shutting down primary server');

    // Close all proxy connections
    for (const [proxyId, proxy] of this._proxies.entries()) {
      proxy.ws.close(1000, 'Primary server shutting down');
    }
    this._proxies.clear();

    // Close backend (which will close the CDPRelayServer with both /extension and /proxy paths)
    if (this._backend) {
      this._backend.serverClosed();
    }
  }
}

module.exports = { PrimaryServer };
