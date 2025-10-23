# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Blueprint MCP for Chrome is an MCP (Model Context Protocol) server + Chrome extension that allows AI applications to automate a user's existing browser session. Unlike typical browser automation tools, this project uses the user's real browser profile to maintain logged-in sessions and avoid bot detection.

**Current Version:** 1.0.0

**Key Features:**
- Fast local automation without network latency
- Private - browser activity stays on device
- Uses existing browser profile and logged-in sessions
- Stealth mode - uses real browser fingerprint to avoid bot detection

**Credits:** Originally inspired by Microsoft's Playwright MCP, but completely rewritten for Chrome extension-based automation

## Development Commands

### Server Development
```bash
# Run MCP server in debug mode
node cli.js --debug

# Test the server
npm test
```

### Extension Development
```bash
cd extension

# Install dependencies
npm install

# Build extension
npm run build

# Watch mode for development
npm run dev

# Load unpacked extension from extension/dist/
```

## Architecture Overview

### Technology Stack
- **Server Runtime:** Node.js
- **Server Language:** JavaScript (ES6+)
- **Extension Language:** TypeScript
- **MCP SDK:** @modelcontextprotocol/sdk v1.17+
- **Communication:** WebSocket (ws v8.18+)
- **CLI:** Commander v14.0+
- **Extension Build:** Vite

### Project Structure

```
chrome-mcp/
├── cli.js                      # MCP server entry point
├── src/
│   ├── statefulBackend.js      # Connection state management (passive/active/connected)
│   ├── unifiedBackend.js       # MCP tool implementations
│   ├── extensionServer.js      # WebSocket server for extension (port 5555)
│   ├── mcpConnection.js        # Proxy/relay connection handling
│   ├── transport.js            # DirectTransport / ProxyTransport abstraction
│   └── oauth.js                # OAuth2 client for PRO features
├── extension/
│   └── src/
│       ├── background.ts       # Extension service worker
│       ├── relayConnection.ts  # WebSocket client to MCP server
│       ├── content-script.ts   # Page content injection
│       └── utils/
│           ├── jwt.ts          # JWT decoding (not validation)
│           ├── clientId.ts     # Client ID generation
│           └── snapshotFormatter.ts  # DOM snapshot formatting
└── tests/                      # Test suites
```

### Key Architectural Patterns

**Stateful Backend Pattern:**
The project uses a stateful connection model:
1. **Passive state:** Server started, no connections active
2. **Active state:** WebSocket server running (port 5555) or proxy connected
3. **Connected state:** Extension connected, tools available

Transitions:
- `enable` tool → passive → active (starts WebSocket server or connects to proxy)
- Extension connects → active → connected (tools become available)
- `disable` tool → connected → passive (closes everything)

**Two Connection Modes:**

**Free Mode (Direct):**
- ExtensionServer creates WebSocket server on localhost:5555
- Extension connects directly to local server
- DirectTransport handles communication
- No authentication required

**PRO Mode (Proxy):**
- OAuth2Client handles authentication
- MCPConnection connects to cloud relay server
- ProxyTransport forwards commands through relay
- Supports multiple browsers and remote access

**Tool Architecture:**
- UnifiedBackend implements all browser_ tools
- Tools use Transport abstraction (works with both Direct and Proxy modes)
- State management in StatefulBackend tracks connection, browser, and tab state
- Status header shows current state in tool responses

### Tool Implementation Pattern

Tools are implemented in UnifiedBackend:
```javascript
// In unifiedBackend.js
async callTool(name, args) {
  // Send command through transport (Direct or Proxy)
  const result = await this._transport.sendCommand(method, params);

  // Return MCP-compatible response
  return {
    content: [{
      type: "text",
      text: statusHeader + resultText
    }]
  };
}
```

**Transport Abstraction:**
```javascript
// DirectTransport - uses ExtensionServer
class DirectTransport {
  async sendCommand(method, params) {
    return await this._extensionServer.sendCommand(method, params);
  }
}

// ProxyTransport - uses MCPConnection
class ProxyTransport {
  async sendCommand(method, params) {
    return await this._mcpConnection.sendRequest(method, params);
  }
}
```

### Key Dependencies

**Server:**
- `@modelcontextprotocol/sdk` - MCP protocol implementation
- `ws` - WebSocket server
- `commander` - CLI argument parsing
- `dotenv` - Environment configuration
- `playwright` - Used for some browser utilities (minimal usage)

**Extension:**
- Chrome Extensions API - Browser control
- Vite - Build system
- TypeScript - Type safety

## Connection Flow

### Free Mode (Direct Connection)
1. MCP client starts `chrome-mcp` server → **passive state**
2. User calls `enable` tool → Server starts WebSocket on port 5555 → **active state**
3. Extension auto-connects to localhost:5555 → **connected state**
4. Tools like `browser_tabs`, `browser_navigate` become available
5. Extension executes commands and returns results

### PRO Mode (Proxy Connection)
1. User calls `auth action='login'` → Browser opens, user logs in
2. OAuth tokens stored locally
3. User calls `enable` tool → Server connects to cloud relay
4. If multiple browsers available → user picks with `browser_connect`
5. Extension connects to relay → **connected state**
6. Same tool flow as Free mode, but through relay

If tools called before `enable`: Error message tells user to call `enable` first

## Exit Handling

The server implements graceful shutdown:
- Listens for SIGINT and SIGTERM signals
- Closes active connections (extension or proxy)
- Stops WebSocket server if running
- Allows 5 seconds for cleanup before force-exit

## Important Implementation Details

**Why JavaScript for server?**
- Rapid prototyping and iteration (you built this in 6 days!)
- Node.js native module compatibility
- Extension is TypeScript for type safety in browser APIs

**State Management:**
StatefulBackend manages complex state machine:
- Connection states (passive/active/connected/authenticated_waiting)
- Browser info (name, connection status)
- Tab attachment (current tab index, title, URL)
- Reconnection logic (remembers last browser/tab)

**Error Handling:**
- Tools return user-friendly error messages with status headers
- Infinite retry loops with 1-second intervals (aggressive reconnection)
- No JWT validation (tokens only used between your own services)
