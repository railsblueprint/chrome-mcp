// Firefox extension background script
// Connects to MCP server and handles browser automation commands

console.log('[Firefox MCP] Extension loaded');

let socket = null;
let isConnected = false;
let attachedTabId = null; // Currently attached tab ID

// Auto-connect to MCP server on startup
async function autoConnect() {
  try {
    const result = await browser.storage.local.get(['mcpPort']);
    const port = result.mcpPort || '5555';
    const url = `ws://127.0.0.1:${port}/extension`;

    console.log(`[Firefox MCP] Connecting to ${url}...`);

    socket = new WebSocket(url);

    socket.onopen = () => {
      console.log('[Firefox MCP] Connected to MCP server');
      isConnected = true;

      // Send handshake with browser type
      socket.send(JSON.stringify({
        type: 'handshake',
        browser: 'firefox',
        version: browser.runtime.getManifest().version
      }));
    };

    socket.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log('[Firefox MCP] Received command:', message);

        const response = await handleCommand(message);

        socket.send(JSON.stringify({
          id: message.id,
          result: response
        }));
      } catch (error) {
        console.error('[Firefox MCP] Command error:', error);
        socket.send(JSON.stringify({
          id: message.id,
          error: error.message
        }));
      }
    };

    socket.onerror = (error) => {
      console.error('[Firefox MCP] WebSocket error:', error);
      isConnected = false;
    };

    socket.onclose = () => {
      console.log('[Firefox MCP] Disconnected from MCP server');
      isConnected = false;

      // Retry connection after 5 seconds
      setTimeout(autoConnect, 5000);
    };

  } catch (error) {
    console.error('[Firefox MCP] Connection error:', error);
    setTimeout(autoConnect, 5000);
  }
}

// Handle commands from MCP server
async function handleCommand(message) {
  const { method, params } = message;

  switch (method) {
    case 'getTabs':
      return await handleGetTabs();

    case 'createTab':
      return await handleCreateTab(params);

    case 'selectTab':
      return await handleSelectTab(params);

    case 'forwardCDPCommand':
      return await handleCDPCommand(params);

    default:
      throw new Error(`Unknown command: ${method}`);
  }
}

// Handle getTabs command (matches Chrome extension)
async function handleGetTabs() {
  // Get all tabs from all windows
  const windows = await browser.windows.getAll({ populate: true });
  const tabs = [];
  let tabIndex = 0;

  windows.forEach(window => {
    window.tabs.forEach(tab => {
      // Check if tab is automatable (not about:, moz-extension:, etc.)
      const isAutomatable = tab.url && !['about:', 'moz-extension:'].some(scheme => tab.url.startsWith(scheme));

      tabs.push({
        id: tab.id,
        windowId: window.id,
        title: tab.title,
        url: tab.url,
        active: tab.active,
        index: tabIndex,
        automatable: isAutomatable
      });

      tabIndex++;
    });
  });

  return { tabs };
}

// Handle createTab command (matches Chrome extension)
async function handleCreateTab(params) {
  const url = params.url || 'about:blank';
  const activate = params.activate !== false;

  // Create new tab
  const tab = await browser.tabs.create({
    url: url,
    active: activate
  });

  // Auto-attach to the new tab
  attachedTabId = tab.id;

  return { tab: { id: tab.id, title: tab.title, url: tab.url } };
}

// Handle selectTab command
async function handleSelectTab(params) {
  const tabIndex = params.tabIndex;
  const activate = params.activate !== false;

  // Get all tabs
  const allTabs = await browser.tabs.query({});

  if (tabIndex < 0 || tabIndex >= allTabs.length) {
    throw new Error(`Tab index ${tabIndex} out of range (0-${allTabs.length - 1})`);
  }

  const selectedTab = allTabs[tabIndex];

  // Check if tab is automatable (not about:, moz-extension:, etc.)
  const isAutomatable = selectedTab.url && !['about:', 'moz-extension:'].some(scheme => selectedTab.url.startsWith(scheme));
  if (!isAutomatable) {
    throw new Error(`Cannot automate tab ${tabIndex}: "${selectedTab.title}" (${selectedTab.url || 'no url'}) - about: and moz-extension: pages cannot be automated`);
  }

  // Optionally switch to the tab
  if (activate) {
    await browser.tabs.update(selectedTab.id, { active: true });
    await browser.windows.update(selectedTab.windowId, { focused: true });
  }

  // Attach to this tab
  attachedTabId = selectedTab.id;

  return { tab: { id: selectedTab.id, title: selectedTab.title, url: selectedTab.url } };
}

