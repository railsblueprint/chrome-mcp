# MCP Proxy Protocol Specification

**Version:** 1.0
**Protocol:** JSON-RPC 2.0
**Transport:** WebSocket
**Date:** 2025-10-20

## Overview

This protocol enables MCP (Model Context Protocol) servers to communicate with browser extensions through a central proxy server. The proxy routes messages between MCP clients and browser extensions while maintaining proper authentication and connection isolation.

## Architecture

```
MCP Client <--JSON-RPC--> Proxy Server <--JSON-RPC--> Browser Extension
```

- **MCP Client**: Automation tool (e.g., Claude Desktop, npx chrome-mcp)
- **Proxy Server**: Central routing and authentication server
- **Browser Extension**: Chrome/Edge extension running in user's browser

## Protocol Design Principles

1. **JSON-RPC 2.0 Compliant**: All communication follows JSON-RPC 2.0 specification
2. **Clear Roles**:
   - **Extension**: ALWAYS passive (server) - only responds to requests, never initiates
   - **MCP Client**: ALWAYS active (client) - initiates all requests
   - **Proxy**: Router - responds to control methods, forwards tool methods
3. **ID Mapping**: Proxy maps request IDs to prevent collisions when multiple MCPs connect to same extension
   - MCP sends: `{"id": 1, ...}`
   - Proxy forwards: `{"id": "conn-A:1", ...}` (adds connectionId prefix)
   - Extension responds: `{"id": "conn-A:1", ...}` (preserves mapped ID)
   - Proxy unmaps: `{"id": 1, ...}` (removes prefix before sending to MCP)
4. **Backward Compatible**: Extension can detect direct mode vs proxy mode by ID format
5. **Stateful Connections**: WebSocket connections maintain authentication state

## ID Format Requirements and Mapping

### MCP Client IDs
- **Format**: Unprefixed number or UUID
- **Examples**: `1`, `2`, `3`, `"550e8400-e29b-41d4-a716-446655440000"`
- **No changes needed**: Works in both direct and proxy modes

### Proxy Server IDs
- **Format**: String with `"proxy:"` prefix
- **Examples**: `"proxy:1"`, `"proxy:auth"`
- **Usage**: Only for proxy-initiated requests (e.g., authenticate)

### ID Mapping by Proxy

When forwarding MCP requests to Extension, proxy MUST map IDs to prevent collisions:

**Problem**: Multiple MCPs can send same ID
```
MCP-A sends: {"id": 1, "method": "navigate", ...}
MCP-B sends: {"id": 1, "method": "click", ...}  ← Collision!
```

**Solution**: Proxy prefixes IDs with connectionId
```
MCP-A → Proxy:
  {"id": 1, "method": "navigate", "connectionId": "conn-abc"}

Proxy → Extension (maps ID):
  {"id": "conn-abc:1", "method": "navigate"}

Extension → Proxy:
  {"id": "conn-abc:1", "result": {...}}

Proxy → MCP-A (unmaps ID):
  {"id": 1, "result": {...}}
```

### Extension ID Parsing

Extension detects mode by ID format:
- **Direct mode**: Numeric ID (`1`, `2`, `3`) - single MCP connection
- **Proxy mode**: String with `:` separator (`"conn-abc:1"`) - multiple MCP connections
- **Proxy control**: String with `"proxy:"` prefix (`"proxy:1"`) - proxy-initiated requests

Extension ALWAYS responds with the SAME ID it received (never generates new IDs).

## Connection Phase

### 1. Extension Connection (Extension is Passive)

**1.1. Extension Connects and Waits**
```
Extension → Proxy: WebSocket connection to wss://proxy.example.com/extension
```
Extension does NOT send handshake. It waits passively for proxy to request auth.

**1.2. Proxy Requests Authentication**
```json
Proxy → Extension:
{
  "jsonrpc": "2.0",
  "id": "proxy:1",
  "method": "authenticate",
  "params": {}
}
```
Proxy initiates the authentication request using `id: "proxy:1"`.

