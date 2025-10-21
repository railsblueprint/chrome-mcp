# Blueprint MCP for Chrome

## Introduction

Blueprint MCP for Chrome allows you to connect to pages in your existing browser and leverage the state of your default user profile. This means the AI assistant can interact with websites where you're already logged in, using your existing cookies, sessions, and browser state, providing a seamless experience without requiring separate authentication or setup.

## Prerequisites

- Chrome/Edge/Chromium browser

## Installation Steps

### Download the Extension

Download the latest Chrome extension from GitHub:
- **Download link**: https://github.com/railsblueprint/chrome-mcp/releases

Or install from Chrome Web Store:
- **Chrome Web Store**: https://chromewebstore.google.com/detail/browser-mcp/bjfgambnhccakkhmkepdoekmckoijdlc

### Load Chrome Extension (for development)

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in the top right corner)
3. Click "Load unpacked" and select the extension directory

### Configure Blueprint MCP for Chrome

Configure Blueprint MCP for Chrome by adding it to your MCP settings:

```json
{
  "mcpServers": {
    "chrome-mcp": {
      "command": "npx",
      "args": [
        "@railsblueprint/chrome-mcp@latest"
      ]
    }
  }
}
```

## Usage

### Browser Tab Selection

When the LLM interacts with the browser for the first time, it will load a page where you can select which browser tab the LLM will connect to. This allows you to control which specific page the AI assistant will interact with during the session.


