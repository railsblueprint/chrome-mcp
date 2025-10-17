#!/usr/bin/env node
/**
 * Copyright (c) 404 Software Labs.
 *
 * MCP Wrapper - Outer tier that maintains stable stdio connection
 * Spawns and manages the inner MCP server, allowing hot-reload without disconnecting
 */

const { spawn } = require('child_process');
const path = require('path');
const { PassThrough } = require('stream');

const INNER_SERVER_PATH = path.join(__dirname, 'cli.js');

class MCPWrapper {
  constructor() {
    this.innerProcess = null;
    this.restartRequested = false;
    this.inputBuffer = new PassThrough();
    this.outputBuffer = new PassThrough();
  }

  start() {
    // Pipe stdin to input buffer
    process.stdin.pipe(this.inputBuffer);

    // Pipe output buffer to stdout
    this.outputBuffer.pipe(process.stdout);

    this.spawnInnerServer();

    // Handle stdin close
    process.stdin.on('end', () => {
      if (this.innerProcess) {
        this.innerProcess.kill();
      }
      process.exit(0);
    });
  }

  spawnInnerServer() {
    console.error('[Wrapper] Starting inner MCP server...');

    const args = process.argv.slice(2);
    const env = {
      ...process.env,
      MCP_WRAPPER_MODE: '1',  // Signal to inner server that it's wrapped
      PLAYWRIGHT_MCP_PORT: '5555'  // Fixed port for extension to connect to
    };

    this.innerProcess = spawn(process.execPath, [INNER_SERVER_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env
    });

    // Proxy buffered input to inner server
    this.inputBuffer.pipe(this.innerProcess.stdin);

    // Proxy inner server output to buffer
    this.innerProcess.stdout.pipe(this.outputBuffer, { end: false });

    this.innerProcess.on('exit', (code, signal) => {
      console.error(`[Wrapper] Inner server exited (code=${code}, signal=${signal})`);

      // Unpipe to prevent write-after-end errors
      this.inputBuffer.unpipe(this.innerProcess.stdin);
      this.innerProcess.stdout.unpipe(this.outputBuffer);

      // Check if this was an intentional reload (exit code 42)
      if (code === 42) {
        console.error('[Wrapper] Reload requested, restarting inner server...');
        setTimeout(() => this.spawnInnerServer(), 100);
      } else {
        console.error('[Wrapper] Inner server terminated, shutting down');
        process.exit(code || 0);
      }
    });

    this.innerProcess.on('error', (err) => {
      console.error(`[Wrapper] Inner server error: ${err.message}`);
      process.exit(1);
    });
  }
}

const wrapper = new MCPWrapper();
wrapper.start();

// Handle signals
process.on('SIGTERM', () => {
  if (wrapper.innerProcess) {
    wrapper.innerProcess.kill();
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  if (wrapper.innerProcess) {
    wrapper.innerProcess.kill();
  }
  process.exit(0);
});
