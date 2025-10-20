/**
 * OAuth2 Authentication Module
 *
 * Handles OAuth2 authentication flow for MCP server:
 * 1. Starts local HTTP server on random port to receive OAuth callback
 * 2. Opens browser to OAuth authorization URL
 * 3. Waits for callback with authorization code/tokens
 * 4. Stores tokens securely
 */

const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Helper function for debug logging
function debugLog(...args) {
  if (global.DEBUG_MODE) {
    console.error('[OAuth]', ...args);
  }
}

// Configuration
const TOKEN_FILE = path.join(os.homedir(), '.chrome-mcp-tokens.json');

class OAuth2Client {
  constructor(config) {
    this.authBaseUrl = config.authBaseUrl || 'https://mcp-for-chrome.railsblueprint.com';
    this.callbackServer = null;
    this.callbackPort = null;
  }

  /**
   * Start the OAuth flow
   * @returns {Promise<{accessToken: string, refreshToken: string}>}
   */
  async authenticate() {
    debugLog('Starting OAuth flow...');

    // Start callback server
    const callbackUrl = await this._startCallbackServer();
    debugLog('Callback server started at', callbackUrl);

    // Build authorization URL
    const authUrl = `${this.authBaseUrl}/mcp/login?` +
      `callback_url=${encodeURIComponent(callbackUrl)}`;

    debugLog('Opening browser to:', authUrl);

    // Open browser
    await this._openBrowser(authUrl);

    // Wait for callback (with 5 minute timeout)
    const tokens = await this._waitForCallback(300000);

    // Stop callback server
    this._stopCallbackServer();

    // Store tokens
    await this._storeTokens(tokens);

    return tokens;
  }

  /**
   * Get stored tokens
   * @returns {Promise<{accessToken: string, refreshToken: string} | null>}
   */
  async getStoredTokens() {
    try {
      if (!fs.existsSync(TOKEN_FILE)) {
        return null;
      }

      const data = await fs.promises.readFile(TOKEN_FILE, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      debugLog('Error reading stored tokens:', error);
      return null;
    }
  }

  /**
   * Clear stored tokens
   */
  async clearTokens() {
    try {
      if (fs.existsSync(TOKEN_FILE)) {
        await fs.promises.unlink(TOKEN_FILE);
      }
    } catch (error) {
      debugLog('Error clearing tokens:', error);
    }
  }

  /**
   * Check if user is authenticated
   * @returns {Promise<boolean>}
   */
  async isAuthenticated() {
    const tokens = await this.getStoredTokens();
    return tokens !== null && tokens.accessToken;
  }

  /**
   * Verify tokens with server and get user info
   * @returns {Promise<{isPro: boolean, email: string} | null>}
   */
  async verifyTokens() {
    const tokens = await this.getStoredTokens();
    if (!tokens || !tokens.accessToken) {
      return null;
    }

    try {
      // TODO: Make API call to verify token and get user info
      // For now, just return a placeholder
      debugLog('Verifying tokens with server...');

      // In production, this would make an API call like:
      // const response = await fetch(`${this.authBaseUrl}/api/v1/me`, {
      //   headers: { 'Authorization': `Bearer ${tokens.accessToken}` }
      // });
      // return await response.json();

      return { isPro: false, email: 'user@example.com' };
    } catch (error) {
      debugLog('Error verifying tokens:', error);
      return null;
    }
  }

  /**
   * Start HTTP server to receive OAuth callback
   * @returns {Promise<string>} - Callback URL
   */
  async _startCallbackServer() {
    this.callbackPromise = { resolve: null, reject: null };

    this.callbackServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${this.callbackPort}`);

      if (url.pathname === '/callback') {
        debugLog('Received OAuth callback');

        // Handle POST request (form data with tokens)
        if (req.method === 'POST') {
          let body = '';
          req.on('data', chunk => {
            body += chunk.toString();
          });
          req.on('end', () => {
            debugLog('POST body:', body);
            const params = new URLSearchParams(body);
            const accessToken = params.get('access_token');
            const refreshToken = params.get('refresh_token');
            const error = params.get('error');

            this._handleCallbackResponse(res, accessToken, refreshToken, error);
          });
          return;
        }

        // Handle GET request (legacy, query params)
        const accessToken = url.searchParams.get('access_token');
        const refreshToken = url.searchParams.get('refresh_token');
        const error = url.searchParams.get('error');

        this._handleCallbackResponse(res, accessToken, refreshToken, error);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    return this._setupCallbackServer();
  }

  /**
   * Handle OAuth callback response (shared between GET and POST)
   */
  _handleCallbackResponse(res, accessToken, refreshToken, error) {
    if (error) {
      debugLog('OAuth error:', error);
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <body>
            <h1>Authentication Failed</h1>
            <p>Error: ${error}</p>
            <p>You can close this window.</p>
          </body>
        </html>
      `);

      if (this.callbackPromise.reject) {
        this.callbackPromise.reject(new Error(`OAuth error: ${error}`));
      }
      return;
    }