// Handle CDP commands (translate to Firefox equivalents)
async function handleCDPCommand(params) {
  const { method, params: cdpParams } = params;

  console.log('[Firefox MCP] handleCDPCommand called:', method, 'tab:', attachedTabId);

  if (!attachedTabId) {
    throw new Error('No tab attached. Call selectTab or createTab first.');
  }

  switch (method) {
    case 'Page.captureScreenshot':
      // Use Firefox tabs.captureTab API
      const dataUrl = await browser.tabs.captureTab(attachedTabId, {
        format: cdpParams.format === 'png' ? 'png' : 'jpeg',
        quality: cdpParams.quality || 80
      });

      // Convert data URL to base64 (remove "data:image/png;base64," prefix)
      const base64Data = dataUrl.split(',')[1];

      return { data: base64Data };

    case 'Runtime.evaluate':
      // Execute JavaScript in the tab's content
      try {
        console.log('[Firefox MCP] Executing script in tab:', attachedTabId);
        console.log('[Firefox MCP] Script:', cdpParams.expression.substring(0, 200));

        const results = await browser.tabs.executeScript(attachedTabId, {
          code: cdpParams.expression
        });

        console.log('[Firefox MCP] Script result:', results);

        return {
          result: {
            type: 'object',
            value: results[0]
          }
        };
      } catch (error) {
        console.error('[Firefox MCP] Script execution failed:', error);
        throw error;
      }

    case 'Accessibility.getFullAXTree':
      // Firefox doesn't have accessibility tree API, so create a simplified DOM snapshot
      const snapshotResults = await browser.tabs.executeScript(attachedTabId, {
        code: `
          (() => {
            function getSnapshot(element, depth = 0, maxDepth = 8) {
              if (depth > maxDepth) return '';

              let output = '';
              const indent = '  '.repeat(depth);

              // Skip invisible elements
              const style = window.getComputedStyle(element);
              if (style.display === 'none' || style.visibility === 'hidden') {
                return '';
              }

              // Get element info
              const tag = element.tagName.toLowerCase();
              let selector = tag;
              if (element.id) selector += '#' + element.id;
              if (element.className && typeof element.className === 'string') {
                const classes = element.className.split(' ').filter(c => c.trim());
                if (classes.length > 0) selector += '.' + classes.slice(0, 2).join('.');
              }

              // Get direct text content only
              let text = '';
              for (let node of element.childNodes) {
                if (node.nodeType === 3) {
                  const trimmed = node.textContent.trim();
                  if (trimmed) text += trimmed + ' ';
                }
              }
              text = text.trim().substring(0, 80);

              // Important attributes only
              let attrs = [];
              if (element.hasAttribute('href')) attrs.push('href="' + element.getAttribute('href').substring(0, 50) + '"');
              if (element.hasAttribute('aria-label')) attrs.push('aria-label="' + element.getAttribute('aria-label') + '"');
              if (element.hasAttribute('role')) attrs.push('role="' + element.getAttribute('role') + '"');
              if (element.hasAttribute('type') && tag === 'input') attrs.push('type="' + element.getAttribute('type') + '"');

              const attrsStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
              const textStr = text ? ' "' + text + '"' : '';

              output += indent + selector + attrsStr + textStr + '\\n';

              // Process visible children only
              for (let child of element.children) {
                output += getSnapshot(child, depth + 1, maxDepth);
              }

              return output;
            }

            const snapshot = getSnapshot(document.body);
            return { snapshot: snapshot };
          })()
        `
      });

      // Return in a format compatible with Chrome's accessibility tree format
      return {
        formattedSnapshot: {
          preFormatted: true,
          text: snapshotResults[0].snapshot
        }
      };

    default:
      throw new Error(`CDP command not supported in Firefox: ${method}`);
  }
}

// Start auto-connect
autoConnect();
