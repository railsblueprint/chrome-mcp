#!/usr/bin/env node
/**
 * Copyright (c) 2024 Rails Blueprint
 * Originally inspired by Microsoft's Playwright MCP
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Load environment variables from .env.local or .env files
require('dotenv').config({ path: '.env.local' });
require('dotenv').config(); // Fallback to .env if .env.local doesn't exist

// Enable stealth mode patches by default (uses generic names instead of Playwright-specific ones)
process.env.STEALTH_MODE = 'true';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { Command } = require('commander');
const { StatefulBackend } = require('./src/statefulBackend');

const packageJSON = require('./package.json');

// Simple config resolver
function resolveConfig(options) {
  return {
    debug: options.debug === true,
    server: {
      name: 'Blueprint MCP for Chrome',
      version: packageJSON.version
    }
  };
}

// Simple exit watchdog
function setupExitWatchdog() {
  let cleanupDone = false;

  const cleanup = () => {
    if (cleanupDone) return;
    cleanupDone = true;

    if (global.DEBUG_MODE) {
      console.error('[cli.js] Cleanup initiated');
    }

    // Give 5 seconds for graceful shutdown
    setTimeout(() => {
      if (global.DEBUG_MODE) {
        console.error('[cli.js] Forcing exit after timeout');
      }
      process.exit(0);
    }, 5000);
  };

  process.stdin.on('close', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

// Main action
async function main(options) {
  setupExitWatchdog();

  // Store debug mode globally for access by other modules
  global.DEBUG_MODE = options.debug === true;

  if (global.DEBUG_MODE) {
    console.error('[cli.js] Starting MCP server in PASSIVE mode (no connections)');
    console.error('[cli.js] Use connect tool to activate');
    console.error('[cli.js] Debug mode: ENABLED');
  }

  const config = resolveConfig(options);

  // Create StatefulBackend
  const backend = new StatefulBackend(config);

  if (global.DEBUG_MODE) {
    console.error('[cli.js] Creating MCP Server...');
  }

  // Create MCP Server
  const server = new Server(
    {
      name: config.server.name,
      version: config.server.version
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  // Register handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await backend.listTools();
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return await backend.callTool(name, args);
  });

  // Initialize backend
  const clientInfo = {}; // Will be populated on connection
  await backend.initialize(server, clientInfo);

  if (global.DEBUG_MODE) {
    console.error('[cli.js] Starting stdio transport...');
  }

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (global.DEBUG_MODE) {
    console.error('[cli.js] MCP server ready (passive mode)');
  }

  // Handle shutdown
  process.on('SIGINT', async () => {
    if (global.DEBUG_MODE) {
      console.error('[cli.js] Shutting down...');
    }
    await backend.serverClosed();
    await server.close();
    process.exit(0);
  });
}

// Set up command
const program = new Command();

program
  .version('Version ' + packageJSON.version)
  .name('Blueprint MCP for Chrome')
  .description('MCP server for Chrome browser automation using the Blueprint MCP extension')
  .option('--debug', 'Enable debug mode (shows reload/extension tools and verbose logging)')
  .action(async (options) => {
    await main(options);
  });

program.parse(process.argv);