**1.3. Extension Responds with Credentials**
```json
Extension → Proxy:
{
  "jsonrpc": "2.0",
  "id": "proxy:1",
  "result": {
    "name": "Chrome 141",
    "accessToken": "eyJhbGci..."
  }
}
```
Extension responds to proxy's request using the same `id`.

**1.4. Proxy Confirms Authentication (Notification)**
```json
Proxy → Extension:
{
  "jsonrpc": "2.0",
  "method": "authenticated",
  "params": {
    "user_id": "83898119-db4f-4848-9d27-ea328b73a4df",
    "extension_id": "ext-d1cdb70b-b20a-46ed-8fa7-7597a0f2837a"
  }
}
```
Note: No `id` field = notification (no response expected)

After this, Extension remains passive and only responds to:
- Control requests from Proxy (if any)
- Forwarded tool requests from MCP (via Proxy)

### 2. MCP Client Connection (MCP is Active)

**2.1. MCP Client Connects**
```
MCP → Proxy: WebSocket connection to wss://proxy.example.com/mcp
```

**2.2. MCP Sends Handshake**
```json
MCP → Proxy:
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "mcp_handshake",
  "params": {
    "accessToken": "eyJhbGci..."
  }
}
```
MCP initiates handshake (unlike Extension which waits for proxy).

**2.3. Proxy Responds with Authentication**
```json
Proxy → MCP:
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "authenticated": true,
    "user_id": "83898119-db4f-4848-9d27-ea328b73a4df",
    "mcp_client_id": "mcp-82f7a8c6-b7f3-4ced-a759-27cb08f59619"
  }
}
```
Proxy responds directly (not a notification).

### 3. Extension Discovery

**3.1. MCP Lists Available Extensions**
```json
MCP → Proxy:
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "list_extensions",
  "params": {}
}
```

**3.2. Proxy Returns Extension List**
```json
Proxy → MCP:
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "extensions": [
      {
        "id": "ext-d1cdb70b-b20a-46ed-8fa7-7597a0f2837a",
        "name": "Chrome 141",
        "connected": true
      }
    ]
  }
}
```

### 4. Connection Establishment

**4.1. MCP Connects to Extension**
```json
MCP → Proxy:
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "connect",
  "params": {
    "extension_id": "ext-d1cdb70b-b20a-46ed-8fa7-7597a0f2837a"
  }
}
```

**4.2. Proxy Confirms Connection**
```json
Proxy → MCP:
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "connection_id": "conn-70dfcdd7-ff5e-448e-b274-59c1f6a0d7c8",
    "extension_id": "ext-d1cdb70b-b20a-46ed-8fa7-7597a0f2837a",
    "extension_name": "Chrome 141"
  }
}
```

**Note**: An MCP client can only have ONE active connection at a time. The `connection_id` is returned but MCP implementations typically don't need to track it explicitly - the proxy maintains this mapping internally.

## Message Forwarding Phase

After connection is established, the proxy forwards messages between MCP and Extension:

### Browser Automation Commands

**5.1. MCP Sends Command**
```json
MCP → Proxy:
{
  "jsonrpc": "2.0",
  "id": 100,
  "method": "createTab",
  "params": {
    "url": "https://example.com",
    "stealth": true
  },
  "connectionId": "conn-70dfcdd7-ff5e-448e-b274-59c1f6a0d7c8"
}
```
Note: `connectionId` is included for routing (tells proxy which extension to forward to)

**5.2. Proxy Forwards to Extension** (removes `connectionId`)
```json
Proxy → Extension:
{
  "jsonrpc": "2.0",
  "id": 100,
  "method": "createTab",
  "params": {
    "url": "https://example.com",
    "stealth": true
  }
}
```
Note: Extension doesn't see `connectionId` - it's only for proxy routing

