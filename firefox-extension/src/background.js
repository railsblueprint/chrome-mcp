// Firefox extension background script
// Connects to MCP server and handles browser automation commands

console.log('[Firefox MCP] Extension loaded');

let socket = null;
let isConnected = false;
let attachedTabId = null; // Currently attached tab ID
let attachedTabInfo = null; // Currently attached tab info {id, title, url}
let projectName = null; // MCP project name from client_id
let pendingDialogResponse = null; // Stores response for next dialog (accept, text)
let consoleMessages = []; // Stores console messages from the page

// Helper function to set up dialog overrides on a tab
// This auto-handles alert/confirm/prompt dialogs and logs what happened
async function setupDialogOverrides(tabId, accept = true, promptText = '') {
  const dialogResponse = { accept, promptText };

  try {
    await browser.tabs.executeScript(tabId, {
      code: `
        // Set up dialog response in window object
        window.__blueprintDialogResponse = ${JSON.stringify(dialogResponse)};

        // Initialize dialog event log if not exists
        if (!window.__blueprintDialogEvents) {
          window.__blueprintDialogEvents = [];
        }

        // Store originals only once
        if (!window.__originalAlert) {
          window.__originalAlert = window.alert;
          window.__originalConfirm = window.confirm;
          window.__originalPrompt = window.prompt;

          // Override with auto-response that checks for pending response
          window.alert = function(...args) {
            const message = args[0] || '';
            if (window.__blueprintDialogResponse) {
              console.log('[Blueprint MCP] Auto-handled alert:', message);
              window.__blueprintDialogEvents.push({
                type: 'alert',
                message: message,
                response: undefined,
                timestamp: Date.now()
              });
              delete window.__blueprintDialogResponse;
              return undefined;
            }
            return window.__originalAlert.apply(this, args);
          };

          window.confirm = function(...args) {
            const message = args[0] || '';
            if (window.__blueprintDialogResponse) {
              const response = window.__blueprintDialogResponse.accept;
              console.log('[Blueprint MCP] Auto-handled confirm:', message, '- returned:', response);
              window.__blueprintDialogEvents.push({
                type: 'confirm',
                message: message,
                response: response,
                timestamp: Date.now()
              });
              delete window.__blueprintDialogResponse;
              return response;
            }
            return window.__originalConfirm.apply(this, args);
          };

          window.prompt = function(...args) {
            const message = args[0] || '';
            const defaultValue = args[1] || '';
            if (window.__blueprintDialogResponse) {
              const response = window.__blueprintDialogResponse.accept
                ? window.__blueprintDialogResponse.promptText
                : null;
              console.log('[Blueprint MCP] Auto-handled prompt:', message, '- returned:', response);
              window.__blueprintDialogEvents.push({
                type: 'prompt',
                message: message,
                defaultValue: defaultValue,
                response: response,
                timestamp: Date.now()
              });
              delete window.__blueprintDialogResponse;
              return response;
            }
            return window.__originalPrompt.apply(this, args);
          };

          console.log('[Blueprint MCP] Dialog overrides installed (auto-accept)');
        } else {
          // Just update the response if already set up
          console.log('[Blueprint MCP] Dialog response updated');
        }
      `
    });
  } catch (error) {
    console.log('[Firefox MCP] Could not inject dialog overrides:', error.message);
  }
}

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
      let message;
      try {
        message = JSON.parse(event.data);
        console.log('[Firefox MCP] Received command:', message);

        // Handle notifications (no id, has method)
        if (!message.id && message.method) {
          if (message.method === 'authenticated' && message.params?.client_id) {
            projectName = message.params.client_id;
            console.log('[Firefox MCP] Project name set:', projectName);
          }
          return; // Don't send response for notifications
        }

        const response = await handleCommand(message);

        socket.send(JSON.stringify({
          id: message.id,
          result: response
        }));
      } catch (error) {
        console.error('[Firefox MCP] Command error:', error);
        // Send error response if we have a message id
        if (message && message.id) {
          socket.send(JSON.stringify({
            id: message.id,
            error: {
              message: error.message,
              stack: error.stack
            }
          }));
        }
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

    case 'listExtensions':
      return await handleListExtensions();

    case 'reloadExtensions':
      return await handleReloadExtensions(params);

    case 'openTestPage':
      return await handleOpenTestPage();

    case 'closeTab':
      return await handleCloseTab();

    case 'getConsoleMessages':
      return await handleGetConsoleMessages();

    case 'clearConsoleMessages':
      consoleMessages = [];
      return { success: true };

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
  attachedTabInfo = {
    id: tab.id,
    title: tab.title,
    url: tab.url
  };

  // Inject console capture and dialog overrides
  await injectConsoleCapture(tab.id);
  await setupDialogOverrides(tab.id);

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
  attachedTabInfo = {
    id: selectedTab.id,
    title: selectedTab.title,
    url: selectedTab.url
  };

  // Inject console capture and dialog overrides
  await injectConsoleCapture(selectedTab.id);
  await setupDialogOverrides(selectedTab.id);

  return { tab: { id: selectedTab.id, title: selectedTab.title, url: selectedTab.url } };
}

