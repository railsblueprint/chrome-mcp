# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Browser MCP is an MCP (Model Context Protocol) server + Chrome extension that allows AI applications to automate a user's existing browser session. Unlike typical browser automation tools, this project uses the user's real browser profile to maintain logged-in sessions and avoid bot detection.

**Current Version:** 0.1.3

**Key Features:**
- Fast local automation without network latency
- Private - browser activity stays on device
- Uses existing browser profile and logged-in sessions
- Stealth mode - uses real browser fingerprint to avoid bot detection

**Credits:** Adapted from Microsoft's Playwright MCP server

## Development Commands

### Build and Development
```bash
# Type checking
npm run typecheck

# Build the project
npm run build

# Watch mode for development
npm run watch

# Run MCP inspector for debugging
npm run inspector
```

### Build Output
The build process:
- Compiles TypeScript to ESM format using tsup
- Outputs to `dist/` directory
- Makes the output executable via shx

## Architecture Overview

### Technology Stack
- **Runtime:** Node.js with ESM modules
- **Language:** TypeScript 5.6.2
- **MCP SDK:** @modelcontextprotocol/sdk v1.8.0
- **Communication:** WebSocket (ws v8.18.1)
- **Validation:** Zod v3.24.2
- **CLI:** Commander v13.1.0

### Project Structure

```
src/
├── index.ts           # Entry point, CLI setup, tool registration
├── server.ts          # MCP server creation and request handling
├── context.ts         # Context class managing WebSocket connections
├── ws.ts              # WebSocket server creation
├── tools/             # MCP tool implementations
│   ├── tool.ts        # Tool type definitions
│   ├── common.ts      # Navigation, wait, keyboard tools
│   ├── snapshot.ts    # DOM interaction tools (click, type, hover, etc.)
│   └── custom.ts      # Console logs and screenshot tools
├── resources/         # MCP resources
└── utils/             # Utilities (ARIA snapshot, logging, port management)
```

### Key Architectural Patterns

**MCP Server Pattern:**
The project implements the Model Context Protocol server pattern:
1. Server exposes tools and resources to MCP clients
2. Client calls tools via MCP protocol
3. Server forwards commands to browser via WebSocket
4. Browser extension executes commands in the actual browser tab

**WebSocket Communication:**
- Server creates WebSocket server on startup (default port from config)
- Chrome extension connects to WebSocket
- Context class manages connection state and message passing
- Only one active connection at a time (new connections close previous ones)

**Tool Registration:**
Tools are organized into categories and registered in `index.ts`:
- **Common Tools:** pressKey, wait
- **Custom Tools:** getConsoleLogs, screenshot
- **Snapshot Tools:** navigate, goBack, goForward, snapshot, click, hover, type, selectOption

Each tool:
- Has a Zod schema for validation (from `@repo/types/mcp/tool`)
- Implements a handle function that receives Context and params
- Returns MCP-compatible result with text/image content

**Context Class:**
Central class managing WebSocket connection:
- Stores active WebSocket connection
- Provides `sendSocketMessage()` method for type-safe messaging
- Throws helpful error if no browser connection exists
- Handles connection cleanup

### Tool Implementation Pattern

Tools follow this pattern:
```typescript
export const toolName: Tool = {
  schema: {
    name: ToolNameTool.shape.name.value,
    description: ToolNameTool.shape.description.value,
    inputSchema: zodToJsonSchema(ToolNameTool.shape.arguments),
  },
  handle: async (context: Context, params) => {
    const validatedParams = ToolNameTool.shape.arguments.parse(params);
    await context.sendSocketMessage("message_type", validatedParams);
    return {
      content: [{ type: "text", text: "Result message" }],
    };
  },
};
```

**Snapshot Tools:**
Most interaction tools (click, type, hover) automatically capture an ARIA snapshot after executing the action, providing the AI with the updated DOM state.

### Dependencies on Workspace Packages

This package depends on several workspace packages (currently not buildable standalone):
- `@r2r/messaging` - WebSocket message sender
- `@repo/config` - App and MCP configuration
- `@repo/messaging` - Message type definitions
- `@repo/types` - TypeScript types for messages and tools
- `@repo/utils` - Utility functions

## Connection Flow

1. MCP server starts and creates WebSocket server
2. User clicks Chrome extension icon and clicks "Connect"
3. Extension opens WebSocket connection to server
4. AI client calls MCP tools
5. Server forwards commands to browser via WebSocket
6. Extension executes commands in the active browser tab
7. Results return through the same path

If no connection exists, tools throw error: "No connection to browser extension. In order to proceed, you must first connect a tab..."

## Exit Handling

The server implements an exit watchdog that:
- Listens for stdin close events
- Allows 15 seconds for graceful shutdown
- Closes server, WebSocket server, and context
- Forces exit if cleanup takes too long

## Path Aliases

TypeScript is configured with path alias:
- `@/*` maps to `./src/*`

Use this alias consistently when importing from src directory.
