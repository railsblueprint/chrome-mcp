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
const lockfile = require('proper-lockfile');
const envPaths = require('env-paths');

// Helper function for debug logging
function debugLog(...args) {
  if (global.DEBUG_MODE) {
    console.error('[OAuth]', ...args);
  }
}

// Configuration - Use platform-specific config directory
// Windows: %APPDATA%\chrome-mcp\tokens.json (e.g., C:\Users\Username\AppData\Roaming\chrome-mcp\tokens.json)
// macOS: ~/Library/Preferences/chrome-mcp/tokens.json
// Linux: ~/.config/chrome-mcp/tokens.json
const paths = envPaths('chrome-mcp', { suffix: '' });
const CONFIG_DIR = paths.config;
const TOKEN_FILE = path.join(CONFIG_DIR, 'tokens.json');

class OAuth2Client {
  constructor(config) {
    this.authBaseUrl = config.authBaseUrl || 'https://mcp-for-chrome.railsblueprint.com';
    this.callbackServer = null;
    this.callbackPort = null;
    this.tokenRefreshTimer = null;

    // Start token refresh monitoring
    this.scheduleTokenRefresh();
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

    // Schedule token refresh after successful authentication
    this.scheduleTokenRefresh();

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
   * Decode JWT token and extract claims (without verification)
   * @param {string} token - JWT token
   * @returns {Object | null} - Decoded claims or null if invalid
   */
  _decodeJWT(token) {
    try {
      // JWT format: header.payload.signature
      const parts = token.split('.');
      if (parts.length !== 3) {
        debugLog('Invalid JWT format');
        return null;
      }

      // Decode base64url payload (second part)
      const payload = parts[1];
      // Replace base64url chars with base64 chars
      const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      // Decode base64
      const jsonString = Buffer.from(base64, 'base64').toString('utf8');

      return JSON.parse(jsonString);
    } catch (error) {
      debugLog('Error decoding JWT:', error);
      return null;
    }
  }

  /**
   * Get user info from stored token
   * @returns {Promise<{email: string, connectionUrl: string} | null>}
   */
  async getUserInfo() {
    const tokens = await this.getStoredTokens();
    if (!tokens || !tokens.accessToken) {
      return null;
    }

    try {
      const claims = this._decodeJWT(tokens.accessToken);

      if (!claims) {
        debugLog('Failed to decode access token');
        return null;
      }

      debugLog('Token claims:', claims);

      return {
        email: claims.email,
        connectionUrl: claims.connection_url
      };
    } catch (error) {
      debugLog('Error extracting user info from token:', error);
      return null;
    }
  }

  /**
   * Calculate milliseconds until token should be refreshed
   * @param {string} token - JWT access token
   * @param {number} minutesBeforeExpiry - When to refresh before expiry (default: 5)
   * @returns {number} - Milliseconds until refresh, or 0 if already should refresh
   */
  _getMillisecondsUntilRefresh(token, minutesBeforeExpiry = 5) {
    const claims = this._decodeJWT(token);
    if (!claims || !claims.exp) {
      return 0; // Refresh immediately if invalid
    }

    const expiryTime = claims.exp * 1000; // Convert to milliseconds
    const now = Date.now();
    const refreshThreshold = minutesBeforeExpiry * 60 * 1000; // Convert minutes to ms
    const refreshTime = expiryTime - refreshThreshold;
    const msUntilRefresh = refreshTime - now;

    // Add randomization (0-60 seconds) to avoid thundering herd
    const randomDelay = Math.floor(Math.random() * 60 * 1000);

    return Math.max(0, msUntilRefresh + randomDelay);
  }

  /**
   * Schedule token refresh based on access token expiry
   * Refreshes 5 minutes before expiration (with random delay)
   */
  async scheduleTokenRefresh() {
    // Clear existing timer
    if (this.tokenRefreshTimer !== null) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }

    // Get stored tokens
    const tokens = await this.getStoredTokens();
    if (!tokens || !tokens.accessToken) {
      debugLog('[TokenRefresh] No access token found, skipping refresh schedule');
      return;
    }

    const msUntilRefresh = this._getMillisecondsUntilRefresh(tokens.accessToken, 5);

    if (msUntilRefresh === 0) {
      debugLog('[TokenRefresh] Token already expired or expires soon, refreshing immediately');
      await this.refreshTokens();
    } else {
      const minutesUntilRefresh = Math.round(msUntilRefresh / 1000 / 60);
      debugLog(`[TokenRefresh] Scheduling refresh in ${minutesUntilRefresh} minutes`);
      this.tokenRefreshTimer = setTimeout(() => {
        debugLog('[TokenRefresh] Timer fired, refreshing token');
        this.refreshTokens().catch(error => {
          debugLog('[TokenRefresh] Error in scheduled refresh:', error);
        });
      }, msUntilRefresh);
    }
  }