**5.3. Extension Executes and Responds**
```json
Extension → Proxy:
{
  "jsonrpc": "2.0",
  "id": 100,
  "result": {
    "tabId": 42,
    "url": "https://example.com"
  }
}
```
**IMPORTANT**: Extension MUST always include `result` field, even if empty `{}`. Never send `{"id": 100}` alone.

**5.4. Proxy Forwards Response to MCP**
```json
Proxy → MCP:
{
  "jsonrpc": "2.0",
  "id": 100,
  "result": {
    "tabId": 42,
    "url": "https://example.com"
  }
}
```

### Error Handling

**If command fails:**
```json
Extension → Proxy:
{
  "jsonrpc": "2.0",
  "id": 100,
  "error": {
    "code": -32000,
    "message": "Tab creation failed: Permission denied"
  }
}
```

**Proxy forwards error to MCP:**
```json
Proxy → MCP:
{
  "jsonrpc": "2.0",
  "id": 100,
  "error": {
    "code": -32000,
    "message": "Tab creation failed: Permission denied"
  }
}
```

## Notifications (Out-of-Band Messages)

Notifications do not require responses and have **no `id` field**.

### Status Updates

**Proxy → Extension/MCP:**
```json
{
  "jsonrpc": "2.0",
  "method": "status",
  "params": {
    "connected": true,
    "peer_count": 2,
    "timestamp": "2025-10-20T21:43:53.163+0200"
  }
}
```

### Disconnection Notice

**Proxy → MCP (when extension disconnects):**
```json
{
  "jsonrpc": "2.0",
  "method": "disconnected",
  "params": {
    "connection_id": "conn-70dfcdd7-ff5e-448e-b274-59c1f6a0d7c8",
    "reason": "Extension closed"
  }
}
```

## Control Methods

Methods handled directly by the proxy (not forwarded to extension):

### 1. authenticate (Proxy → Extension)

**Request:**
```json
Proxy → Extension:
{
  "jsonrpc": "2.0",
  "id": "proxy:1",
  "method": "authenticate",
  "params": {}
}
```

**Response:**
```json
Extension → Proxy:
{
  "jsonrpc": "2.0",
  "id": "proxy:1",
  "result": {
    "name": "Chrome 141",
    "accessToken": "eyJhbGciOiJIUzI1NiJ9..."
  }
}
```

**Fields:**
- `name` (string, required): Browser name/identifier shown to users
- `accessToken` (string, required): JWT token for authentication

**Errors:**
- Invalid token → Connection closed by proxy

---

### 2. mcp_handshake (MCP → Proxy)

**Request:**
```json
MCP → Proxy:
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "mcp_handshake",
  "params": {
    "accessToken": "eyJhbGciOiJIUzI1NiJ9..."
  }
}
```

**Response (Success):**
```json
Proxy → MCP:
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "authenticated": true,
    "user_id": "83898119-db4f-4848-9d27-ea328b73a4df",
    "mcp_client_id": "mcp-82f7a8c6-b7f3-4ced-a759-27cb08f59619"
  }
}
```

**Response (Error):**
```json
Proxy → MCP:
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32000,
    "message": "Authentication failed: Invalid token"
  }
}
```

**Fields:**
- `accessToken` (string, required): JWT token containing user_id and connection_url

---

### 3. list_extensions (MCP → Proxy)

**Request:**
```json
MCP → Proxy:
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "list_extensions",
  "params": {}
}
```

**Response:**
```json
Proxy → MCP:
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "extensions": [
      {
        "id": "ext-d1cdb70b-b20a-46ed-8fa7-7597a0f2837a",
        "name": "Chrome 141",
        "connected": true
      },
      {
        "id": "ext-a2b3c4d5-e6f7-8901-2345-6789abcdef01",
        "name": "Chrome 140",
        "connected": true
      }
    ]
  }
}
```

