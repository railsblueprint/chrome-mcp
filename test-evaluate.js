#!/usr/bin/env node
const { spawn } = require('child_process');

// Start the MCP server
const server = spawn('node', ['mcp-extension.js'], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let buffer = '';
let requestId = 1;
let testsPassed = 0;
let testsFailed = 0;

server.stdout.on('data', (data) => {
  buffer += data.toString();

  // Try to parse complete JSON-RPC messages
  const lines = buffer.split('\n');
  buffer = lines.pop(); // Keep incomplete line in buffer

  for (const line of lines) {
    if (line.trim()) {
      try {
        const message = JSON.parse(line);

        if (message.result && message.result.content) {
          const responseText = JSON.stringify(message.result.content);
          const hasSnapshot = responseText.includes('Page state') || responseText.includes('Page Snapshot');
          const testName = message.id === 2 ? 'WITHOUT includeSnapshot' : 'WITH includeSnapshot';

          console.log(`\n[TEST ${message.id}] ${testName}`);
          console.log(`Response length: ${responseText.length} chars`);
          console.log(`Has snapshot: ${hasSnapshot}`);
          console.log(`Response content:`, responseText.substring(0, 300));

          if (message.id === 2) {
            // Test without snapshot - should NOT have snapshot
            if (!hasSnapshot) {
              console.log('✅ PASS - No snapshot included (as expected)');
              testsPassed++;
            } else {
              console.log('❌ FAIL - Snapshot included (should not be)');
              testsFailed++;
            }
          } else if (message.id === 3) {
            // Test with snapshot - SHOULD have snapshot
            if (hasSnapshot) {
              console.log('✅ PASS - Snapshot included (as expected)');
              testsPassed++;
            } else {
              console.log('❌ FAIL - No snapshot included (should be)');
              testsFailed++;
            }
          }
        }
      } catch (e) {
        // Ignore non-JSON lines
      }
    }
  }
});

server.stderr.on('data', (data) => {
  const text = data.toString().trim();
  if (text.includes('ERROR') || text.includes('Error')) {
    console.log('[ERROR]', text);
  }
});

server.on('close', (code) => {
  console.log('\n' + '='.repeat(50));
  console.log(`Tests passed: ${testsPassed}`);
  console.log(`Tests failed: ${testsFailed}`);
  console.log('='.repeat(50));
  process.exit(testsFailed > 0 ? 1 : 0);
});

// Wait for server to initialize
setTimeout(() => {
  console.log('[INFO] Sending initialize request...');

  // Send initialize request
  const initRequest = {
    jsonrpc: '2.0',
    id: requestId++,
    method: 'initialize',
    params: {
      protocolVersion: '0.1.0',
      capabilities: {},
      clientInfo: {
        name: 'test-client',
        version: '1.0.0'
      }
    }
  };

  server.stdin.write(JSON.stringify(initRequest) + '\n');

  // Test 1: WITHOUT includeSnapshot (default)
  setTimeout(() => {
    console.log('\n[INFO] Test 1: Calling browser_evaluate WITHOUT includeSnapshot...');

    const evaluateWithout = {
      jsonrpc: '2.0',
      id: requestId++,
      method: 'tools/call',
      params: {
        name: 'browser_evaluate',
        arguments: {
          function: '() => document.title'
        }
      }
    };

    server.stdin.write(JSON.stringify(evaluateWithout) + '\n');

    // Test 2: WITH includeSnapshot=true
    setTimeout(() => {
      console.log('\n[INFO] Test 2: Calling browser_evaluate WITH includeSnapshot=true...');

      const evaluateWith = {
        jsonrpc: '2.0',
        id: requestId++,
        method: 'tools/call',
        params: {
          name: 'browser_evaluate',
          arguments: {
            function: '() => document.title',
            includeSnapshot: true
          }
        }
      };

      server.stdin.write(JSON.stringify(evaluateWith) + '\n');

      // Give it time to process, then exit
      setTimeout(() => {
        server.kill();
      }, 8000);
    }, 4000);
  }, 2000);
}, 2000);
