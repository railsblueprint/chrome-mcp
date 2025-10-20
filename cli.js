#!/usr/bin/env node
/**
 * Copyright (c) Microsoft Corporation.
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

const { program } = require('playwright-core/lib/utilsBundle');
const path = require('path');
// Use require.resolve to find playwright modules in node_modules (works with npx)
const playwrightPath = path.dirname(require.resolve('playwright/package.json'));
const mcpServer = require(path.join(playwrightPath, 'lib/mcp/sdk/server'));
const { resolveCLIConfig } = require(path.join(playwrightPath, 'lib/mcp/browser/config'));
const { ExtensionContextFactory } = require(path.join(playwrightPath, 'lib/mcp/extension/extensionContextFactory'));
const { setupExitWatchdog } = require(path.join(playwrightPath, 'lib/mcp/browser/watchdog'));

const packageJSON = require('./package.json');

// Custom action for --extension mode with stateful connection management
async function extensionAction(options) {
  setupExitWatchdog();

  // Store debug mode globally for access by other modules
  global.DEBUG_MODE = options.debug === true;

  if (global.DEBUG_MODE) {
    console.error('[cli.js] Starting MCP server in PASSIVE mode (no connections)');
    console.error('[cli.js] Use connect tool to activate');
    console.error('[cli.js] Debug mode: ENABLED');
  }

  const config = await resolveCLIConfig(options);

  // Add debug flag to config for access by backends
  config.debug = global.DEBUG_MODE;

  const extensionContextFactory = new ExtensionContextFactory(
    config.browser.launchOptions.channel || 'chrome',
    config.browser.userDataDir,
    config.browser.launchOptions.executablePath,
    config.server
  );

  // Use StatefulBackend that manages connection states
  const { StatefulBackend } = require('./src/statefulBackend');

  const serverBackendFactory = {
    name: 'Blueprint MCP for Chrome',
    nameInConfig: 'blueprint-chrome-mcp',
    version: packageJSON.version,
    create: () => {
      if (global.DEBUG_MODE) {
        console.error('[cli.js] Creating StatefulBackend');
      }
      return new StatefulBackend(config, extensionContextFactory);
    }
  };

  if (global.DEBUG_MODE) {
    console.error('[cli.js] Calling mcpServer.start...');
  }

  // Force stdio transport for extension mode (don't start HTTP server)
  const mcpServerConfig = {
    ...config.server,
    port: undefined  // Force stdio transport instead of HTTP/SSE
  };

  await mcpServer.start(serverBackendFactory, mcpServerConfig);

  if (global.DEBUG_MODE) {
    console.error('[cli.js] MCP server ready (passive mode)');
  }
}

// Set up command
program
  .version('Version ' + packageJSON.version)
  .name('Blueprint MCP for Chrome')
  .description('MCP server for Chrome browser automation using the Blueprint MCP extension')
  .option('--debug', 'Enable debug mode (shows reload/extension tools and verbose logging)')
  .action(async (options) => {
    await extensionAction(options);
  });

void program.parseAsync(process.argv);
