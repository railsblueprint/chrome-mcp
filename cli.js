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

// Enable stealth mode patches by default (uses generic names instead of Playwright-specific ones)
process.env.STEALTH_MODE = 'true';

const { program } = require('playwright-core/lib/utilsBundle');
const path = require('path');
// Access server module using absolute path to bypass export restrictions
const mcpServer = require(path.join(__dirname, 'node_modules/playwright/lib/mcp/sdk/server'));
const { resolveCLIConfig } = require(path.join(__dirname, 'node_modules/playwright/lib/mcp/browser/config'));
const { ExtensionContextFactory } = require(path.join(__dirname, 'node_modules/playwright/lib/mcp/extension/extensionContextFactory'));
const { setupExitWatchdog } = require(path.join(__dirname, 'node_modules/playwright/lib/mcp/browser/watchdog'));

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

// Set up command with custom extension handler
program
  .version('Version ' + packageJSON.version)
  .name('Blueprint MCP for Chrome')
  .option('--extension', 'Connect to a running Chrome browser instance. Requires the Blueprint MCP browser extension to be installed.')
  .option('--debug', 'Enable debug mode (shows reload/extension tools and verbose logging)')
  .action(async (options) => {
    if (options.extension) {
      await extensionAction(options);
    } else {
      console.error('Error: --extension flag is required');
      process.exit(1);
    }
  });

void program.parseAsync(process.argv);
