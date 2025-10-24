# Firefox Extension - PRO Mode Setup

**Version:** 1.0.0
**Date:** 2025-10-24

## Overview

The Firefox extension now supports PRO mode, allowing connection to a cloud relay server for remote browser automation with OAuth authentication.

## Features

### Free Mode (Default)
- ✅ Connect to local MCP server on localhost:5555
- ✅ No authentication required
- ✅ Single browser instance
- ✅ Works offline

### PRO Mode
- ✅ Connect to cloud relay server
- ✅ OAuth authentication
- ✅ Access from anywhere
- ✅ Multiple browser instances
- ✅ Shared access across MCP clients

## Setup Instructions

### 1. Access Extension Popup

Click the Blueprint MCP extension icon in your Firefox toolbar to open the popup.

### 2. Sign In to PRO Mode

**If you don't have PRO:**
1. Click "Upgrade to PRO" button in the popup
2. Complete the purchase flow
3. Return to popup and click "Sign in"

**If you already have PRO:**
1. Click "Already have PRO? Sign in" link in the popup
2. You'll be redirected to the authentication page
3. Log in with your account credentials
4. After successful login, you'll be redirected back
5. Extension will automatically connect to relay server

### 3. Configure Settings (Optional)

**For Free Mode Users:**
1. Click "⚙️ Settings" in the popup
2. Change "MCP Server Port" if your server runs on a different port (default: 5555)
3. Optionally enable "Debug Mode" for troubleshooting
4. Click "Save"
5. Extension will reload to apply changes

**For PRO Users:**
1. Click "⚙️ Settings" in the popup
2. Configure "Browser Name" to identify this browser (default: "Firefox")
3. Optionally enable "Debug Mode" for troubleshooting
4. Click "Save"

### 4. Verify Connection

After signing in:
1. Popup will show "✓ PRO Account Active"
2. Your email will be displayed
3. Connection status shows: "Connections: X/Y" and "This browser: Z"
4. Status should show "Connected" when MCP server is running

## Technical Details

### Authentication Protocol

The extension implements the MCP Proxy Protocol for authentication:

**Connection Flow:**
1. Extension connects to relay server WebSocket (wss://mcp-for-chrome.railsblueprint.com)
2. Relay sends `authenticate` request
3. Extension responds with stored tokens:
   ```json
   {
     "access_token": "...",
     "refresh_token": "...",
     "browser_name": "Firefox",
     "browser_version": "1.0.0"
   }
   ```
4. Relay validates tokens
5. Connection established

### ID Mapping

PRO mode supports connection ID mapping:
- Free mode IDs: `1`, `2`, `3` (numeric)
- PRO mode IDs: `"conn-abc:1"` (string with prefix)

The extension automatically handles both formats.

### Storage

Settings are stored in `browser.storage.local`:
- `extensionEnabled` (boolean) - Extension enabled/disabled
- `isPro` (boolean) - PRO mode active
- `accessToken` (string) - OAuth access token
- `refreshToken` (string) - OAuth refresh token
- `browserName` (string) - Browser display name (PRO users)
- `mcpPort` (string) - Local server port (free mode)
- `debugMode` (boolean) - Debug logging enabled

### OAuth Tokens

Tokens are obtained automatically through the web-based login flow:
1. User clicks "Sign in" in popup
2. Browser opens: `https://mcp-for-chrome.railsblueprint.com/extension/login?extension_id=<id>`
3. User logs in via OAuth provider
4. After successful login, tokens are stored in `browser.storage.local`
5. Extension auto-connects to relay server

## Troubleshooting

### Connection Fails

**Check:**
1. Status shows "Connected" (if not, MCP server may not be running)
2. Extension is enabled (toggle button should show "Disable")
3. For PRO: You're signed in (popup shows "✓ PRO Account Active")
4. For Free: MCP server is running on localhost:5555

### Authentication Error

**Fix:**
1. Click "Logout" in popup
2. Click "Sign in" again
3. Complete login flow
4. Check that popup shows your email

### Switching Back to Free Mode

1. Click "Logout" in popup
2. Extension will disconnect from relay
3. Extension connects to localhost:5555 (free mode)

## Security Notes

- Tokens are stored in browser.storage.local (encrypted at rest by Firefox)
- Relay connections use WSS (WebSocket Secure)
- OAuth tokens have expiration
- Refresh tokens allow automatic renewal
- No tokens are sent to third parties

## Relay Server URL

```
wss://mcp-for-chrome.railsblueprint.com
```

**Components:**
- `wss://` - Secure WebSocket protocol
- `mcp-for-chrome.railsblueprint.com` - Relay server domain

## Comparison: Free vs PRO

| Feature | Free | PRO |
|---------|------|-----|
| Connection | localhost | Cloud relay |
| Authentication | None | OAuth |
| Remote Access | ❌ No | ✅ Yes |
| Multiple Browsers | ❌ No | ✅ Yes |
| Shared Access | ❌ No | ✅ Yes |
| Offline | ✅ Yes | ❌ No |
| Connection Limit | 1 | Based on plan |

## Implementation Details

### Files Modified

1. **src/background.js** - Connection logic, authentication handler
2. **popup.html** - Simple HTML with root div
3. **popup.js** - Complete popup UI logic (settings included)
4. **popup.css** - Copied from Chrome extension
5. **manifest.json** - Removed options_ui, updated web_accessible_resources

### Code Changes

**Connection:**
```javascript
// Determine mode based on settings
const result = await browser.storage.local.get(['mcpPort', 'relayServerUrl', 'useRelayServer']);

let url;
if (result.useRelayServer && result.relayServerUrl) {
  // PRO mode: Connect to relay server
  url = result.relayServerUrl;
} else {
  // Free mode: Connect to localhost
  const port = result.mcpPort || '5555';
  url = `ws://127.0.0.1:${port}/extension`;
}
```

**Authentication:**
```javascript
case 'authenticate':
  // Get stored tokens
  const result = await browser.storage.local.get(['accessToken', 'refreshToken']);
  return {
    access_token: result.accessToken,
    refresh_token: result.refreshToken,
    browser_name: 'Firefox',
    browser_version: '1.0.0'
  };
```

**Popup Settings (In-Popup Modal):**
```javascript
// Settings are rendered in the popup itself, not separate page
if (state.showSettings) {
  root.innerHTML = renderSettings();
} else {
  root.innerHTML = renderMain();
}
```

## UI/UX

### Popup Views

**Main View:**
- Status indicator (Connected/Disconnected/Connecting)
- This tab status (Automated/Not automated)
- Project name (if connected)
- Stealth mode indicator
- Enable/Disable toggle button
- PRO section (Upgrade or Active account info)
- Links: Settings, Documentation, Test Page, Buy me a beer (free only)

**Settings View (In-Popup):**
- For Free users: MCP Server Port configuration
- For PRO users: Browser Name configuration
- Debug Mode checkbox (both modes)
- Save/Cancel buttons

**PRO Section:**
- Free mode: "Unlock advanced features with PRO" + Upgrade button + Sign in link
- PRO mode: "✓ PRO Account Active" + email + connection stats + Logout button

## Future Enhancements

- [ ] Auto-token refresh when expired
- [ ] Connection retry with backoff
- [ ] Multi-relay server support
- [ ] Import/export settings

## Support

For issues or questions:
- GitHub: https://github.com/railsblueprint/chrome-mcp
- Documentation: https://docs.claude.com/en/docs/claude-code/mcp-server-chrome