**Fields:**
- `extensions` (array, required): List of available browser extensions
  - `id` (string): Unique extension identifier (use for connect)
  - `name` (string): Browser name shown to user
  - `connected` (boolean): Whether extension is currently connected

**Notes:**
- Only returns extensions belonging to authenticated user
- Empty array if no extensions connected

---

### 4. connect (MCP → Proxy)

**Request:**
```json
MCP → Proxy:
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "connect",
  "params": {
    "extension_id": "ext-d1cdb70b-b20a-46ed-8fa7-7597a0f2837a"
  }
}
```

**Response (Success):**
```json
Proxy → MCP:
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "connection_id": "conn-70dfcdd7-ff5e-448e-b274-59c1f6a0d7c8",
    "extension_id": "ext-d1cdb70b-b20a-46ed-8fa7-7597a0f2837a",
    "extension_name": "Chrome 141"
  }
}
```

**Response (Error - Extension not found):**
```json
Proxy → MCP:
{
  "jsonrpc": "2.0",
  "id": 3,
  "error": {
    "code": -32000,
    "message": "Extension not found or not accessible"
  }
}
```

**Response (Error - Already connected):**
```json
Proxy → MCP:
{
  "jsonrpc": "2.0",
  "id": 3,
  "error": {
    "code": -32001,
    "message": "MCP client already connected to an extension"
  }
}
```

**Fields:**
- `extension_id` (string, required): Extension ID from list_extensions
- `connection_id` (string): Unique connection identifier (use in subsequent tool calls)

**Notes:**
- MCP client can only connect to ONE extension at a time
- To switch extensions, disconnect first, then connect to another
- Multiple MCP clients can connect to same extension (different tabs)

---

### 5. disconnect (MCP → Proxy)

**Request:**
```json
MCP → Proxy:
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "disconnect",
  "params": {}
}
```

**Response:**
```json
Proxy → MCP:
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "disconnected": true
  }
}
```

**Notes:**
- Closes current connection to extension
- Does NOT close MCP WebSocket (can connect to another extension)
- Safe to call even if not connected (returns success)

## Forwarded Methods

All other methods are forwarded through the proxy to the connected extension:

| Category | Methods |
|----------|---------|
| Tab Management | `createTab`, `getTabs`, `selectTab`, `activateTab`, `closeTab` |
| Navigation | `browser_navigate`, `goBack`, `goForward` |
| CDP Commands | `forwardCDPCommand` (all Chrome DevTools Protocol methods) |
| Interaction | `click`, `type`, `hover`, `screenshot` |

**IMPORTANT**: MCP clients send standard JSON-RPC requests with numeric IDs. They do NOT include a `connectionId` field. The proxy maintains an internal mapping of which MCP WebSocket is connected to which extension, and performs ID mapping automatically:

1. MCP sends: `{"id": 4, "method": "createTab", "params": {...}}`
2. Proxy looks up connectionId for this MCP's WebSocket (e.g., "conn-abc")
3. Proxy maps ID and forwards: `{"id": "conn-abc:4", "method": "createTab", "params": {...}}`
4. Extension responds: `{"id": "conn-abc:4", "result": {...}}`
5. Proxy unmaps ID and forwards: `{"id": 4, "result": {...}}`

## Connection Lifecycle

### Extension (Passive)
```
1. Extension connects to proxy via WebSocket
2. Extension waits (does NOT send handshake)
3. Proxy sends authenticate request: {"id": "proxy:1", "method": "authenticate", ...}
4. Extension responds with credentials: {"id": "proxy:1", "result": {...}}
5. Proxy sends authenticated notification (no id)
6. Extension waits for forwarded commands from MCP
7. Extension responds to each command with same id
```

