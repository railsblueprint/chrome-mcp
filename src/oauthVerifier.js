/**
 * OAuth Token Verifier for MCP
 *
 * Implements OAuthTokenVerifier interface to validate tokens issued by
 * Rails Blueprint OAuth authorization server.
 */

const https = require('https');
const http = require('http');

// Helper function for debug logging
function debugLog(...args) {
  if (global.DEBUG_MODE) {
    console.error('[OAuthVerifier]', ...args);
  }
}

class RailsBlueprintOAuthVerifier {
  constructor(config) {
    this.authBaseUrl = config.authBaseUrl || 'https://mcp-for-chrome.railsblueprint.com';
    this.resourceIdentifier = config.resourceIdentifier || 'chrome-mcp://resource';
  }

  /**
   * Verifies an access token and returns information about it.
   * This is called by MCP SDK for every authenticated request.
   *
   * @param {string} token - The access token to verify
   * @returns {Promise<AuthInfo>} Information about the validated token
   */
  async verifyAccessToken(token) {
    debugLog('Verifying access token...');

    try {
      // Call Rails Blueprint API to verify token
      const userInfo = await this._callTokenInfoEndpoint(token);

      debugLog('Token verified successfully:', userInfo);

      // Return MCP-compatible AuthInfo
      return {
        token: token,
        clientId: userInfo.client_id || 'unknown',
        scopes: userInfo.scopes || [],
        expiresAt: userInfo.expires_at ? Math.floor(userInfo.expires_at) : undefined,
        resource: new URL(this.resourceIdentifier),
        extra: {
          isPro: userInfo.is_pro || false,
          email: userInfo.email,
          userId: userInfo.user_id
        }
      };
    } catch (error) {
      debugLog('Token verification failed:', error.message);
      throw new Error(`Invalid access token: ${error.message}`);
    }
  }

  /**
   * Call the token info endpoint to validate the token
   * @param {string} token
   * @returns {Promise<Object>}
   */
  async _callTokenInfoEndpoint(token) {
    return new Promise((resolve, reject) => {
      const url = new URL('/oauth/token/info', this.authBaseUrl);
      const protocol = url.protocol === 'https:' ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        }
      };

      debugLog('Calling token info endpoint:', url.toString());

      const req = protocol.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              resolve(json);
            } catch (error) {
              reject(new Error(`Invalid JSON response: ${error.message}`));
            }
          } else if (res.statusCode === 401) {
            reject(new Error('Token is invalid or expired'));
          } else {
            reject(new Error(`Token verification failed with status ${res.statusCode}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Network error: ${error.message}`));
      });

      req.end();
    });
  }
}

module.exports = { RailsBlueprintOAuthVerifier };