// Handle mouse events via JavaScript injection
async function handleMouseEvent(params) {
  const { type, x, y, button = 'left', clickCount = 1 } = params;

  // Map button names to mouse button numbers
  const buttonMap = { left: 0, middle: 1, right: 2 };
  const buttonNum = buttonMap[button] || 0;

  // Create the script to execute based on event type
  let script = '';

  if (type === 'mouseMoved') {
    script = `
      (() => {
        const element = document.elementFromPoint(${x}, ${y});
        if (element) {
          const event = new MouseEvent('mousemove', {
            view: window,
            bubbles: true,
            cancelable: true,
            clientX: ${x},
            clientY: ${y}
          });
          element.dispatchEvent(event);
        }
      })();
    `;
  } else if (type === 'mousePressed') {
    script = `
      (() => {
        const element = document.elementFromPoint(${x}, ${y});
        if (element) {
          const event = new MouseEvent('mousedown', {
            view: window,
            bubbles: true,
            cancelable: true,
            clientX: ${x},
            clientY: ${y},
            button: ${buttonNum},
            detail: ${clickCount}
          });
          element.dispatchEvent(event);
        }
      })();
    `;
  } else if (type === 'mouseReleased') {
    script = `
      (() => {
        const element = document.elementFromPoint(${x}, ${y});
        if (element) {
          // First dispatch mouseup
          const mouseupEvent = new MouseEvent('mouseup', {
            view: window,
            bubbles: true,
            cancelable: true,
            clientX: ${x},
            clientY: ${y},
            button: ${buttonNum},
            detail: ${clickCount}
          });
          element.dispatchEvent(mouseupEvent);

          // Then dispatch click
          const clickEvent = new MouseEvent('click', {
            view: window,
            bubbles: true,
            cancelable: true,
            clientX: ${x},
            clientY: ${y},
            button: ${buttonNum},
            detail: ${clickCount}
          });
          element.dispatchEvent(clickEvent);
        }
      })();
    `;
  }

  await browser.tabs.executeScript(attachedTabId, { code: script });
  return {};
}

