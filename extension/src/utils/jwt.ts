/**
 * JWT Token Utilities
 *
 * Decode JWT tokens to extract user information (email, connection_url).
 * Note: This is client-side decoding without signature verification.
 */

export interface TokenClaims {
  email?: string;
  connection_url?: string;
  user_id?: string;
  session_id?: string;
  exp?: number;
  iat?: number;
}

/**
 * Decode a JWT token and extract claims (without verification)
 */
export function decodeJWT(token: string): TokenClaims | null {
  try {
    // JWT format: header.payload.signature
    const parts = token.split('.');
    if (parts.length !== 3) {
      console.error('[JWT] Invalid JWT format');
      return null;
    }

    // Decode base64url payload (second part)
    const payload = parts[1];
    // Replace base64url chars with base64 chars
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    // Decode base64
    const jsonString = atob(base64);

    return JSON.parse(jsonString);
  } catch (error) {
    console.error('[JWT] Error decoding token:', error);
    return null;
  }
}

/**
 * Get user info from stored access token
 */
export async function getUserInfoFromStorage(): Promise<{ email: string; connectionUrl: string } | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['accessToken'], (result) => {
      if (!result.accessToken) {
        resolve(null);
        return;
      }

      const claims = decodeJWT(result.accessToken);
      if (!claims || !claims.email) {
        resolve(null);
        return;
      }

      resolve({
        email: claims.email,
        connectionUrl: claims.connection_url || ''
      });
    });
  });
}

/**
 * Check if token will expire soon (within specified minutes)
 * @param token JWT access token
 * @param minutesBeforeExpiry How many minutes before expiry to consider "soon" (default: 5)
 * @returns true if token expires within the specified time
 */
export function isTokenExpiringSoon(token: string, minutesBeforeExpiry: number = 5): boolean {
  const claims = decodeJWT(token);
  if (!claims || !claims.exp) {
    return true; // Treat invalid token as expired
  }

  const expiryTime = claims.exp * 1000; // Convert to milliseconds
  const now = Date.now();
  const timeUntilExpiry = expiryTime - now;
  const refreshThreshold = minutesBeforeExpiry * 60 * 1000; // Convert minutes to ms

  return timeUntilExpiry <= refreshThreshold;
}

/**
 * Calculate milliseconds until token should be refreshed
 * @param token JWT access token
 * @param minutesBeforeExpiry When to refresh before expiry (default: 5)
 * @returns milliseconds until refresh, or 0 if already should refresh
 */
export function getMillisecondsUntilRefresh(token: string, minutesBeforeExpiry: number = 5): number {
  const claims = decodeJWT(token);
  if (!claims || !claims.exp) {
    return 0; // Refresh immediately if invalid
  }

  const expiryTime = claims.exp * 1000;
  const now = Date.now();
  const refreshThreshold = minutesBeforeExpiry * 60 * 1000;
  const refreshTime = expiryTime - refreshThreshold;
  const msUntilRefresh = refreshTime - now;

  return Math.max(0, msUntilRefresh);
}

/**
 * Get default browser name with version
 */
export function getDefaultBrowserName(): string {
  const userAgent = navigator.userAgent;

  // Detect Chrome version
  const chromeMatch = userAgent.match(/Chrome\/(\d+)/);
  if (chromeMatch) {
    return `Chrome ${chromeMatch[1]}`;
  }

  // Fallback
  return 'Chrome';
}
