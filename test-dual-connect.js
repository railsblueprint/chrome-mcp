// Test if we can have two Browser instances connected to same CDP endpoint
const playwright = require('playwright-core');

async function test() {
  try {
    // This would be the CDP endpoint from our relay
    const cdpEndpoint = 'ws://127.0.0.1:9222/devtools/browser';

    console.log('Attempting first connection...');
    const browser1 = await playwright.chromium.connectOverCDP(cdpEndpoint).catch(e => {
      console.log('First connection failed (expected - no browser running):', e.message);
      return null;
    });

    if (!browser1) {
      console.log('\nConclusion: Need a running browser to test this properly.');
      console.log('But based on CDP protocol, multiple connections to same endpoint should work.');
      console.log('Each connection gets its own session ID.');
      return;
    }

    console.log('First connection successful!');

    console.log('Attempting second connection to SAME endpoint...');
    const browser2 = await playwright.chromium.connectOverCDP(cdpEndpoint);
    console.log('Second connection successful!');

    console.log('\nBoth browsers connected:', {
      browser1Connected: browser1.isConnected(),
      browser2Connected: browser2.isConnected()
    });

    await browser1.close();
    await browser2.close();
  } catch (error) {
    console.error('Error:', error.message);
  }
}

test();
