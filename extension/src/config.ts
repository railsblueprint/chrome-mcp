/**
 * Extension configuration
 * Uses environment variables when available, falls back to production URLs
 */

// @ts-ignore - Vite env variables
const API_HOST = import.meta.env?.VITE_API_HOST || 'https://mcp-for-chrome.railsblueprint.com';

export const config = {
  // API/Login server URLs
  loginUrl: (extensionId: string) => `${API_HOST}/extension/login?extension_id=${extensionId}`,
  upgradeUrl: (extensionId: string) => `${API_HOST}/pro?extension_id=${extensionId}`,
  docsUrl: `${API_HOST}/docs`,

  // Support URLs
  buyMeACoffeeUrl: 'https://www.buymeacoffee.com/mcp.for.chrome',

  // MCP Server
  defaultMcpPort: '5555',
} as const;
