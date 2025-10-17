#!/usr/bin/env node
/**
 * Wrapper script to run Playwright MCP with --extension flag by default
 * Uses mcp-wrapper.js for automatic reload without reconnection
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Get the directory where this script is located
const scriptDir = __dirname;
const cliPath = path.join(scriptDir, 'mcp-wrapper.js');

// Force debug mode and add --extension
const args = process.argv.slice(2);
if (!args.includes('--extension')) {
  args.unshift('--extension');
}
if (!args.includes('--debug')) {
  args.push('--debug');
}

console.error('[mcp-extension] Starting with args:', args);

// Create log file stream
const logStream = fs.createWriteStream('/tmp/mcp-extension-debug.log', { flags: 'a' });

// Spawn the actual cli.js with all arguments
const child = spawn('node', [cliPath, ...args], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: process.env
});

// Duplicate stdout to both console and file
child.stdout.on('data', (data) => {
  process.stdout.write(data);
  logStream.write(data);
});

// Duplicate stderr to both console and file
child.stderr.on('data', (data) => {
  process.stderr.write(data);
  logStream.write(data);
});

// Forward exit code
child.on('exit', (code) => {
  logStream.end();
  process.exit(code || 0);
});
