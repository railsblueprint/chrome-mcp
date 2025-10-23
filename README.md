# Blueprint MCP for Chrome

> Control your real Chrome browser with AI through the Model Context Protocol

[![npm version](https://badge.fury.io/js/@railsblueprint%2Fchrome-mcp.svg)](https://www.npmjs.com/package/@railsblueprint/chrome-mcp)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

## What is this?

An MCP (Model Context Protocol) server that lets AI assistants control your actual Chrome browser through a browser extension. Unlike headless automation tools, this uses your real browser profile with all your logged-in sessions, cookies, and extensions intact.

**Perfect for:** AI agents that need to interact with sites where you're already logged in, or that need to avoid bot detection.

## Why use this instead of Playwright/Puppeteer?

| Blueprint MCP for Chrome | Playwright/Puppeteer |
|-------------------------|---------------------|
| ✅ Real browser (not headless) | ❌ Headless or new browser instance |
| ✅ Stays logged in to all your sites | ❌ Must re-authenticate each session |
| ✅ Avoids bot detection (uses real fingerprint) | ⚠️ Often detected as automated browser |
| ✅ Works with your existing browser extensions | ❌ No extension support |
| ✅ Zero setup - works out of the box | ⚠️ Requires browser installation |
| ❌ Chrome/Edge only | ✅ Chrome, Firefox, Safari support |

## Installation

### 1. Install the MCP Server

```bash
npm install -g @railsblueprint/chrome-mcp
```

### 2. Install the Chrome Extension

**Option A: Chrome Web Store (Recommended)**
- Visit: [Chrome Web Store link - Coming Soon]

**Option B: Manual Installation (Development)**
1. Download the latest release from [Releases](https://github.com/railsblueprint/chrome-mcp/releases)
2. Unzip the extension
3. Open `chrome://extensions/`
4. Enable "Developer mode"
5. Click "Load unpacked" and select the `extension` folder

### 3. Configure your MCP client

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "chrome": {
      "command": "chrome-mcp"
    }
  }
}
```

**VS Code / Cursor** (`.vscode/settings.json`):
```json
{
  "mcp.servers": {
    "chrome": {
      "command": "chrome-mcp"
    }
  }
}
```

**Cline** (Claude Code CLI):
```bash
claude mcp add chrome chrome-mcp
```

## Quick Start

1. **Start your MCP client** (Claude Desktop, Cursor, etc.)
2. **Click the Blueprint MCP extension icon** in Chrome
3. The extension auto-connects to the MCP server
4. **Ask your AI assistant to browse!**

**Example conversations:**
```
You: "Go to GitHub and check my notifications"
AI: *navigates to github.com, clicks notifications, reads content*

You: "Fill out this form with my info"
AI: *reads form fields, fills them in, submits*

You: "Take a screenshot of this page"
AI: *captures screenshot and shows you*
```

## How it works

```
┌─────────────────────────┐
│   AI Assistant          │
│   (Claude, GPT, etc)    │
└───────────┬─────────────┘
            │
            │ MCP Protocol
            ↓
┌─────────────────────────┐
│   MCP Client            │
│   (Claude Desktop, etc) │
└───────────┬─────────────┘
            │
            │ stdio/JSON-RPC
            ↓
┌─────────────────────────┐
│   chrome-mcp            │
│   (this package)        │
└───────────┬─────────────┘
            │
            │ WebSocket (localhost:5555 or cloud relay)
            ↓
┌─────────────────────────┐
│   Chrome Extension      │
└───────────┬─────────────┘
            │
            │ Chrome Extension APIs
            ↓
┌─────────────────────────┐
│   Your Chrome Browser   │
│   (real profile)        │
└─────────────────────────┘
```

## Free vs PRO

### Free Tier (Default)
- ✅ Local WebSocket connection (port 5555)
- ✅ Single browser instance
- ✅ All browser automation features
- ✅ No account required
- ❌ Limited to same machine

### PRO Tier
- ✅ **Cloud relay** - connect from anywhere
- ✅ **Multiple browsers** - control multiple Chrome instances
- ✅ **Shared access** - multiple AI clients can use same browser
- ✅ **Auto-reconnect** - maintains connection through network changes
- ✅ **Priority support**

[Upgrade to PRO](https://mcp-for-chrome.railsblueprint.com)

## Available Tools

The MCP server provides these tools to AI assistants:

### Connection Management
- `enable` - Activate browser automation (required first step)
- `disable` - Deactivate browser automation
- `status` - Check connection status
- `auth` - Login to PRO account (for cloud relay features)

### Tab Management
- `browser_tabs` - List, create, attach to, or close browser tabs

### Navigation
- `browser_navigate` - Navigate to a URL
- `browser_navigate_back` - Go back in history

### Content & Inspection
- `browser_snapshot` - Get accessible page content (recommended for reading pages)
- `browser_take_screenshot` - Capture visual screenshot
- `browser_console_messages` - Get browser console logs
- `browser_network_requests` - Get comprehensive network activity including:
  - Request/response headers
  - Request bodies (POST data)
  - Response bodies (JSON, text, etc.)
  - HTTP status codes and timing
- `browser_extract_content` - Extract page content as markdown

### Interaction
- `browser_interact` - Perform multiple actions in sequence (click, type, hover, wait, etc.)
- `browser_click` - Click on elements
- `browser_type` - Type text into inputs
- `browser_hover` - Hover over elements
- `browser_select_option` - Select dropdown options
- `browser_fill_form` - Fill multiple form fields at once
- `browser_press_key` - Press keyboard keys
- `browser_drag` - Drag and drop elements

### Advanced
- `browser_evaluate` - Execute JavaScript in page context
- `browser_handle_dialog` - Handle alert/confirm/prompt dialogs
- `browser_file_upload` - Upload files through file inputs
- `browser_window` - Resize, minimize, maximize browser window
- `browser_pdf_save` - Save current page as PDF
- `browser_performance_metrics` - Get performance metrics
- `browser_verify_text_visible` - Verify text is present (for testing)
- `browser_verify_element_visible` - Verify element exists (for testing)

### Extension Management
- `browser_list_extensions` - List installed Chrome extensions
- `browser_reload_extensions` - Reload extension (useful during development)

## Development

### Prerequisites
- Node.js 18+
- Chrome or Edge browser
- npm or yarn

### Setup

```bash
# Clone the repository
git clone https://github.com/railsblueprint/chrome-mcp.git
cd chrome-mcp

# Install server dependencies
npm install

# Install extension dependencies
cd extension
npm install
cd ..
```

### Running in Development

**Terminal 1: Start MCP server in debug mode**
```bash
node cli.js --debug
```

**Terminal 2: Build extension**
```bash
cd extension
npm run build
# or for watch mode:
npm run dev
```

**Chrome: Load unpacked extension**
1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extension/dist` folder

### Project Structure

```
chrome-mcp/
├── cli.js                      # MCP server entry point
├── src/
│   ├── statefulBackend.js      # Connection state management
│   ├── unifiedBackend.js       # MCP tool implementations
│   ├── extensionServer.js      # WebSocket server for extension
│   ├── mcpConnection.js        # Proxy/relay connection handling
│   ├── transport.js            # Transport abstraction layer
│   └── oauth.js                # OAuth2 client for PRO features
├── extension/
│   └── src/
│       ├── background.ts       # Extension service worker
│       ├── relayConnection.ts  # WebSocket client
│       └── utils/              # Utility functions
└── tests/                      # Test suites
```

### Testing

```bash
# Run tests
npm test

# Run with coverage
npm run test:coverage
```

## Configuration

The server works out-of-the-box with sensible defaults. For advanced configuration:

### Environment Variables

Create a `.env` file in the project root:

```bash
# Authentication server (PRO features)
AUTH_BASE_URL=https://mcp-for-chrome.railsblueprint.com

# Local WebSocket port (Free tier)
MCP_PORT=5555

# Debug mode
DEBUG=false
```

### Command Line Options

```bash
chrome-mcp --debug          # Enable verbose logging
```

## Troubleshooting

### Extension won't connect
1. Check the extension is installed and enabled
2. Click the extension icon - it should show "Connected"
3. Check the MCP server is running (look for process on port 5555)
4. Try reloading the extension

### "Port 5555 already in use"
Another instance is running. Find and kill it:
```bash
lsof -ti:5555 | xargs kill -9
```

### Browser tools not working
1. Make sure you've called `enable` first
2. Check you've attached to a tab with `browser_tabs`
3. Verify the tab still exists (wasn't closed)

### Getting help
- [GitHub Issues](https://github.com/railsblueprint/chrome-mcp/issues)
- [Documentation](https://mcp-for-chrome.railsblueprint.com/docs)

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Security

This tool gives AI assistants control over your browser. Please review:
- The MCP server only accepts local connections by default (localhost:5555)
- PRO relay connections are authenticated via OAuth
- The extension requires explicit user action to connect
- All browser actions go through Chrome's permission system

Found a security issue? Please email security@railsblueprint.com instead of filing a public issue.

## Credits

This project was originally inspired by Microsoft's Playwright MCP implementation but has been completely rewritten to use Chrome extension-based automation instead of Playwright. The architecture, implementation, and approach are fundamentally different.

**Key differences:**
- Uses Chrome DevTools Protocol via extension (not Playwright)
- Works with real browser profiles (not isolated contexts)
- WebSocket-based communication (not CDP relay)
- Cloud relay option for remote access
- Free and PRO tier model

We're grateful to the Playwright team for pioneering browser automation via MCP.

## License

Apache License 2.0 - see [LICENSE](LICENSE)

Copyright (c) 2024 Rails Blueprint

---

**Built with ❤️ by [Rails Blueprint](https://railsblueprint.com)**

[Website](https://mcp-for-chrome.railsblueprint.com) •
[GitHub](https://github.com/railsblueprint/chrome-mcp) •
[NPM](https://www.npmjs.com/package/@railsblueprint/chrome-mcp)