### MCP Client (Active)
```
1. MCP connects to proxy via WebSocket
2. MCP sends handshake: {"id": 1, "method": "mcp_handshake", ...}
3. Proxy responds: {"id": 1, "result": {...}}
4. MCP requests list_extensions: {"id": 2, "method": "list_extensions", ...}
5. Proxy responds with list: {"id": 2, "result": {...}}
6. MCP requests connect: {"id": 3, "method": "connect", ...}
7. Proxy responds with connection_id: {"id": 3, "result": {"connection_id": "..."}}
8. MCP sends tool commands: {"id": 4, "method": "createTab", "params": {...}}
9. Proxy maps ID and forwards: {"id": "conn-abc:4", "method": "createTab", "params": {...}}
10. Extension responds: {"id": "conn-abc:4", "result": {...}}
11. Proxy unmaps ID and forwards: {"id": 4, "result": {...}}
```

### Disconnection
```
- If Extension disconnects: Proxy sends notification to MCP
- If MCP disconnects: Connection mapping removed, Extension can serve other MCPs
- Either side can close WebSocket at any time
```

## Error Codes

Standard JSON-RPC 2.0 error codes:

| Code | Meaning | When Used |
|------|---------|-----------|
| -32700 | Parse error | Invalid JSON received |
| -32600 | Invalid Request | Missing required fields (jsonrpc, method, etc.) |
| -32601 | Method not found | Unknown method name |
| -32602 | Invalid params | Wrong parameter types or missing required params |
| -32603 | Internal error | Server-side error during execution |
| -32000 to -32099 | Server error | Application-specific errors (auth failure, routing error, etc.) |

## Authentication

- **Extensions** authenticate with: browser name + access token (JWT)
- **MCP clients** authenticate with: access token (JWT) only
- Access tokens are validated by proxy
- Connection URL is embedded in JWT for MCP clients (determines proxy endpoint)
- Failed authentication results in connection closure

## Security Considerations

1. **TLS Required**: All production deployments MUST use WSS (WebSocket Secure)
2. **Token Validation**: Proxy MUST validate JWT tokens before accepting connections
3. **Isolation**: Proxy MUST ensure MCP clients can only access extensions owned by the same user (validated via JWT user_id)
4. **ID Validation**: Proxy SHOULD validate that forwarded message IDs don't use reserved prefixes
5. **Rate Limiting**: Proxy SHOULD implement rate limiting per user/connection

## Implementation Guidelines

### For MCP Clients

**Role: ALWAYS Active Client**
- MCP initiates ALL requests
- MCP NEVER responds to requests (except in rare control scenarios)
- Proxy either responds directly or forwards to Extension

**ID Format:**
- Use unprefixed numeric IDs: `1`, `2`, `3...`
- OR use UUIDs: `"550e8400-e29b-41d4-a716-446655440000"`
- NEVER use `"ext:"` or `"proxy:"` prefixes

**Connection Flow:**
```javascript
// 1. Connect to proxy
ws = new WebSocket("wss://proxy.example.com/mcp");

// 2. Send handshake (MCP initiates, not proxy!)
ws.onopen = () => {
  send({ id: 1, method: "mcp_handshake", params: { accessToken: token }});
};

// 3. Wait for handshake response
onMessage(msg => {
  if (msg.id === 1 && msg.result) {
    // Authenticated! Can now list extensions and connect
    send({ id: 2, method: "list_extensions", params: {}});
  }
});

// 4. Connect to extension
onMessage(msg => {
  if (msg.id === 2 && msg.result) {
    const extensionId = msg.result.extensions[0].id;
    send({ id: 3, method: "connect", params: { extension_id: extensionId }});
  }
});

// 5. Use connection
onMessage(msg => {
  if (msg.id === 3 && msg.result) {
    connectionId = msg.result.connection_id;  // Store for later

    // Now can send tool commands
    send({
      id: 4,
      method: "createTab",
      params: { url: "..." },
      connectionId: connectionId
    });
  }
});
```

**Key Points:**
- MCP initiates handshake (not proxy!)
- Always include `connectionId` in forwarded commands (after connect)
- Handle `disconnected` notifications
- Reconnect on connection loss
- One active connection per MCP instance