// Handle keyboard events via JavaScript injection
async function handleKeyEvent(params) {
  const { type, key, code, text, windowsVirtualKeyCode, nativeVirtualKeyCode, unmodifiedText } = params;

  if (type === 'char') {
    // For character input, directly modify the focused element's value
    // Note: Firefox's executeScript doesn't auto-invoke IIFEs, so we use a simpler approach
    const script = `
      {
        const element = document.activeElement;
        if (element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA')) {
          try {
            const char = ${JSON.stringify(text)};
            const value = element.value || '';

            // Try to use selection if supported
            let start, end, supportsSelection = false;
            try {
              start = element.selectionStart;
              end = element.selectionEnd;
              if (typeof start === 'number' && typeof end === 'number') {
                supportsSelection = true;
              }
            } catch (e) {
              // Selection not supported (e.g., email/number inputs in Firefox)
            }

            if (supportsSelection) {
              // Insert at cursor position
              element.value = value.substring(0, start) + char + value.substring(end);
              element.selectionStart = element.selectionEnd = start + char.length;
            } else {
              // Just append to end if selection not supported
              element.value = value + char;
            }

            // Dispatch input event to trigger React/Vue listeners
            const inputEvent = new Event('input', { bubbles: true, cancelable: true });
            element.dispatchEvent(inputEvent);
          } catch (error) {
            console.error('Key event error:', error);
          }
        }
      }
    `;

    await browser.tabs.executeScript(attachedTabId, { code: script });
  } else {
    // For keyDown/keyUp, dispatch keyboard events
    const eventType = type === 'keyDown' ? 'keydown' : 'keyup';

    const script = `
      {
        const element = document.activeElement || document.body;

        const event = new KeyboardEvent(${JSON.stringify(eventType)}, {
          key: ${JSON.stringify(key)},
          code: ${JSON.stringify(code)},
          bubbles: true,
          cancelable: true,
          keyCode: ${windowsVirtualKeyCode || 0},
          which: ${windowsVirtualKeyCode || 0}
        });

        element.dispatchEvent(event);
      }
    `;

    await browser.tabs.executeScript(attachedTabId, { code: script });
  }

  return {};
}

