/**
 * Unified Backend
 *
 * Single backend implementation that works for both direct and proxy modes.
 * Uses Transport abstraction to send commands to extension.
 */

function debugLog(...args) {
  if (global.DEBUG_MODE) {
    console.error('[UnifiedBackend]', ...args);
  }
}

class UnifiedBackend {
  constructor(config, transport) {
    this._config = config;
    this._transport = transport;
  }

  async initialize(server, clientInfo) {
    this._server = server;
    this._clientInfo = clientInfo;
    debugLog('Initialized');
  }

  /**
   * List all available tools
   */
  async listTools() {
    // Return MCP-formatted tool schemas
    return [
      // Tab management
      {
        name: 'browser_tabs',
        description: 'Manage browser tabs - list, create, select, or close tabs',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'new', 'select', 'close'],
              description: 'Action to perform'
            },
            url: {
              type: 'string',
              description: 'URL to navigate to (for new action)'
            },
            index: {
              type: 'number',
              description: 'Tab index (for select action)'
            },
            activate: {
              type: 'boolean',
              description: 'Bring tab to foreground (default: true for new, false for select)'
            },
            stealth: {
              type: 'boolean',
              description: 'Enable stealth mode to avoid bot detection'
            }
          },
          required: ['action']
        }
      },

      // Navigation
      {
        name: 'browser_navigate',
        description: 'Navigate in the browser - go to URL, back, forward, reload, or open test page',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['url', 'back', 'forward', 'reload', 'test_page'],
              description: 'Navigation action to perform'
            },
            url: { type: 'string', description: 'URL to navigate to (required when action=url)' }
          },
          required: ['action']
        }
      },

      // Interaction
      {
        name: 'browser_interact',
        description: 'Perform one or more browser interactions in sequence (click, type, press keys, hover, wait)',
        inputSchema: {
          type: 'object',
          properties: {
            actions: {
              type: 'array',
              description: 'Array of actions to perform in sequence',
              items: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    enum: ['click', 'type', 'press_key', 'hover', 'wait', 'mouse_move', 'mouse_click', 'scroll_to', 'scroll_by', 'scroll_into_view', 'select_option', 'file_upload'],
                    description: 'Type of interaction'
                  },
                  selector: { type: 'string', description: 'CSS selector (for click, type, hover, scroll_into_view, select_option, file_upload)' },
                  text: { type: 'string', description: 'Text to type (for type action)' },
                  key: { type: 'string', description: 'Key to press (for press_key action)' },
                  value: { type: 'string', description: 'Option value to select (for select_option action)' },
                  files: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'File paths to upload (for file_upload action)'
                  },
                  x: { type: 'number', description: 'X coordinate (for mouse_move, mouse_click, scroll_to, scroll_by)' },
                  y: { type: 'number', description: 'Y coordinate (for mouse_move, mouse_click, scroll_to, scroll_by)' },
                  button: {
                    type: 'string',
                    enum: ['left', 'right', 'middle'],
                    description: 'Mouse button (for click actions)'
                  },
                  clickCount: { type: 'number', description: 'Number of clicks (default: 1)' },
                  timeout: { type: 'number', description: 'Timeout in ms (for wait action)' }
                },
                required: ['type']
              }
            },
            onError: {
              type: 'string',
              enum: ['stop', 'ignore'],
              description: 'What to do on error: stop execution or ignore and continue (default: stop)'
            }
          },
          required: ['actions']
        }
      },

      // Snapshot
      {
        name: 'browser_snapshot',
        description: 'Get accessible DOM snapshot of the page',
        inputSchema: { type: 'object', properties: {} }
      },

      // Screenshot
      {
        name: 'browser_take_screenshot',
        description: 'Capture screenshot of the page (default: JPEG quality 80, viewport only). Returns image data if no path provided, saves to file if path is specified.',
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default: jpeg)' },
            fullPage: { type: 'boolean', description: 'Capture full page (default: false, viewport only)' },
            quality: { type: 'number', description: 'JPEG quality 0-100 (default: 80)' },
            path: { type: 'string', description: 'Optional: file path to save screenshot. If provided, saves to disk instead of returning image data.' }
          }
        }
      },

      // JavaScript
      {
        name: 'browser_evaluate',
        description: 'Execute JavaScript in the page context',
        inputSchema: {
          type: 'object',
          properties: {
            function: { type: 'string', description: 'JavaScript function to execute' },
            expression: { type: 'string', description: 'JavaScript expression to evaluate' }
          }
        }
      },

      // Console
      {
        name: 'browser_console_messages',
        description: 'Get console messages from the page',
        inputSchema: { type: 'object', properties: {} }
      },

      // Forms
      {
        name: 'browser_fill_form',
        description: 'Fill multiple form fields at once',
        inputSchema: {
          type: 'object',
          properties: {
            fields: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  selector: { type: 'string' },
                  value: { type: 'string' }
                }
              }
            }
          },
          required: ['fields']
        }
      },

      // Mouse operations
      {
        name: 'browser_drag',
        description: 'Drag element to another element',
        inputSchema: {
          type: 'object',
          properties: {
            fromSelector: { type: 'string', description: 'Source element' },
            toSelector: { type: 'string', description: 'Target element' }
          },
          required: ['fromSelector', 'toSelector']
        }
      },

      // Window operations
      {
        name: 'browser_window',
        description: 'Manage browser window - resize, close, minimize, or maximize',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['resize', 'close', 'minimize', 'maximize'],
              description: 'Window action to perform'
            },
            width: { type: 'number', description: 'Window width (required for resize)' },
            height: { type: 'number', description: 'Window height (required for resize)' }
          },
          required: ['action']
        }
      },

      // Verification
      {
        name: 'browser_verify_text_visible',
        description: 'Verify text is visible on page',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to find' }
          },
          required: ['text']
        }
      },
      {
        name: 'browser_verify_element_visible',
        description: 'Verify element is visible',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string' }
          },
          required: ['selector']
        }
      },

      // Network
      {
        name: 'browser_network_requests',
        description: 'Get network request log',
        inputSchema: { type: 'object', properties: {} }
      },

      // PDF
      {
        name: 'browser_pdf_save',
        description: 'Save page as PDF. Saves to specified file path.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to save PDF (e.g., "/path/to/output.pdf")' }
          }
        }
      },

      // Dialogs
      {
        name: 'browser_handle_dialog',
        description: 'Handle alert/confirm/prompt dialog',
        inputSchema: {
          type: 'object',
          properties: {
            accept: { type: 'boolean', description: 'Accept or dismiss' },
            text: { type: 'string', description: 'Text for prompt' }
          }
        }
      },

      // Extension management
      {
        name: 'browser_list_extensions',
        description: 'List installed Chrome extensions',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'browser_reload_extensions',
        description: 'Reload Chrome extensions',
        inputSchema: {
          type: 'object',
          properties: {
            extensionName: { type: 'string', description: 'Specific extension to reload' }
          }
        }
      },

      // Performance metrics
      {
        name: 'browser_performance_metrics',
        description: 'Get performance metrics for current page - collects FCP, LCP, CLS, TTFB, and other Web Vitals',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }
    ];
  }

  /**
   * Call a tool
   */
  async callTool(name, args) {
    debugLog(`callTool: ${name}`, args);

    try {
      // Route to appropriate handler
      switch (name) {
        case 'browser_tabs':
          return await this._handleBrowserTabs(args);

        case 'browser_navigate':
          return await this._handleNavigate(args);

        case 'browser_interact':
          return await this._handleInteract(args);

        case 'browser_snapshot':
          return await this._handleSnapshot();

        case 'browser_take_screenshot':
          return await this._handleScreenshot(args);

        case 'browser_evaluate':
          return await this._handleEvaluate(args);

        case 'browser_console_messages':
          return await this._handleConsoleMessages();

        // Forms
        case 'browser_fill_form':
          return await this._handleFillForm(args);

        // Mouse
        case 'browser_drag':
          return await this._handleDrag(args);

        // Window
        case 'browser_window':
          return await this._handleWindow(args);

        // Verification
        case 'browser_verify_text_visible':
          return await this._handleVerifyTextVisible(args);

        case 'browser_verify_element_visible':
          return await this._handleVerifyElementVisible(args);

        // Network
        case 'browser_network_requests':
          return await this._handleNetworkRequests();

        // PDF
        case 'browser_pdf_save':
          return await this._handlePdfSave(args);

        // Dialogs
        case 'browser_handle_dialog':
          return await this._handleDialog(args);

        // Extension management
        case 'browser_list_extensions':
          return await this._handleListExtensions();

        case 'browser_reload_extensions':
          return await this._handleReloadExtensions(args);

        case 'browser_performance_metrics':
          return await this._handlePerformanceMetrics(args);

        default:
          throw new Error(`Tool '${name}' not implemented yet`);
      }
    } catch (error) {
      debugLog(`Error in ${name}:`, error);
      return {
        content: [{
          type: 'text',
          text: `### Error\n${error.message || String(error)}`
        }],
        isError: true
      };
    }
  }

  // ==================== TOOL HANDLERS ====================

  async _handleBrowserTabs(args) {
    const action = args.action;

    if (action === 'list') {
      const result = await this._transport.sendCommand('getTabs', {});
      const tabs = result.tabs || [];

      // Group tabs by window
      const tabsByWindow = {};
      tabs.forEach((tab) => {
        // tab.index is already set correctly by extension (chrome.tabs.query order)
        if (!tabsByWindow[tab.windowId]) {
          tabsByWindow[tab.windowId] = [];
        }
        tabsByWindow[tab.windowId].push(tab);
      });

      // Format tabs grouped by window
      const windowIds = Object.keys(tabsByWindow).sort();
      const tabList = windowIds.map(windowId => {
        const windowTabs = tabsByWindow[windowId];
        const windowHeader = windowId == result.focusedWindowId ?
          `\n**Window ${windowId} (FOCUSED):**\n` :
          `\n**Window ${windowId}:**\n`;

        const tabLines = windowTabs.map(tab => {
          const markers = [];
          if (tab.active) markers.push('ACTIVE');
          if (!tab.automatable) markers.push('NOT AUTOMATABLE');

          const markerStr = markers.length > 0 ? ` [${markers.join(', ')}]` : '';
          return `  ${tab.index}. ${tab.title || 'Untitled'} (${tab.url || 'about:blank'})${markerStr}`;
        }).join('\n');

        return windowHeader + tabLines;
      }).join('\n');

      return {
        content: [{
          type: 'text',
          text: `### Browser Tabs\n\nTotal: ${tabs.length} tabs in ${windowIds.length} window(s)\n${tabList}`
        }],
        isError: false
      };
    }

    if (action === 'new') {
      const result = await this._transport.sendCommand('createTab', {
        url: args.url || 'about:blank',
        activate: args.activate !== false,
        stealth: args.stealth || false
      });

      // Get updated tab list to find the actual index of the new tab
      const tabsResult = await this._transport.sendCommand('getTabs', {});
      const newTab = tabsResult.tabs.find(tab => tab.id === result.tab?.id);
      const tabIndex = newTab ? newTab.index : 'unknown';

      return {
        content: [{
          type: 'text',
          text: `### Tab Created and Connected\n\nURL: ${args.url || 'about:blank'}\nTab ID: ${result.tab?.id}\nTab Index: ${tabIndex}\n\n**This tab is now the active connection.** All browser commands will execute on this tab.\n\n**Note:** The tab was inserted at index ${tabIndex} (not necessarily at the end of the list).`
        }],
        isError: false
      };
    }

    if (action === 'select') {
      const result = await this._transport.sendCommand('selectTab', {
        tabIndex: args.index,
        activate: args.activate !== false,
        stealth: args.stealth || false
      });

      return {
        content: [{
          type: 'text',
          text: `### Tab Selected\n\nIndex: ${args.index}\nTitle: ${result.tab?.title}`
        }],
        isError: false
      };
    }

    throw new Error(`Unknown browser_tabs action: ${action}`);
  }

  async _handleNavigate(args) {
    const action = args.action;

    if (action === 'url') {
      if (!args.url) {
        throw new Error('URL is required when action is "url"');
      }

      await this._transport.sendCommand('forwardCDPCommand', {
        method: 'Page.navigate',
        params: { url: args.url }
      });

      return {
        content: [{
          type: 'text',
          text: `### Navigated\n\nURL: ${args.url}`
        }],
        isError: false
      };
    }

    if (action === 'back') {
      // Use JavaScript history.back() instead of non-existent CDP method
      await this._transport.sendCommand('forwardCDPCommand', {
        method: 'Runtime.evaluate',
        params: {
          expression: 'window.history.back()'
        }
      });

      return {
        content: [{
          type: 'text',
          text: `### Navigated Back`
        }],
        isError: false
      };
    }

    if (action === 'forward') {
      // Use JavaScript history.forward()
      await this._transport.sendCommand('forwardCDPCommand', {
        method: 'Runtime.evaluate',
        params: {
          expression: 'window.history.forward()'
        }
      });

      return {
        content: [{
          type: 'text',
          text: `### Navigated Forward`
        }],
        isError: false
      };
    }

    if (action === 'reload') {
      await this._transport.sendCommand('forwardCDPCommand', {
        method: 'Page.reload',
        params: {}
      });

      return {
        content: [{
          type: 'text',
          text: `### Page Reloaded`
        }],
        isError: false
      };
    }

    if (action === 'test_page') {
      // Open test page in a new window via extension
      const result = await this._transport.sendCommand('openTestPage', {});

      return {
        content: [{
          type: 'text',
          text: `### Opened Test Page\n\nNew window created with test page\nURL: ${result.url}\nTab ID: ${result.tab?.id}`
        }],
        isError: false
      };
    }

    throw new Error(`Unknown navigation action: ${action}`);
  }

  async _handleInteract(args) {
    const actions = args.actions || [];
    const onError = args.onError || 'stop';
    const results = [];

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const actionIndex = i + 1;

      try {
        let result = null;

        switch (action.type) {
          case 'click': {
            // Get element location
            const elemResult = await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Runtime.evaluate',
              params: {
                expression: `
                  (() => {
                    const el = document.querySelector(${JSON.stringify(action.selector)});
                    if (!el) return null;
                    const rect = el.getBoundingClientRect();
                    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                  })()
                `,
                returnByValue: true
              }
            });

            if (!elemResult.result || !elemResult.result.value) {
              throw new Error(`Element not found: ${action.selector}`);
            }

            const { x, y } = elemResult.result.value;
            const button = action.button || 'left';

            // Click at coordinates
            await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Input.dispatchMouseEvent',
              params: {
                type: 'mousePressed',
                x, y,
                button,
                clickCount: action.clickCount || 1
              }
            });

            await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Input.dispatchMouseEvent',
              params: {
                type: 'mouseReleased',
                x, y,
                button,
                clickCount: action.clickCount || 1
              }
            });

            result = `Clicked ${action.selector}`;
            break;
          }

          case 'type': {
            // Focus element first
            await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Runtime.evaluate',
              params: {
                expression: `document.querySelector(${JSON.stringify(action.selector)})?.focus()`,
                returnByValue: false
              }
            });

            // Type each character
            for (const char of action.text) {
              await this._transport.sendCommand('forwardCDPCommand', {
                method: 'Input.dispatchKeyEvent',
                params: {
                  type: 'char',
                  text: char
                }
              });
            }

            result = `Typed "${action.text}" into ${action.selector}`;
            break;
          }

          case 'press_key': {
            const key = action.key;

            // Map common keys to their key codes
            const keyCodeMap = {
              'Enter': 13,
              'Escape': 27,
              'Tab': 9,
              'Backspace': 8,
              'Delete': 46,
              'ArrowUp': 38,
              'ArrowDown': 40,
              'ArrowLeft': 37,
              'ArrowRight': 39,
              'Space': 32
            };

            const code = keyCodeMap[key];
            const text = key === 'Enter' ? '\r' : (key === 'Tab' ? '\t' : (key.length === 1 ? key : ''));

            const baseParams = {
              key: key,
              code: key,
              windowsVirtualKeyCode: code,
              nativeVirtualKeyCode: code,
              text: text,
              unmodifiedText: text
            };

            // Send keyDown
            await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Input.dispatchKeyEvent',
              params: {
                type: 'keyDown',
                ...baseParams
              }
            });

            // Send keyUp
            await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Input.dispatchKeyEvent',
              params: {
                type: 'keyUp',
                ...baseParams
              }
            });

            result = `Pressed key: ${key}`;
            break;
          }

          case 'hover': {
            // Get element location
            const elemResult = await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Runtime.evaluate',
              params: {
                expression: `
                  (() => {
                    const el = document.querySelector(${JSON.stringify(action.selector)});
                    if (!el) return null;
                    const rect = el.getBoundingClientRect();
                    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                  })()
                `,
                returnByValue: true
              }
            });

            if (!elemResult.result || !elemResult.result.value) {
              throw new Error(`Element not found: ${action.selector}`);
            }

            const { x, y } = elemResult.result.value;

            // Move mouse
            await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Input.dispatchMouseEvent',
              params: {
                type: 'mouseMoved',
                x, y
              }
            });

            result = `Hovered over ${action.selector}`;
            break;
          }

          case 'wait': {
            const timeout = action.timeout || 30000;
            const selector = action.selector;

            if (selector) {
              // Wait for element
              await this._transport.sendCommand('forwardCDPCommand', {
                method: 'Runtime.evaluate',
                params: {
                  expression: `
                    new Promise((resolve, reject) => {
                      const timeout = setTimeout(() => reject(new Error('Timeout')), ${timeout});
                      const check = () => {
                        if (document.querySelector(${JSON.stringify(selector)})) {
                          clearTimeout(timeout);
                          resolve(true);
                        } else {
                          setTimeout(check, 100);
                        }
                      };
                      check();
                    })
                  `,
                  awaitPromise: true,
                  returnByValue: true
                }
              });
              result = `Waited for element: ${selector}`;
            } else {
              // Simple timeout
              await new Promise(resolve => setTimeout(resolve, timeout));
              result = `Waited ${timeout}ms`;
            }
            break;
          }

          case 'mouse_move': {
            await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Input.dispatchMouseEvent',
              params: {
                type: 'mouseMoved',
                x: action.x,
                y: action.y
              }
            });

            result = `Moved mouse to (${action.x}, ${action.y})`;
            break;
          }

          case 'mouse_click': {
            const button = action.button || 'left';

            await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Input.dispatchMouseEvent',
              params: {
                type: 'mousePressed',
                x: action.x,
                y: action.y,
                button,
                clickCount: action.clickCount || 1
              }
            });

            await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Input.dispatchMouseEvent',
              params: {
                type: 'mouseReleased',
                x: action.x,
                y: action.y,
                button,
                clickCount: action.clickCount || 1
              }
            });

            result = `Clicked at (${action.x}, ${action.y})`;
            break;
          }

          case 'scroll_to': {
            // Scroll window to specific coordinates
            await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Runtime.evaluate',
              params: {
                expression: `window.scrollTo(${action.x || 0}, ${action.y || 0})`,
                returnByValue: false
              }
            });

            result = `Scrolled to (${action.x || 0}, ${action.y || 0})`;
            break;
          }

          case 'scroll_by': {
            // Scroll window by offset
            await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Runtime.evaluate',
              params: {
                expression: `window.scrollBy(${action.x || 0}, ${action.y || 0})`,
                returnByValue: false
              }
            });

            result = `Scrolled by (${action.x || 0}, ${action.y || 0})`;
            break;
          }

          case 'scroll_into_view': {
            // Scroll element into view
            const scrollResult = await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Runtime.evaluate',
              params: {
                expression: `
                  (() => {
                    const el = document.querySelector(${JSON.stringify(action.selector)});
                    if (!el) return { error: 'Element not found' };
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    return { success: true };
                  })()
                `,
                returnByValue: true
              }
            });

            if (scrollResult.result?.value?.error) {
              throw new Error(`${scrollResult.result.value.error}: ${action.selector}`);
            }

            result = `Scrolled ${action.selector} into view`;
            break;
          }

          case 'select_option': {
            // Select option in dropdown
            const selectResult = await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Runtime.evaluate',
              params: {
                expression: `
                  (() => {
                    const select = document.querySelector(${JSON.stringify(action.selector)});
                    if (!select) return { error: 'Select element not found' };
                    select.value = ${JSON.stringify(action.value)};
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    return { success: true };
                  })()
                `,
                returnByValue: true
              }
            });

            if (selectResult.result?.value?.error) {
              throw new Error(`${selectResult.result.value.error}: ${action.selector}`);
            }

            result = `Selected option "${action.value}" in ${action.selector}`;
            break;
          }

          case 'file_upload': {
            // Upload file(s) to input element
            const files = action.files || [];
            if (files.length === 0) {
              throw new Error('No files specified for upload');
            }

            // Get the node for the file input
            const evalResult = await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Runtime.evaluate',
              params: {
                expression: `
                  (() => {
                    const el = document.querySelector(${JSON.stringify(action.selector)});
                    if (!el) throw new Error('File input not found');
                    return el;
                  })()
                `,
                returnByValue: false
              }
            });

            if (!evalResult.result || !evalResult.result.objectId) {
              throw new Error(`File input element not found: ${action.selector}`);
            }

            // Get the backend node ID
            const nodeInfo = await this._transport.sendCommand('forwardCDPCommand', {
              method: 'DOM.describeNode',
              params: {
                objectId: evalResult.result.objectId
              }
            });

            // Set the files
            await this._transport.sendCommand('forwardCDPCommand', {
              method: 'DOM.setFileInputFiles',
              params: {
                files: files,
                backendNodeId: nodeInfo.node.backendNodeId
              }
            });

            result = `Uploaded ${files.length} file(s) to ${action.selector}`;
            break;
          }

          default:
            throw new Error(`Unknown action type: ${action.type}`);
        }

        results.push({
          index: actionIndex,
          action: action.type,
          status: 'success',
          message: result
        });

      } catch (error) {
        const errorMessage = error.message || String(error);
        results.push({
          index: actionIndex,
          action: action.type,
          status: 'error',
          message: errorMessage
        });

        // If onError is 'stop', throw immediately
        if (onError === 'stop') {
          const successCount = results.filter(r => r.status === 'success').length;
          const errorCount = results.filter(r => r.status === 'error').length;

          const summary = results.map(r =>
            `${r.index}. ${r.action}: ${r.status === 'success' ? '✓' : '✗'} ${r.message}`
          ).join('\n');

          throw new Error(
            `Interaction stopped at action ${actionIndex} due to error.\n\n` +
            `Summary: ${successCount} succeeded, ${errorCount} failed\n\n${summary}`
          );
        }
      }
    }

    // Generate final summary
    const successCount = results.filter(r => r.status === 'success').length;
    const errorCount = results.filter(r => r.status === 'error').length;

    const summary = results.map(r =>
      `${r.index}. ${r.action}: ${r.status === 'success' ? '✓' : '✗'} ${r.message}`
    ).join('\n');

    return {
      content: [{
        type: 'text',
        text: `### Interactions Complete\n\nTotal: ${results.length}\nSucceeded: ${successCount}\nFailed: ${errorCount}\n\n${summary}`
      }],
      isError: errorCount > 0
    };
  }

  async _handleClick(args) {
    // Get element location first
    const elemResult = await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Runtime.evaluate',
      params: {
        expression: `
          (() => {
            const el = document.querySelector(${JSON.stringify(args.selector)});
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          })()
        `,
        returnByValue: true
      }
    });

    if (!elemResult.result || !elemResult.result.value) {
      throw new Error(`Element not found: ${args.selector}`);
    }

    const { x, y } = elemResult.result.value;

    // Click at coordinates
    const button = args.button || 'left';
    await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Input.dispatchMouseEvent',
      params: {
        type: 'mousePressed',
        x, y,
        button,
        clickCount: args.clickCount || 1
      }
    });

    await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Input.dispatchMouseEvent',
      params: {
        type: 'mouseReleased',
        x, y,
        button,
        clickCount: args.clickCount || 1
      }
    });

    return {
      content: [{
        type: 'text',
        text: `### Clicked\n\nSelector: ${args.selector}\nPosition: (${x}, ${y})`
      }],
      isError: false
    };
  }

  async _handleType(args) {
    // Focus element first
    await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Runtime.evaluate',
      params: {
        expression: `document.querySelector(${JSON.stringify(args.selector)})?.focus()`,
        returnByValue: false
      }
    });

    // Type each character
    for (const char of args.text) {
      await this._transport.sendCommand('forwardCDPCommand', {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'char',
          text: char
        }
      });
    }

    return {
      content: [{
        type: 'text',
        text: `### Typed\n\nSelector: ${args.selector}\nText: ${args.text}`
      }],
      isError: false
    };
  }

  async _handlePressKey(args) {
    const key = args.key;

    // Map common keys to their key codes
    const keyCodeMap = {
      'Enter': 13,
      'Escape': 27,
      'Tab': 9,
      'Backspace': 8,
      'Delete': 46,
      'ArrowUp': 38,
      'ArrowDown': 40,
      'ArrowLeft': 37,
      'ArrowRight': 39,
      'Space': 32
    };

    const code = keyCodeMap[key];
    const text = key === 'Enter' ? '\r' : (key === 'Tab' ? '\t' : (key.length === 1 ? key : ''));

    const baseParams = {
      key: key,
      code: key,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
      text: text,
      unmodifiedText: text
    };

    // Send keyDown
    await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Input.dispatchKeyEvent',
      params: {
        type: 'keyDown',
        ...baseParams
      }
    });

    // Send keyUp
    await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Input.dispatchKeyEvent',
      params: {
        type: 'keyUp',
        ...baseParams
      }
    });

    return {
      content: [{
        type: 'text',
        text: `### Key Pressed\n\nKey: ${key}`
      }],
      isError: false
    };
  }

  async _handleHover(args) {
    // Get element location
    const elemResult = await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Runtime.evaluate',
      params: {
        expression: `
          (() => {
            const el = document.querySelector(${JSON.stringify(args.selector)});
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          })()
        `,
        returnByValue: true
      }
    });

    if (!elemResult.result || !elemResult.result.value) {
      throw new Error(`Element not found: ${args.selector}`);
    }

    const { x, y } = elemResult.result.value;

    // Move mouse
    await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Input.dispatchMouseEvent',
      params: {
        type: 'mouseMoved',
        x, y
      }
    });

    return {
      content: [{
        type: 'text',
        text: `### Hovered\n\nSelector: ${args.selector}\nPosition: (${x}, ${y})`
      }],
      isError: false
    };
  }

  async _handleSnapshot() {
    // Get accessibility tree snapshot
    const result = await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Accessibility.getFullAXTree',
      params: {}
    });

    // DEBUG: Save raw unfiltered response to file
    const fs = require('fs');
    const path = require('path');
    const debugFile = path.join(process.cwd(), 'snapshot-raw-debug.json');
    try {
      fs.writeFileSync(debugFile, JSON.stringify(result, null, 2));
      console.log(`[DEBUG] Saved raw snapshot to ${debugFile}`);
    } catch (error) {
      console.error('[DEBUG] Failed to save raw snapshot:', error);
    }

    // Build tree from flat array
    const nodes = result.nodes || [];
    const nodeMap = new Map();

    // First pass: index all nodes by ID
    for (const node of nodes) {
      nodeMap.set(node.nodeId, { ...node, children: [] });
    }

    // Second pass: build parent-child relationships
    let rootNode = null;
    for (const node of nodeMap.values()) {
      if (node.parentId) {
        const parent = nodeMap.get(node.parentId);
        if (parent) {
          parent.children.push(node);
        }
      } else {
        rootNode = node; // This is the root (no parent)
      }
    }

    // Clean, collapse, and clean again
    if (rootNode) {
      this._cleanTree(rootNode);   // First pass: remove InlineTextBox, empty elements
      this._collapseTree(rootNode); // Collapse useless wrappers
      this._cleanTree(rootNode);   // Second pass: remove buttons that now have only images
    }

    // Format snapshot as text
    const snapshot = rootNode ? this._formatAXTree([rootNode]) : 'No root node found';

    // DEBUG: Save formatted snapshot to file
    try {
      fs.writeFileSync(path.join(process.cwd(), 'snapshot-formatted-debug.txt'), `### Page Snapshot\n\n${snapshot}`);
      console.log(`[DEBUG] Saved formatted snapshot to snapshot-formatted-debug.txt`);
    } catch (error) {
      console.error('[DEBUG] Failed to save formatted snapshot:', error);
    }

    return {
      content: [{
        type: 'text',
        text: `### Page Snapshot\n\n${snapshot}`
      }],
      isError: false
    };
  }

  _cleanTree(node) {
    // Recursively clean children first
    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        this._cleanTree(child);
      }

      // Remove empty/useless children
      node.children = node.children.filter(child => {
        const role = child.role?.value || 'unknown';
        const name = child.name?.value || '';

        // Remove empty none/generic with no children
        if ((role === 'none' || role === 'generic') && !name && (!child.children || child.children.length === 0)) {
          return false;
        }

        // Remove buttons/links with only images that have no description
        if (role === 'button' || role === 'link') {
          // If it has a name, keep it
          if (name) return true;

          // If no name and no children, remove it
          if (!child.children || child.children.length === 0) {
            return false;
          }

          // If no name, check if all children are images without descriptions
          const hasOnlyUselessImages = child.children.every(c => {
            const childRole = c.role?.value || '';
            const childName = c.name?.value || '';
            return childRole === 'image' && !childName;
          });
          if (hasOnlyUselessImages) return false;
        }

        // Remove InlineTextBox children (they duplicate parent StaticText)
        if (role === 'InlineTextBox' || role === 'inlineTextBox') {
          return false;
        }

        // Remove images with no description (no alt text, no aria-label)
        if (role === 'image' && !name) {
          return false;
        }

        // Remove LabelText with no content
        if (role === 'LabelText' && !name && (!child.children || child.children.length === 0)) {
          return false;
        }

        return true;
      });
    }
  }

  _collapseTree(node) {
    // Recursively collapse children first (bottom-up)
    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        this._collapseTree(child);
      }
    }

    // Collapse useless single-child chains
    // If this node is "none"/"generic" with no text and only 1 child, skip it
    const role = node.role?.value || 'unknown';
    const name = node.name?.value || '';
    const isUseless = (role === 'none' || role === 'generic' || role === 'unknown') && !name;

    if (isUseless && node.children && node.children.length === 1) {
      // Promote the single child: replace this node's children with grandchildren
      const child = node.children[0];
      node.role = child.role;
      node.name = child.name;
      node.children = child.children || [];

      // Recursively collapse again in case we created another collapsible chain
      this._collapseTree(node);
    }
  }

  _formatAXTree(nodes, depth = 0, totalLines = { count: 0 }, maxLines = 200) {
    if (!nodes || nodes.length === 0) return '';
    if (totalLines.count >= maxLines) return '';

    let output = '';
    const indent = '  '.repeat(depth);

    // Group consecutive nodes by role to detect repetitive patterns
    const groups = [];
    let currentGroup = null;

    for (const node of nodes.slice(0, 100)) { // Process first 100 at each level
      const role = node.role?.value || 'unknown';

      if (!currentGroup || currentGroup.role !== role) {
        if (currentGroup) groups.push(currentGroup);
        currentGroup = { role, nodes: [node] };
      } else {
        currentGroup.nodes.push(node);
      }
    }
    if (currentGroup) groups.push(currentGroup);

    // Format output with deduplication
    for (const group of groups) {
      if (totalLines.count >= maxLines) break;

      if (group.nodes.length <= 3) {
        // Show all if 3 or fewer
        for (const node of group.nodes) {
          if (totalLines.count >= maxLines) break;

          const name = node.name?.value || '';
          output += `${indent}${group.role}${name ? `: ${name}` : ''}\n`;
          totalLines.count++;

          if (node.children && totalLines.count < maxLines) {
            output += this._formatAXTree(node.children, depth + 1, totalLines, maxLines);
          }
        }
      } else {
        // Repetitive pattern: show first 2, skip middle, show last 1
        const first = group.nodes.slice(0, 2);
        const last = group.nodes.slice(-1);
        const skippedCount = group.nodes.length - 3;

        for (const node of first) {
          if (totalLines.count >= maxLines) break;

          const name = node.name?.value || '';
          output += `${indent}${group.role}${name ? `: ${name}` : ''}\n`;
          totalLines.count++;

          if (node.children && totalLines.count < maxLines) {
            output += this._formatAXTree(node.children, depth + 1, totalLines, maxLines);
          }
        }

        // Only show skip message for significant repetition (10+ elements)
        if (totalLines.count < maxLines && skippedCount >= 10) {
          output += `${indent}... ${skippedCount} more ${group.role} element${skippedCount > 1 ? 's' : ''} skipped\n`;
          totalLines.count++;
        }

        for (const node of last) {
          if (totalLines.count >= maxLines) break;

          const name = node.name?.value || '';
          output += `${indent}${group.role}${name ? `: ${name}` : ''}\n`;
          totalLines.count++;

          if (node.children && totalLines.count < maxLines) {
            output += this._formatAXTree(node.children, depth + 1, totalLines, maxLines);
          }
        }
      }
    }

    // Show truncation info at root level
    if (depth === 0) {
      if (totalLines.count >= maxLines) {
        output += `\n--- Snapshot truncated at ${maxLines} lines to save context ---\n`;
      }
      if (nodes.length > 100) {
        output += `\n(Processed first 100 elements at root level, ${nodes.length - 100} more not shown)\n`;
      }
    }

    return output;
  }

  async _handleScreenshot(args) {
    const format = args.type || 'jpeg';  // Default to JPEG for smaller file size
    const quality = args.quality !== undefined ? args.quality : 80;  // Default quality 80

    // For full-page screenshots, scroll to top first to ensure sticky elements are positioned correctly
    if (args.fullPage) {
      await this._transport.sendCommand('forwardCDPCommand', {
        method: 'Runtime.evaluate',
        params: {
          expression: `
            window.scrollTo(0, 0);
            // Force layout reflow to trigger sticky element repositioning
            document.body.offsetHeight;
            // Wait for CSS animations/transitions to complete
            new Promise(resolve => setTimeout(resolve, 500));
          `,
          awaitPromise: true
        }
      });
    }

    const result = await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Page.captureScreenshot',
      params: {
        format: format,
        quality: format === 'jpeg' ? quality : undefined,  // Quality only applies to JPEG
        captureBeyondViewport: args.fullPage || false
      }
    });

    // If path is provided, save the screenshot to disk
    if (args.path && result.data) {
      const fs = require('fs');
      const buffer = Buffer.from(result.data, 'base64');
      fs.writeFileSync(args.path, buffer);

      return {
        content: [{
          type: 'text',
          text: `### Screenshot Saved\n\nFile: ${args.path}\nFormat: ${format.toUpperCase()}\nSize: ${buffer.length} bytes (${(buffer.length / 1024).toFixed(2)} KB)${args.fullPage ? '\nType: Full page' : '\nType: Viewport only'}`
        }],
        isError: false
      };
    }

    // Return base64 image if no path provided
    return {
      content: [{
        type: 'image',
        data: result.data,
        mimeType: `image/${format}`
      }],
      isError: false
    };
  }

  async _handleEvaluate(args) {
    const expression = args.function || args.expression;

    const result = await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Runtime.evaluate',
      params: {
        expression: args.function ? `(${expression})()` : expression,
        returnByValue: true,
        awaitPromise: true
      }
    });

    return {
      content: [{
        type: 'text',
        text: `### Result\n${JSON.stringify(result.result?.value, null, 2)}`
      }],
      isError: false
    };
  }

  async _handleConsoleMessages() {
    const result = await this._transport.sendCommand('getConsoleMessages');
    const messages = result.messages || [];

    if (messages.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `### Console Messages\n\nNo console messages captured yet.`
        }],
        isError: false
      };
    }

    const messageText = messages.map(msg => {
      const location = msg.url && msg.lineNumber !== undefined
        ? ` @ ${msg.url}:${msg.lineNumber}`
        : '';
      const timestamp = new Date(msg.timestamp).toLocaleTimeString();
      return `[${timestamp}] [${msg.type.toUpperCase()}] ${msg.text}${location}`;
    }).join('\n');

    return {
      content: [{
        type: 'text',
        text: `### Console Messages\n\nCaptured ${messages.length} message(s):\n\n${messageText}`
      }],
      isError: false
    };
  }

  // ==================== FORMS ====================

  async _handleFillForm(args) {
    for (const field of args.fields) {
      await this._transport.sendCommand('forwardCDPCommand', {
        method: 'Runtime.evaluate',
        params: {
          expression: `
            (() => {
              const el = document.querySelector(${JSON.stringify(field.selector)});
              if (!el) throw new Error('Element not found: ${field.selector}');
              el.value = ${JSON.stringify(field.value)};
              el.dispatchEvent(new Event('input', { bubbles: true }));
              return { success: true };
            })()
          `,
          returnByValue: true
        }
      });
    }

    return {
      content: [{
        type: 'text',
        text: `### Form Filled\n\nFilled ${args.fields.length} fields`
      }],
      isError: false
    };
  }

  // ==================== MOUSE ====================

  async _handleMouseClickXY(args) {
    const button = args.button || 'left';

    await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Input.dispatchMouseEvent',
      params: {
        type: 'mousePressed',
        x: args.x,
        y: args.y,
        button,
        clickCount: 1
      }
    });

    await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Input.dispatchMouseEvent',
      params: {
        type: 'mouseReleased',
        x: args.x,
        y: args.y,
        button,
        clickCount: 1
      }
    });

    return {
      content: [{
        type: 'text',
        text: `### Clicked at Coordinates\n\nX: ${args.x}, Y: ${args.y}`
      }],
      isError: false
    };
  }

  async _handleMouseMoveXY(args) {
    await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Input.dispatchMouseEvent',
      params: {
        type: 'mouseMoved',
        x: args.x,
        y: args.y
      }
    });

    return {
      content: [{
        type: 'text',
        text: `### Mouse Moved\n\nX: ${args.x}, Y: ${args.y}`
      }],
      isError: false
    };
  }

  async _handleDrag(args) {
    // Get source position
    const fromResult = await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Runtime.evaluate',
      params: {
        expression: `
          (() => {
            const el = document.querySelector(${JSON.stringify(args.fromSelector)});
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          })()
        `,
        returnByValue: true
      }
    });

    // Get target position
    const toResult = await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Runtime.evaluate',
      params: {
        expression: `
          (() => {
            const el = document.querySelector(${JSON.stringify(args.toSelector)});
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          })()
        `,
        returnByValue: true
      }
    });

    const from = fromResult.result?.value;
    const to = toResult.result?.value;

    if (!from || !to) {
      throw new Error('Element not found for drag operation');
    }

    // Perform drag
    await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: from.x, y: from.y, button: 'left' }
    });

    await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseMoved', x: to.x, y: to.y }
    });

    await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseReleased', x: to.x, y: to.y, button: 'left' }
    });

    return {
      content: [{
        type: 'text',
        text: `### Dragged\n\nFrom: ${args.fromSelector}\nTo: ${args.toSelector}`
      }],
      isError: false
    };
  }

  // ==================== WINDOW ====================

  async _handleWindow(args) {
    const action = args.action;

    if (action === 'resize') {
      if (!args.width || !args.height) {
        throw new Error('Width and height are required for resize action');
      }

      await this._transport.sendCommand('forwardCDPCommand', {
        method: 'Emulation.setDeviceMetricsOverride',
        params: {
          width: args.width,
          height: args.height,
          deviceScaleFactor: 1,
          mobile: false
        }
      });

      return {
        content: [{
          type: 'text',
          text: `### Window Resized\n\nWidth: ${args.width}, Height: ${args.height}`
        }],
        isError: false
      };
    }

    if (action === 'close') {
      // Close tab via extension command
      await this._transport.sendCommand('closeTab', {});

      return {
        content: [{
          type: 'text',
          text: `### Tab Closed`
        }],
        isError: false
      };
    }

    if (action === 'minimize') {
      // Minimize window using JavaScript
      await this._transport.sendCommand('forwardCDPCommand', {
        method: 'Runtime.evaluate',
        params: {
          expression: 'window.minimize ? window.minimize() : null'
        }
      });

      return {
        content: [{
          type: 'text',
          text: `### Window Minimized`
        }],
        isError: false
      };
    }

    if (action === 'maximize') {
      // Maximize window - get screen dimensions and resize
      await this._transport.sendCommand('forwardCDPCommand', {
        method: 'Runtime.evaluate',
        params: {
          expression: 'window.screen ? { width: window.screen.availWidth, height: window.screen.availHeight } : null',
          returnByValue: true
        }
      }).then(async (result) => {
        if (result.result && result.result.value) {
          const { width, height } = result.result.value;
          await this._transport.sendCommand('forwardCDPCommand', {
            method: 'Emulation.setDeviceMetricsOverride',
            params: {
              width,
              height,
              deviceScaleFactor: 1,
              mobile: false
            }
          });
        }
      });

      return {
        content: [{
          type: 'text',
          text: `### Window Maximized`
        }],
        isError: false
      };
    }

    throw new Error(`Unknown window action: ${action}`);
  }

  // ==================== WAIT ====================

  async _handleWaitFor(args) {
    const timeout = args.timeout || 30000;
    const selector = args.selector;

    await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Runtime.evaluate',
      params: {
        expression: `
          new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout')), ${timeout});
            const check = () => {
              if (document.querySelector(${JSON.stringify(selector)})) {
                clearTimeout(timeout);
                resolve(true);
              } else {
                setTimeout(check, 100);
              }
            };
            check();
          })
        `,
        awaitPromise: true,
        returnByValue: true
      }
    });

    return {
      content: [{
        type: 'text',
        text: `### Element Found\n\nSelector: ${selector}`
      }],
      isError: false
    };
  }

  // ==================== VERIFICATION ====================

  async _handleVerifyTextVisible(args) {
    const result = await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Runtime.evaluate',
      params: {
        expression: `document.body.innerText.includes(${JSON.stringify(args.text)})`,
        returnByValue: true
      }
    });

    const found = result.result?.value;

    return {
      content: [{
        type: 'text',
        text: found
          ? `### Text Found\n\nText: "${args.text}"`
          : `### Text Not Found\n\nText: "${args.text}"`
      }],
      isError: !found
    };
  }

  async _handleVerifyElementVisible(args) {
    const result = await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Runtime.evaluate',
      params: {
        expression: `
          (() => {
            const el = document.querySelector(${JSON.stringify(args.selector)});
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          })()
        `,
        returnByValue: true
      }
    });

    const visible = result.result?.value;

    return {
      content: [{
        type: 'text',
        text: visible
          ? `### Element Visible\n\nSelector: ${args.selector}`
          : `### Element Not Visible\n\nSelector: ${args.selector}`
      }],
      isError: !visible
    };
  }

  // ==================== NETWORK ====================

  async _handleNetworkRequests() {
    const result = await this._transport.sendCommand('getNetworkRequests');
    const requests = result.requests || [];

    if (requests.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `### Network Requests\n\nNo network requests captured yet.`
        }],
        isError: false
      };
    }

    const requestsText = requests.map(req => {
      const status = req.statusCode ? `${req.statusCode} ${req.statusText}` : 'Pending';
      const type = req.type ? ` [${req.type}]` : '';
      return `${req.method} ${req.url}${type}\n  Status: ${status}`;
    }).join('\n\n');

    return {
      content: [{
        type: 'text',
        text: `### Network Requests\n\nCaptured ${requests.length} request(s):\n\n${requestsText}`
      }],
      isError: false
    };
  }

  // ==================== PDF ====================

  async _handlePdfSave(args) {
    const result = await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Page.printToPDF',
      params: {}
    });

    // If path is provided, save the PDF to disk
    if (args.path && result.data) {
      const fs = require('fs');
      const buffer = Buffer.from(result.data, 'base64');
      fs.writeFileSync(args.path, buffer);

      return {
        content: [{
          type: 'text',
          text: `### PDF Saved\n\nFile: ${args.path}\nSize: ${buffer.length} bytes (${(buffer.length / 1024).toFixed(2)} KB)`
        }],
        isError: false
      };
    }

    // If no path provided, return base64 data
    return {
      content: [{
        type: 'text',
        text: `### PDF Generated\n\nBase64 data length: ${result.data?.length || 0} bytes\n\nProvide a 'path' parameter to save to disk.`
      }],
      isError: false
    };
  }

  // ==================== DIALOGS ====================

  async _handleDialog(args) {
    await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Page.handleJavaScriptDialog',
      params: {
        accept: args.accept !== false,
        promptText: args.text
      }
    });

    return {
      content: [{
        type: 'text',
        text: `### Dialog Handled\n\nAccepted: ${args.accept !== false}`
      }],
      isError: false
    };
  }

  // ==================== EXTENSION MANAGEMENT ====================

  async _handleListExtensions() {
    const result = await this._transport.sendCommand('listExtensions', {});

    const extList = (result.extensions || [])
      .map(ext => `- ${ext.name} (v${ext.version}) ${ext.enabled ? '[enabled]' : '[disabled]'}`)
      .join('\n');

    return {
      content: [{
        type: 'text',
        text: `### Chrome Extensions\n\nTotal: ${result.count}\n\n${extList}`
      }],
      isError: false
    };
  }

  async _handleReloadExtensions(args) {
    const result = await this._transport.sendCommand('reloadExtensions', {
      extensionName: args.extensionName
    });

    return {
      content: [{
        type: 'text',
        text: `### Extensions Reloaded\n\nReloaded: ${result.reloadedCount}\nExtensions: ${result.reloadedExtensions?.join(', ')}`
      }],
      isError: false
    };
  }

  // ==================== PERFORMANCE METRICS ====================

  async _handlePerformanceMetrics(args) {
    // Get current page URL
    const pageInfo = await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Target.getTargetInfo',
      params: {}
    });

    const url = pageInfo.targetInfo?.url;
    if (!url || url.startsWith('chrome://') || url.startsWith('about:')) {
      throw new Error('Cannot get metrics for chrome:// or about:// pages. Please navigate to a web page first.');
    }

    try {
      debugLog('Collecting performance metrics for:', url);

      // Get Performance metrics from CDP
      const metricsResult = await this._transport.sendCommand('forwardCDPCommand', {
        method: 'Performance.getMetrics',
        params: {}
      });

      // Get Navigation Timing and Paint Timing via JavaScript
      const timingResult = await this._transport.sendCommand('forwardCDPCommand', {
        method: 'Runtime.evaluate',
        params: {
          expression: `
            (() => {
              const perfEntries = performance.getEntriesByType('navigation')[0];
              const paintEntries = performance.getEntriesByType('paint');
              const layoutShift = performance.getEntriesByType('layout-shift');

              // Calculate Web Vitals
              const fcp = paintEntries.find(e => e.name === 'first-contentful-paint')?.startTime;
              const lcp = performance.getEntriesByType('largest-contentful-paint').slice(-1)[0]?.startTime;

              // Calculate CLS
              let cls = 0;
              layoutShift.forEach(entry => {
                if (!entry.hadRecentInput) {
                  cls += entry.value;
                }
              });

              return {
                // Navigation Timing
                domContentLoaded: perfEntries?.domContentLoadedEventEnd - perfEntries?.domContentLoadedEventStart,
                loadComplete: perfEntries?.loadEventEnd - perfEntries?.fetchStart,
                domInteractive: perfEntries?.domInteractive - perfEntries?.fetchStart,

                // Web Vitals
                fcp: fcp,
                lcp: lcp,
                cls: cls,

                // Time to First Byte
                ttfb: perfEntries?.responseStart - perfEntries?.requestStart,

                // Resource timing
                dnsTime: perfEntries?.domainLookupEnd - perfEntries?.domainLookupStart,
                tcpTime: perfEntries?.connectEnd - perfEntries?.connectStart,

                // Document size
                transferSize: perfEntries?.transferSize,
                encodedBodySize: perfEntries?.encodedBodySize,
              };
            })()
          `,
          returnByValue: true
        }
      });

      const timing = timingResult.result?.value || {};

      // Format metrics
      const formatMs = (ms) => ms ? `${Math.round(ms)}ms` : 'N/A';
      const formatSec = (ms) => ms ? `${(ms / 1000).toFixed(2)}s` : 'N/A';
      const formatBytes = (bytes) => {
        if (!bytes) return 'N/A';
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
        return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
      };

      // Evaluate performance (based on Google's thresholds)
      const evalMetric = (value, good, needsWork) => {
        if (!value) return '⚪';
        return value <= good ? '🟢' : value <= needsWork ? '🟡' : '🔴';
      };

      const fcpEmoji = evalMetric(timing.fcp, 1800, 3000);
      const lcpEmoji = evalMetric(timing.lcp, 2500, 4000);
      const clsEmoji = timing.cls <= 0.1 ? '🟢' : timing.cls <= 0.25 ? '🟡' : '🔴';

      const metricsText = `### Performance Metrics

**URL:** ${url}

**⚡ Core Web Vitals:**
${fcpEmoji} First Contentful Paint (FCP): ${formatMs(timing.fcp)}
${lcpEmoji} Largest Contentful Paint (LCP): ${formatMs(timing.lcp)}
${clsEmoji} Cumulative Layout Shift (CLS): ${timing.cls?.toFixed(3) || 'N/A'}

**📊 Load Timing:**
- Time to First Byte (TTFB): ${formatMs(timing.ttfb)}
- DOM Content Loaded: ${formatMs(timing.domContentLoaded)}
- DOM Interactive: ${formatMs(timing.domInteractive)}
- Load Complete: ${formatMs(timing.loadComplete)}

**🌐 Network:**
- DNS Lookup: ${formatMs(timing.dnsTime)}
- TCP Connection: ${formatMs(timing.tcpTime)}
- Transfer Size: ${formatBytes(timing.transferSize)}
- Encoded Size: ${formatBytes(timing.encodedBodySize)}

**Thresholds:** 🟢 Good | 🟡 Needs Improvement | 🔴 Poor
- FCP: Good <1.8s, Poor >3s
- LCP: Good <2.5s, Poor >4s
- CLS: Good <0.1, Poor >0.25`;

      return {
        content: [{
          type: 'text',
          text: metricsText
        }],
        isError: false
      };
    } catch (error) {
      debugLog('Performance metrics error:', error);
      throw new Error(`Failed to collect performance metrics: ${error.message}`);
    }
  }

  serverClosed() {
    debugLog('serverClosed');
    if (this._transport) {
      this._transport.close();
    }
  }
}

module.exports = { UnifiedBackend };
