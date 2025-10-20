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
2. **Unidirectional Requests**: Clients send requests, proxy responds (except for pass-through)
3. **ID Namespacing**: Different ID formats prevent collisions in bidirectional forwarding
4. **Stateful Connections**: WebSocket connections maintain authentication state

## ID Format Requirements

**CRITICAL**: To prevent ID collisions during message forwarding, the following ID formats MUST be used:

| Sender | ID Format | Example | Notes |
|--------|-----------|---------|-------|
| MCP Client | Unprefixed number or UUID | `1`, `2`, `"550e8400-..."` | Any format except "ext:" or "proxy:" prefix |
| Browser Extension | String with `"ext:"` prefix | `"ext:1"`, `"ext:2"` | MUST prefix all client-initiated request IDs |
| Proxy Server | String with `"proxy:"` prefix | `"proxy:1"`, `"proxy:auth"` | MUST prefix all server-initiated request IDs |

**Rationale**: When proxy forwards MCP requests to Extension, both use the same WebSocket. Without namespacing, MCP's `id:1` could collide with Extension's `id:1`.

## Connection Phase

### 1. Extension Connection

**1.1. Extension Connects to Proxy**
```
Extension → Proxy: WebSocket connection to wss://proxy.example.com/extension
```

**1.2. Proxy Requests Authentication**
```json
Proxy → Extension:
{
  "jsonrpc": "2.0",
  "id": "proxy:auth",
  "method": "authenticate",
  "params": {}
}
```

**1.3. Extension Sends Credentials**
```json
Extension → Proxy:
{
  "jsonrpc": "2.0",
  "id": "proxy:auth",
  "result": {
    "name": "Chrome 141",
    "accessToken": "eyJhbGci..."
  }
}
```

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

### 2. MCP Client Connection

**2.1. MCP Client Connects to Proxy**
```
MCP → Proxy: WebSocket connection to wss://proxy.example.com/mcp
```

**2.2. Proxy Requests Authentication**
```json
Proxy → MCP:
{
  "jsonrpc": "2.0",
  "id": "proxy:auth",
  "method": "authenticate",
  "params": {}
}
```

**2.3. MCP Client Sends Credentials**
```json
MCP → Proxy:
{
  "jsonrpc": "2.0",
  "id": "proxy:auth",
  "result": {
    "accessToken": "eyJhbGci..."
  }
}
```

**2.4. Proxy Confirms Authentication (Notification)**
```json
Proxy → MCP:
{
  "jsonrpc": "2.0",
  "method": "authenticated",
  "params": {
    "user_id": "83898119-db4f-4848-9d27-ea328b73a4df",
    "mcp_client_id": "mcp-82f7a8c6-b7f3-4ced-a759-27cb08f59619"
  }
}
```

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

Methods handled directly by the proxy (not forwarded):

| Method | Direction | Description |
|--------|-----------|-------------|
| `authenticate` | Proxy → Client | Request authentication credentials (initiated by proxy) |
| `list_extensions` | Client → Proxy | Get list of available extensions |
| `connect` | Client → Proxy | Establish connection to specific extension |
| `disconnect` | Client → Proxy | Close connection to extension |

## Forwarded Methods

All other methods are forwarded through the proxy to the connected extension:

| Category | Methods |
|----------|---------|
| Tab Management | `createTab`, `getTabs`, `selectTab`, `activateTab`, `closeTab` |
| Navigation | `browser_navigate`, `goBack`, `goForward` |
| CDP Commands | `forwardCDPCommand` (all Chrome DevTools Protocol methods) |
| Interaction | `click`, `type`, `hover`, `screenshot` |

The proxy passes these through without modification (except removing `connectionId`).

## Connection Lifecycle

```
1. Client connects via WebSocket
2. Proxy sends authenticate request with id="proxy:auth"
3. Client responds with credentials using id="proxy:auth"
4. Proxy validates credentials and sends authenticated notification (no id)
5. [For MCP only] Client requests list_extensions (id=1, 2, etc.)
6. [For MCP only] Client requests connect to extension (id=N)
7. Proxy forwards messages bidirectionally:
   - MCP → Proxy → Extension (removes connectionId)
   - Extension → Proxy → MCP (adds connectionId based on mapping)
8. Either side can close connection
9. Proxy sends disconnected notification to other side
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

**ID Format:**
- Use unprefixed numeric IDs: `1`, `2`, `3...`
- OR use UUIDs: `"550e8400-e29b-41d4-a716-446655440000"`
- NEVER use `"ext:"` or `"proxy:"` prefixes

**Connection:**
```javascript
// 1. Wait for proxy's authenticate request
onMessage(msg => {
  if (msg.id === "proxy:auth" && msg.method === "authenticate") {
    send({ id: "proxy:auth", result: { accessToken: token }});
  }
});

// 2. Wait for authenticated notification
onMessage(msg => {
  if (msg.method === "authenticated") {
    // Now can list extensions and connect
  }
});

// 3. List and connect
send({ id: 1, method: "list_extensions", params: {}});
send({ id: 2, method: "connect", params: { extension_id: "ext-..." }});

// 4. Include connectionId in all forwarded commands
send({
  id: 3,
  method: "createTab",
  params: {...},
  connectionId: "conn-..."  // From connect response
});
```

**Key Points:**
- Always include `connectionId` in forwarded commands (after connect)
- Handle `authenticated` and `disconnected` notifications
- Reconnect on connection loss
- One active connection per MCP instance

### For Browser Extensions

**ID Format:**
- Use `"ext:"` prefixed IDs for any client-initiated requests: `"ext:1"`, `"ext:2"`, `"ext:3"`
- Respond to proxy requests using the same ID proxy sent

**Connection:**
```javascript
// 1. Wait for proxy's authenticate request
onMessage(msg => {
  if (msg.id === "proxy:auth" && msg.method === "authenticate") {
    send({
      id: "proxy:auth",  // Same ID as request
      result: {
        name: "Chrome 141",
        accessToken: token
      }
    });
  }
});

// 2. Handle forwarded commands from MCP
onMessage(msg => {
  if (msg.id && msg.method && msg.id !== "proxy:auth") {
    // This is a forwarded command from MCP
    handleCommand(msg.method, msg.params).then(result => {
      send({ id: msg.id, result: result || {} });  // ALWAYS include result
    }).catch(error => {
      send({ id: msg.id, error: { code: -32000, message: error.message }});
    });
  }
});
```

**CRITICAL:** Never send `{"id": "..."}` alone. Always include `result` or `error`:
```javascript
// ✅ CORRECT
send({ id: msg.id, result: {} });  // Empty result is valid
send({ id: msg.id, result: { data: "..." }});
send({ id: msg.id, error: { code: -32000, message: "..." }});

// ❌ WRONG
send({ id: msg.id });  // Missing result/error!
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