// Handle CDP commands (translate to Firefox equivalents)
async function handleCDPCommand(params) {
  const { method, params: cdpParams } = params;

  console.log('[Firefox MCP] handleCDPCommand called:', method, 'tab:', attachedTabId);

  if (!attachedTabId) {
    throw new Error('No tab attached. Call selectTab or createTab first.');
  }

  switch (method) {
    case 'Page.navigate':
      // Navigate to URL using Firefox tabs.update
      await browser.tabs.update(attachedTabId, { url: cdpParams.url });
      return {};

    case 'Page.reload':
      // Reload page using Firefox tabs.reload
      await browser.tabs.reload(attachedTabId);
      return {};

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

    case 'Input.dispatchMouseEvent':
      // Simulate mouse events using JavaScript
      return await handleMouseEvent(cdpParams);

    case 'Input.dispatchKeyEvent':
      // Simulate keyboard events using JavaScript
      return await handleKeyEvent(cdpParams);

    case 'DOM.describeNode':
      // Firefox doesn't need this for file uploads, but return mock data for compatibility
      return {
        node: {
          backendNodeId: 1,
          nodeType: 1,
          nodeName: 'INPUT'
        }
      };

    case 'DOM.setFileInputFiles':
      // Firefox doesn't support programmatic file input for security reasons
      // This would require user interaction in a real scenario
      throw new Error('File upload not supported in Firefox extension - requires user interaction');

    case 'Emulation.setDeviceMetricsOverride':
      // Firefox uses actual window resizing instead of device metrics emulation
      // Get the current window
      const tab = await browser.tabs.get(attachedTabId);
      const window = await browser.windows.get(tab.windowId);

      // Resize the window
      await browser.windows.update(window.id, {
        width: cdpParams.width,
        height: cdpParams.height
      });

      return {};

    case 'Page.handleJavaScriptDialog':
      // Update dialog handler with new response settings
      const accept = cdpParams.accept !== false;
      const promptText = cdpParams.promptText || '';

      await setupDialogOverrides(attachedTabId, accept, promptText);

      return {};

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

// Handle listExtensions command
async function handleListExtensions() {
  const extensions = await browser.management.getAll();

  // Filter to only show extensions (not themes or other types)
  const extensionList = extensions
    .filter(ext => ext.type === 'extension')
    .map(ext => ({
      id: ext.id,
      name: ext.name,
      version: ext.version,
      enabled: ext.enabled,
      description: ext.description
    }));

  return { extensions: extensionList };
}

// Handle openTestPage command
async function handleOpenTestPage() {
  const testPageUrl = browser.runtime.getURL('test.html');
  const tab = await browser.tabs.create({ url: testPageUrl, active: true });

  // Auto-attach to the test page tab
  attachedTabId = tab.id;
  attachedTabInfo = {
    id: tab.id,
    title: 'Browser Interaction Test Page',
    url: testPageUrl
  };

  // Inject console capture and dialog overrides
  await injectConsoleCapture(tab.id);
  await setupDialogOverrides(tab.id);

  return { url: testPageUrl, tab: { id: tab.id } };
}

// Handle reloadExtensions command
async function handleReloadExtensions(params) {
  const extensionName = params.extensionName;

  if (!extensionName) {
    // Reload all extensions (just reload this one for now)
    await browser.runtime.reload();
    return { reloaded: [browser.runtime.getManifest().name] };
  }

  // Get all extensions
  const extensions = await browser.management.getAll();

  // Find the extension by name
  const targetExtension = extensions.find(ext =>
    ext.name.toLowerCase() === extensionName.toLowerCase() && ext.type === 'extension'
  );

  if (!targetExtension) {
    throw new Error(`Extension "${extensionName}" not found`);
  }

  // Check if it's this extension
  if (targetExtension.id === browser.runtime.id) {
    // Reload this extension
    await browser.runtime.reload();
    return { reloaded: [targetExtension.name] };
  } else {
    // Cannot reload other extensions in Firefox (security restriction)
    throw new Error(`Cannot reload other extensions in Firefox. Only "${browser.runtime.getManifest().name}" can be reloaded.`);
  }
}

// Handle closeTab command
async function handleCloseTab() {
  if (!attachedTabId) {
    throw new Error('No tab attached');
  }

  await browser.tabs.remove(attachedTabId);
  attachedTabId = null;
  attachedTabInfo = null;

  return { success: true };
}

// Handle getConsoleMessages command
async function handleGetConsoleMessages() {
  return {
    messages: consoleMessages.slice() // Return copy
  };
}

// Inject console capture script into tab
async function injectConsoleCapture(tabId) {
  try {
    await browser.tabs.executeScript(tabId, {
      code: `
        // Only inject once
        if (!window.__blueprintConsoleInjected) {
          window.__blueprintConsoleInjected = true;

          // Store original console methods
          const originalConsole = {
            log: console.log,
            warn: console.warn,
            error: console.error,
            info: console.info,
            debug: console.debug
          };

          // Override console methods to capture messages
          ['log', 'warn', 'error', 'info', 'debug'].forEach(method => {
            console[method] = function(...args) {
              // Call original
              originalConsole[method].apply(console, args);

              // Send to extension
              const message = {
                type: 'console',
                level: method,
                text: args.map(arg => {
                  try {
                    return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
                  } catch (e) {
                    return String(arg);
                  }
                }).join(' '),
                timestamp: Date.now()
              };

              // Try to send via postMessage (extension will listen)
              window.postMessage({ __blueprintConsole: message }, '*');
            };
          });

          console.log('[Blueprint MCP] Console capture installed');
        }
      `
    });
  } catch (error) {
    console.error('[Firefox MCP] Failed to inject console capture:', error);
  }
}

// Handle messages from popup and content scripts
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getStatus') {
    sendResponse({
      connected: isConnected,
      attachedTab: attachedTabInfo,
      projectName: projectName
    });
  } else if (message.type === 'console_message') {
    // Store console message from content script
    consoleMessages.push(message.data);
    // Keep only last 100 messages
    if (consoleMessages.length > 100) {
      consoleMessages.shift();
    }
  }
});

// Start auto-connect
autoConnect();
