# Browser MCP Proxy Protocol

Simple WebSocket proxy that connects multiple MCP clients with browser extensions.

## Architecture

```
MCP Client A ──┐
               ├──→ Proxy ──→ Extension (Tab 1, Tab 2, ...)
MCP Client B ──┘
```

The proxy is a message router that:
- Registers extensions and MCP clients
- Creates connections between MCP clients and extension tabs
- Routes messages using connection IDs
- Handles disconnections

## Message Format

All messages are JSON with optional `connectionId` for routing:

```json
{
  "method": "method_name",
  "params": { ... },
  "connectionId": "conn-uuid-1234"  // For routing after connection established
}
```

## Connection Flow

### 1. Extension Connects

Extension opens WebSocket and sends:

```json
{
  "method": "extension_handshake",
  "params": {
    "name": "Chrome 141"
  }
}
```

No response needed. Proxy registers extension and assigns `extensionId`.

### 2. MCP Client Connects

MCP client opens WebSocket and sends:

```json
{
  "method": "mcp_handshake",
  "params": {
    "projectName": "my-project"
  }
}
```

No response needed. Proxy registers MCP client and assigns `mcpClientId`.

### 3. MCP Requests Extension List

```json
{
  "method": "list_extensions",
  "params": {}
}
```

Response:

```json
{
  "extensions": [
    {
      "id": "ext-uuid-1234",
      "name": "Chrome 141",
      "connected": true
    }
  ]
}
```

### 4. MCP Connects to Extension Tab

MCP requests connection to specific extension (and optionally specific tab):

```json
{
  "method": "connect",
  "params": {
    "extensionId": "ext-uuid-1234",
    "tabId": 123  // Optional: specific tab, or omit to let extension create new tab
  }
}
```

Response on success:

```json
{
  "success": true,
  "connectionId": "conn-uuid-5678"
}
```

Response on failure:

```json
{
  "success": false,
  "error": "Extension disconnected"
}
```

The `connectionId` is used for all subsequent messages to route between this MCP client and the connected tab.

### 5. Message Routing with Connection ID

**MCP → Extension:** All messages include `connectionId` for routing

```json
{
  "method": "forwardCDPCommand",
  "connectionId": "conn-uuid-5678",
  "params": {
    "method": "Page.navigate",
    "params": { "url": "https://example.com" }
  }
}
```

Proxy routes to the extension tab associated with `conn-uuid-5678`.

**Extension → MCP:** Extension sends CDP events with tab info, proxy adds `connectionId`

Extension sends:
```json
{
  "method": "forwardCDPEvent",
  "params": {
    "tabId": 123,
    "method": "Page.loadEventFired",
    "params": { ... }
  }
}
```

Proxy finds the MCP client connected to this extension+tab, adds `connectionId`, and forwards:
```json
{
  "method": "forwardCDPEvent",
  "connectionId": "conn-uuid-5678",
  "params": { ... }
}
```

### 6. Multiple Connections

The same extension can serve multiple MCP clients on different tabs:

```
MCP Client A (conn-123) → Extension Tab 1
MCP Client B (conn-456) → Extension Tab 2
MCP Client C (conn-789) → Extension Tab 3
```

Each connection has unique `connectionId`. Messages are routed based on:
- MCP → Extension: by `connectionId` in message
- Extension → MCP: by `tabId` in message (proxy maps tabId → connectionId)

### 7. Disconnection Handling

If MCP client disconnects:
- Proxy removes the connection mapping
- Extension tab can stay open (may be used by another MCP client)

If extension disconnects:
- Proxy sends error to all MCP clients connected to this extension:

```json
{
  "connectionId": "conn-uuid-5678",
  "error": "Extension disconnected"
}
```

## Implementation Notes

### Proxy State Management

For each connection, proxy stores:

```typescript
{
  connectionId: string;      // "conn-uuid-5678"
  mcpClientId: string;       // Which MCP client WebSocket
  extensionId: string;       // Which extension WebSocket
  tabId: number | null;      // Which browser tab (null until first message from extension)
}
```

### Routing Logic

**MCP → Extension:**
1. Find connection by `connectionId` in message
2. Forward message to extension WebSocket
3. Extension uses tabId from its internal state

**Extension → MCP:**
1. Extract `tabId` from CDP event params
2. Find connection by `extensionId` + `tabId`
3. Add `connectionId` to message
4. Forward to MCP client WebSocket

### Connection Lifecycle

```
1. Extension connects → assigned extensionId
2. MCP client connects → assigned mcpClientId
3. MCP calls "connect" → create connectionId, map (mcpClientId, extensionId, tabId)
4. Messages flow with connectionId routing
5. Disconnect → remove mapping
```
