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
