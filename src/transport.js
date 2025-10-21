/**
 * Transport Layer Abstraction
 *
 * Provides a unified interface for sending commands to the extension,
 * whether directly via WebSocket or through a proxy.
 */

/**
 * Base Transport interface
 * Both DirectTransport and ProxyTransport implement this
 */
class Transport {
  /**
   * Send a command to the extension
   * @param {string} method - Extension method (e.g., 'getTabs', 'forwardCDPCommand')
   * @param {object} params - Method parameters
   * @returns {Promise<any>} - Result from extension
   */
  async sendCommand(method, params) {
    throw new Error('sendCommand must be implemented by subclass');
  }

  /**
   * Close the transport
   */
  async close() {
    throw new Error('close must be implemented by subclass');
  }
}

/**
 * DirectTransport - for standalone mode
 * Uses ExtensionServer for direct WebSocket connection to extension
 */
class DirectTransport extends Transport {
  constructor(extensionServer) {
    super();
    this._server = extensionServer;
  }

  async sendCommand(method, params) {
    // Send directly to extension via WebSocket
    return await this._server.sendCommand(method, params);
  }

  async close() {
    // Server cleanup is handled by StatefulBackend
  }
}

/**
 * ProxyTransport - for proxy mode
 * Wraps MCPConnection
 */
class ProxyTransport extends Transport {
  constructor(mcpConnection) {
    super();
    this._mcpConnection = mcpConnection;
  }

  async sendCommand(method, params) {
    // Send via MCPConnection which routes through proxy
    return await this._mcpConnection.sendRequest(method, params);
  }

  async close() {
    await this._mcpConnection.close();
  }
}

module.exports = { Transport, DirectTransport, ProxyTransport };