### For Browser Extensions

**Role: ALWAYS Passive Server**
- Extension NEVER initiates requests
- Extension ONLY responds to requests from:
  - Proxy (e.g., authenticate request)
  - MCP via Proxy (e.g., createTab, navigate)
- Extension does NOT send handshake on connect - it waits for proxy's authenticate request

**ID Format:**
- Extension does NOT generate IDs (it never initiates requests)
- Extension responds using the SAME `id` that was in the incoming request
- If Extension needs to initiate (rare), use `"ext:"` prefix: `"ext:1"`, `"ext:2"`

**Connection Flow:**
```javascript
// 1. Connect and wait (do NOT send handshake!)
ws = new WebSocket("wss://proxy.example.com/extension");

ws.onopen = () => {
  // Do NOT send handshake! Wait for proxy to request authentication
  console.log("Connected, waiting for proxy auth request...");
};

// 2. Respond to proxy's authenticate request
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  // Proxy's auth request (id starts with "proxy:")
  if (msg.id && msg.id.startsWith("proxy:") && msg.method === "authenticate") {
    send({
      id: msg.id,  // Use SAME ID from request
      result: {
        name: "Chrome 141",
        accessToken: getStoredToken()
      }
    });
    return;
  }

  // Forwarded command from MCP (numeric id)
  if (msg.id && msg.method) {
    handleCommand(msg.method, msg.params)
      .then(result => {
        send({ id: msg.id, result: result || {} });  // ALWAYS include result
      })
      .catch(error => {
        send({ id: msg.id, error: { code: -32000, message: error.message }});
      });
    return;
  }

  // Notification (no id) - just log
  if (msg.method && !msg.id) {
    console.log("Notification:", msg.method, msg.params);
  }
};
```

**CRITICAL Rules:**
1. **Never initiate requests** - Extension is passive, only responds
2. **Always use same `id`** - Respond with the exact `id` from the incoming request
3. **Never send `{"id": "..."}` alone** - Always include `result` or `error`:

```javascript
// ✅ CORRECT
send({ id: msg.id, result: {} });  // Empty result is valid
send({ id: msg.id, result: { data: "..." }});
send({ id: msg.id, error: { code: -32000, message: "..." }});

// ❌ WRONG
send({ id: msg.id });  // Missing result/error!
send({ id: 1, method: "handshake", ... });  // Extension should NOT send handshake!
```

### For Proxy Servers

**ID Handling:**
- Use `"proxy:"` prefixed IDs for server-initiated requests
- Validate ID format on incoming messages (reject "proxy:" from clients)
- Strip `connectionId` before forwarding to extension
- Preserve message `id` exactly when forwarding
- Map responses back to original requestor by `id`

**Routing Logic:**
```
MCP → Proxy:
  1. Extract connectionId from message
  2. Look up (extensionId, extensionWS) from connection mapping
  3. Remove connectionId field
  4. Forward to extensionWS

Extension → Proxy:
  1. Look up active connection for this extension
  2. Forward to MCP WebSocket
  3. Preserve message id exactly
```

**State Management:**
```javascript
connections = {
  "conn-123": {
    mcpClientWS: <websocket>,
    extensionWS: <websocket>,
    extensionId: "ext-456",
    userId: "user-789"  // From JWT
  }
}
```

## Compatibility

This protocol is designed to be compatible with:
- JSON-RPC 2.0 specification (RFC compliance)
- WebSocket transport (RFC 6455)
- Model Context Protocol (MCP) tool calling
- Chrome DevTools Protocol (CDP)

## Version History

- **1.0** (2025-10-20): Initial JSON-RPC 2.0 specification
  - Replaced legacy protocol with proper JSON-RPC
  - Added ID namespacing to prevent collisions
  - Defined control vs forwarded methods
  - Added authentication flow
  - Specified notification format