    if (!accessToken) {
      debugLog('No access token in callback');
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <body>
            <h1>Authentication Failed</h1>
            <p>No access token received</p>
            <p>You can close this window.</p>
          </body>
        </html>
      `);

      if (this.callbackPromise.reject) {
        this.callbackPromise.reject(new Error('No access token received'));
      }
      return;
    }

    // Success!
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html>
        <body>
          <h1>Authentication Successful!</h1>
          <p>You can close this window and return to your MCP client.</p>
          <script>
            setTimeout(() => window.close(), 3000);
          </script>
        </body>
      </html>
    `);

    if (this.callbackPromise.resolve) {
      this.callbackPromise.resolve({ accessToken, refreshToken });
    }
  }

  /**
   * Continue with startCallbackServer setup
   */
  _setupCallbackServer() {
    return new Promise((resolve, reject) => {
      // Listen on random port
      this.callbackServer.listen(0, 'localhost', () => {
        this.callbackPort = this.callbackServer.address().port;
        const callbackUrl = `http://localhost:${this.callbackPort}/callback`;
        resolve(callbackUrl);
      });

      this.callbackServer.on('error', (error) => {
        debugLog('Callback server error:', error);
        reject(error);
      });
    });
  }

  /**
   * Wait for OAuth callback
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<{accessToken: string, refreshToken: string}>}
   */
  _waitForCallback(timeout) {
    return new Promise((resolve, reject) => {
      this.callbackPromise = { resolve, reject };

      // Set timeout
      const timeoutId = setTimeout(() => {
        debugLog('OAuth callback timeout');
        reject(new Error('Authentication timeout - no callback received'));
      }, timeout);

      // Override resolve/reject to clear timeout
      const originalResolve = resolve;
      const originalReject = reject;

      this.callbackPromise.resolve = (tokens) => {
        clearTimeout(timeoutId);
        originalResolve(tokens);
      };

      this.callbackPromise.reject = (error) => {
        clearTimeout(timeoutId);
        originalReject(error);
      };
    });
  }

  /**
   * Stop callback server
   */
  _stopCallbackServer() {
    if (this.callbackServer) {
      this.callbackServer.close();
      this.callbackServer = null;
      this.callbackPort = null;
    }
  }

  /**
   * Open browser to URL
   * @param {string} url
   */
  async _openBrowser(url) {
    const { exec } = require('child_process');
    const platform = process.platform;

    let command;
    if (platform === 'darwin') {
      command = `open "${url}"`;
    } else if (platform === 'win32') {
      command = `start "${url}"`;
    } else {
      command = `xdg-open "${url}"`;
    }

    return new Promise((resolve, reject) => {
      exec(command, (error) => {
        if (error) {
          debugLog('Error opening browser:', error);
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Store tokens securely
   * @param {{accessToken: string, refreshToken: string}} tokens
   */
  async _storeTokens(tokens) {
    try {
      const data = JSON.stringify(tokens, null, 2);
      await fs.promises.writeFile(TOKEN_FILE, data, { mode: 0o600 });
      debugLog('Tokens stored successfully');
    } catch (error) {
      debugLog('Error storing tokens:', error);
      throw error;
    }
  }
}

module.exports = { OAuth2Client };
