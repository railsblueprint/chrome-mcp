/**
 * Smoke tests for chrome-mcp
 * These tests verify the basic functionality works
 */

const { StatefulBackend } = require('../src/statefulBackend');
const { ExtensionServer } = require('../src/extensionServer');
const { OAuth2Client } = require('../src/oauth');

describe('StatefulBackend', () => {
  test('initializes in passive state', () => {
    const backend = new StatefulBackend({ debug: false });
    expect(backend._state).toBe('passive');
  });

  test('has required methods', () => {
    const backend = new StatefulBackend({ debug: false });
    expect(typeof backend.initialize).toBe('function');
    expect(typeof backend.listTools).toBe('function');
    expect(typeof backend.callTool).toBe('function');
    expect(typeof backend.serverClosed).toBe('function');
  });

  test('listTools returns connection management tools', async () => {
    const backend = new StatefulBackend({ debug: false });
    await backend.initialize(null, {});

    const tools = await backend.listTools();

    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);

    // Check for connection management tools
    const toolNames = tools.map(t => t.name);
    expect(toolNames).toContain('enable');
    expect(toolNames).toContain('disable');
    expect(toolNames).toContain('status');
    expect(toolNames).toContain('auth');
  });
});

describe('ExtensionServer', () => {
  test('initializes with port and host', () => {
    const server = new ExtensionServer(5555, '127.0.0.1');
    expect(server._port).toBe(5555);
    expect(server._host).toBe('127.0.0.1');
  });

  test('starts and stops correctly', async () => {
    const server = new ExtensionServer(5556, '127.0.0.1'); // Use different port to avoid conflicts

    // Start server
    await server.start();
    expect(server._httpServer).toBeTruthy();
    expect(server._wss).toBeTruthy();

    // Stop server
    await server.stop();
    expect(server._extensionWs).toBe(null);
    expect(server._wss).toBe(null);
  }, 10000); // Increase timeout for network operations

  test('isConnected returns false when no extension connected', () => {
    const server = new ExtensionServer(5557, '127.0.0.1');
    // isConnected checks if WebSocket exists and is open
    expect(server.isConnected()).toBeFalsy();
  });
});

describe('OAuth2Client', () => {
  test('initializes with auth base URL', () => {
    const customUrl = 'https://test.example.com';
    const client = new OAuth2Client({ authBaseUrl: customUrl });
    // OAuth2Client stores config internally
    expect(client).toBeTruthy();
  });

  test('has required methods', () => {
    const client = new OAuth2Client({});
    expect(typeof client.isAuthenticated).toBe('function');
    expect(typeof client.getUserInfo).toBe('function');
    expect(typeof client.clearTokens).toBe('function');
  });
});

describe('Integration', () => {
  test('server can be created and initialized', async () => {
    const backend = new StatefulBackend({ debug: false });

    // Mock MCP server
    const mockServer = {
      sendToolListChanged: jest.fn()
    };

    await backend.initialize(mockServer, {});

    expect(backend._server).toBe(mockServer);
    expect(backend._state).toBe('passive');
  });

  test('enable requires client_id parameter', async () => {
    const backend = new StatefulBackend({ debug: false });
    await backend.initialize(null, {});

    // Call enable without client_id
    const result = await backend.callTool('enable', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('client_id');
  });

  test('status returns passive state initially', async () => {
    const backend = new StatefulBackend({ debug: false });
    await backend.initialize(null, {});

    const result = await backend.callTool('status', {});

    expect(result.content[0].text).toContain('Disabled');
    expect(result.content[0].text).toContain('Passive');
  });
});