  /**
   * Refresh access token using refresh token
   * Uses file locking to prevent race conditions with multiple instances
   * @param {number} retryCount - Current retry attempt (internal use)
   * @returns {Promise<void>}
   */
  async refreshTokens(retryCount = 0) {
    debugLog('[TokenRefresh] Starting token refresh...');

    let release = null;

    try {
      // Ensure token file exists before locking
      if (!fs.existsSync(TOKEN_FILE)) {
        debugLog('[TokenRefresh] Token file does not exist, cannot refresh');
        return;
      }

      // Try to acquire lock with timeout
      try {
        debugLog('[TokenRefresh] Acquiring file lock...');
        release = await lockfile.lock(TOKEN_FILE, {
          retries: {
            retries: 3,
            minTimeout: 1000,
            maxTimeout: 5000
          }
        });
        debugLog('[TokenRefresh] Lock acquired');
      } catch (lockError) {
        debugLog('[TokenRefresh] Failed to acquire lock:', lockError.message);

        // Retry if this is not the last attempt
        if (retryCount < 2) {
          const delay = 5000 + Math.floor(Math.random() * 5000); // 5-10 seconds
          debugLog(`[TokenRefresh] Retrying in ${delay}ms (attempt ${retryCount + 1}/2)`);
          await new Promise(resolve => setTimeout(resolve, delay));
          return this.refreshTokens(retryCount + 1);
        }

        debugLog('[TokenRefresh] Max retries reached, giving up');
        return;
      }

      // Re-read tokens to check if another instance already refreshed
      const currentTokens = await this.getStoredTokens();
      if (!currentTokens || !currentTokens.refreshToken) {
        debugLog('[TokenRefresh] No refresh token found after acquiring lock');
        return;
      }

      // Check if token is still stale (another instance might have refreshed)
      const msUntilRefresh = this._getMillisecondsUntilRefresh(currentTokens.accessToken, 5);
      if (msUntilRefresh > 60000) { // More than 1 minute until refresh
        debugLog('[TokenRefresh] Token was already refreshed by another instance, skipping');
        return;
      }

      // Perform the refresh
      debugLog('[TokenRefresh] Calling refresh API...');
      const response = await fetch(`${this.authBaseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: currentTokens.refreshToken
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        debugLog('[TokenRefresh] Failed to refresh token:', response.status, errorText);

        // Clear tokens if refresh fails (user needs to login again)
        if (response.status === 401 || response.status === 403) {
          debugLog('[TokenRefresh] Clearing invalid tokens');
          await this.clearTokens();
        }
        return;
      }

      // Parse JSON:API response
      const data = await response.json();
      const newAccessToken = data.data?.attributes?.access_token;
      const newRefreshToken = data.data?.attributes?.refresh_token;

      if (!newAccessToken || !newRefreshToken) {
        debugLog('[TokenRefresh] Invalid response format:', data);
        return;
      }

      // Store new tokens
      await this._storeTokens({
        accessToken: newAccessToken,
        refreshToken: newRefreshToken
      });

      debugLog('[TokenRefresh] Token refreshed successfully');

    } catch (error) {
      debugLog('[TokenRefresh] Error refreshing token:', error);
    } finally {
      // Always release lock
      if (release) {
        try {
          await release();
          debugLog('[TokenRefresh] Lock released');
        } catch (releaseError) {
          debugLog('[TokenRefresh] Error releasing lock:', releaseError);
        }
      }

      // Schedule next refresh
      await this.scheduleTokenRefresh();
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
      // Ensure config directory exists
      await fs.promises.mkdir(CONFIG_DIR, { recursive: true });

      const data = JSON.stringify(tokens, null, 2);
      await fs.promises.writeFile(TOKEN_FILE, data, { mode: 0o600 });
      debugLog('Tokens stored successfully at', TOKEN_FILE);
    } catch (error) {
      debugLog('Error storing tokens:', error);
      throw error;
    }
  }
}

module.exports = { OAuth2Client };
