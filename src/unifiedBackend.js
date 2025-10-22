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

  async initialize(server, clientInfo, statefulBackend) {
    this._server = server;
    this._clientInfo = clientInfo;
    // Store reference to StatefulBackend for updating attached tab info and status headers
    this._statefulBackend = statefulBackend;
    debugLog('Initialized');
  }

  /**
   * Auto-reconnect to browser if disconnected
   * @returns {Promise<boolean>} true if reconnected or already connected, false if failed
   */
  async _autoReconnectIfNeeded() {
    // Only needed in proxy mode when browser is disconnected
    if (!this._statefulBackend || !this._statefulBackend._browserDisconnected) {
      return true; // Already connected or not needed
    }

    const browserId = this._statefulBackend._lastConnectedBrowserId;
    if (!browserId) {
      debugLog('No browser ID to reconnect to');
      return false;
    }

    debugLog('Attempting auto-reconnect to browser:', browserId);

    try {
      // Get proxy connection (should still be alive)
      const mcpConnection = this._statefulBackend._proxyConnection;
      if (!mcpConnection || !mcpConnection._connected) {
        debugLog('Proxy connection not available for reconnect');
        return false;
      }

      // Try to reconnect to the same browser
      const connectResult = await mcpConnection.sendRequest('connect', { extension_id: browserId }, 5000);
      mcpConnection._connectionId = connectResult.connection_id;

      debugLog('Auto-reconnect successful!');

      // Clear disconnected flag
      this._statefulBackend._browserDisconnected = false;

      // Try to reattach to last tab if we remember it
      if (this._statefulBackend._lastAttachedTab) {
        const lastTab = this._statefulBackend._lastAttachedTab;
        debugLog('Attempting to reattach to last tab:', lastTab);

        try {
          // Try to reattach using the tab index
          await mcpConnection.sendRequest('selectTab', { tabIndex: lastTab.index }, 5000);

          // Reattachment successful - restore the tab info
          this._statefulBackend._attachedTab = lastTab;
          this._statefulBackend._lastAttachedTab = null; // Clear the backup

          debugLog('Successfully reattached to tab', lastTab.index);
        } catch (error) {
          debugLog('Failed to reattach to last tab:', error.message);
          // Don't fail the whole operation if reattach fails
          // Just clear the last tab info and continue without a tab attached
          this._statefulBackend._lastAttachedTab = null;
        }
      }

      return true;
    } catch (error) {
      debugLog('Auto-reconnect failed:', error.message);
      return false;
    }
  }

  /**
   * Add status header to response (if available)
   */
  _addStatusHeader(response) {
    // Add status header to all browser tool responses
    if (this._statefulBackend && response && response.content) {
      // Find the first text content item and prepend status header with response status
      const textContent = response.content.find(c => c && c.type === 'text');
      if (textContent && textContent.text) {
        const statusEmoji = response.isError ? '❌' : '✅';
        const statusText = response.isError ? 'Error' : 'Success';
        const header = this._statefulBackend._getStatusHeader().replace('\n---\n\n', ` | ${statusEmoji} ${statusText}\n---\n\n`);
        textContent.text = header + textContent.text;
      }
    }
    return response;
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
        description: 'STEP 2 (after enable): Manage browser tabs. List available tabs, create a new tab, attach to an existing tab for automation, or close a tab. You must attach to a tab before using other browser_ tools like navigate or interact.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'new', 'attach', 'close'],
              description: 'Action to perform'
            },
            url: {
              type: 'string',
              description: 'URL to navigate to (for new action)'
            },
            index: {
              type: 'number',
              description: 'Tab index (for attach action)'
            },
            activate: {
              type: 'boolean',
              description: 'Bring tab to foreground (default: true for new, false for attach)'
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
                    enum: ['click', 'type', 'clear', 'press_key', 'hover', 'wait', 'mouse_move', 'mouse_click', 'scroll_to', 'scroll_by', 'scroll_into_view', 'select_option', 'file_upload'],
                    description: 'Type of interaction'
                  },
                  selector: { type: 'string', description: 'CSS selector (for click, type, clear, hover, scroll_into_view, select_option, file_upload)' },
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
      },

      // Content extraction
      {
        name: 'browser_extract_content',
        description: 'Extract page content as clean markdown. Auto-detects main content by default, or extracts from full page or specific selector. Supports pagination for large content.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['auto', 'full', 'selector'],
              description: 'Extraction mode: auto (smart detection of main content), full (entire page), selector (specific element). Default: auto'
            },
            selector: {
              type: 'string',
              description: 'CSS selector to extract from (only used when mode=selector)'
            },
            max_lines: {
              type: 'number',
              description: 'Maximum lines to extract (default: 500). Use with offset for pagination.'
            },
            offset: {
              type: 'number',
              description: 'Line number to start extraction from (default: 0). Use for pagination through large content.'
            }
          }
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
      // Try to auto-reconnect if browser is disconnected
      const reconnected = await this._autoReconnectIfNeeded();
      if (!reconnected && this._statefulBackend && this._statefulBackend._browserDisconnected) {
        // Reconnect failed, return error
        const errorResponse = {
          content: [{
            type: 'text',
            text: `### Auto-Reconnect Failed\n\nAttempted to reconnect to the browser but failed.\n\n**Please try:**\n1. Check if the extension is running\n2. Call \`disable\` then \`enable\` to reset\n3. Then \`browser_connect\` to reconnect`
          }],
          isError: true
        };
        return this._addStatusHeader(errorResponse);
      }

      let result;

      // Route to appropriate handler
      switch (name) {
        case 'browser_tabs':
          result = await this._handleBrowserTabs(args);
          break;

        case 'browser_navigate':
          result = await this._handleNavigate(args);
          break;

        case 'browser_interact':
          result = await this._handleInteract(args);
          break;

        case 'browser_snapshot':
          result = await this._handleSnapshot();
          break;

        case 'browser_take_screenshot':
          result = await this._handleScreenshot(args);
          break;

        case 'browser_evaluate':
          result = await this._handleEvaluate(args);
          break;

        case 'browser_console_messages':
          result = await this._handleConsoleMessages();
          break;

        // Forms
        case 'browser_fill_form':
          result = await this._handleFillForm(args);
          break;

        // Mouse
        case 'browser_drag':
          result = await this._handleDrag(args);
          break;

        // Window
        case 'browser_window':
          result = await this._handleWindow(args);
          break;

        // Verification
        case 'browser_verify_text_visible':
          result = await this._handleVerifyTextVisible(args);
          break;

        case 'browser_verify_element_visible':
          result = await this._handleVerifyElementVisible(args);
          break;

        // Network
        case 'browser_network_requests':
          result = await this._handleNetworkRequests();
          break;

        // PDF
        case 'browser_pdf_save':
          result = await this._handlePdfSave(args);
          break;

        // Dialogs
        case 'browser_handle_dialog':
          result = await this._handleDialog(args);
          break;

        // Extension management
        case 'browser_list_extensions':
          result = await this._handleListExtensions();
          break;

        case 'browser_reload_extensions':
          result = await this._handleReloadExtensions(args);
          break;

        case 'browser_performance_metrics':
          result = await this._handlePerformanceMetrics(args);
          break;

        case 'browser_extract_content':
          result = await this._handleExtractContent(args);
          break;

        default:
          throw new Error(`Tool '${name}' not implemented yet`);
      }

      // Add status header to all browser tool responses
      return this._addStatusHeader(result);
    } catch (error) {
      debugLog(`Error in ${name}:`, error);

      // Detect browser disconnection
      const errorMsg = error.message || String(error);
      if (errorMsg.includes('No active connection')) {
        debugLog('Browser disconnection detected in error handler');

        const errorResponse = {
          content: [{
            type: 'text',
            text: `### Browser Extension Disconnected\n\nThe browser extension has disconnected from the proxy (likely due to extension reload).\n\nCheck the status above - it should now show "⚠️ Browser Disconnected".\n\n**The extension will auto-reconnect** within a few seconds. Once reconnected:\n1. Try your command again\n2. You'll automatically reconnect to the same browser\n3. Then attach to a tab if needed\n\n**Note:** Your proxy connection is still active - no need to call \`disable\` or \`enable\` again!`
          }],
          isError: true
        };
        return this._addStatusHeader(errorResponse);
      }

      const errorResponse = {
        content: [{
          type: 'text',
          text: `### Error\n${errorMsg}`
        }],
        isError: true
      };
      return this._addStatusHeader(errorResponse);
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

      // Store attached tab info for status tracking
      if (this._statefulBackend) {
        this._statefulBackend._attachedTab = {
          index: tabIndex,
          title: result.tab?.title || newTab?.title,
          url: args.url || 'about:blank'
        };
      }

      return {
        content: [{
          type: 'text',
          text: `### Tab Created and Attached\n\nURL: ${args.url || 'about:blank'}\nTab ID: ${result.tab?.id}\nTab Index: ${tabIndex}\n\n**This tab is now attached.** All browser commands will execute on this tab.\n\n**Note:** The tab was inserted at index ${tabIndex} (not necessarily at the end of the list).`
        }],
        isError: false
      };
    }

    if (action === 'attach') {
      const result = await this._transport.sendCommand('selectTab', {
        tabIndex: args.index,
        activate: args.activate !== false,
        stealth: args.stealth || false
      });

      // Store attached tab info for status tracking
      if (this._statefulBackend) {
        this._statefulBackend._attachedTab = {
          index: args.index,
          title: result.tab?.title,
          url: result.tab?.url
        };
      }

      return {
        content: [{
          type: 'text',
          text: `### ✅ Tab Attached\n\n**Index:** ${args.index}\n**Title:** ${result.tab?.title}\n**URL:** ${result.tab?.url || 'N/A'}`
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

  /**
   * Validate CSS selector - reject common accessibility role names
   */
  _validateSelector(selector, context = '') {
    // Common accessibility roles that should not be used as CSS selectors
    const INVALID_SELECTORS = [
      'textbox', 'button', 'link', 'heading', 'list', 'listitem',
      'checkbox', 'radio', 'combobox', 'menu', 'menuitem', 'tab',
      'tabpanel', 'dialog', 'alertdialog', 'toolbar', 'tooltip',
      'navigation', 'search', 'banner', 'main', 'contentinfo',
      'complementary', 'region', 'article', 'form', 'table',
      'row', 'cell', 'columnheader', 'rowheader', 'grid',
      'StaticText', 'paragraph', 'figure', 'img', 'image'
    ];

    if (INVALID_SELECTORS.includes(selector)) {
      const suggestion = context ? ` ${context}` : '';
      throw new Error(
        `Invalid selector "${selector}". This is an accessibility role, not a CSS selector.${suggestion}\n\n` +
        `Use CSS selectors instead:\n` +
        `  - input[type="text"], input[placeholder="..."]  (for text fields)\n` +
        `  - button, button[type="submit"]  (for buttons)\n` +
        `  - #id, .class-name  (for any element with id or class)\n` +
        `  - a[href="..."]  (for links)\n\n` +
        `Check the accessibility snapshot for element names and values to construct proper selectors.`
      );
    }
  }

  async _handleInteract(args) {
    const actions = args.actions || [];
    const onError = args.onError || 'stop';
    const results = [];

    // Get tabs before interactions to detect new tabs
    const tabsBeforeResult = await this._transport.sendCommand('getTabs', {});
    const tabsBefore = tabsBeforeResult.tabs || [];
    const tabIdsBefore = new Set(tabsBefore.map(t => t.id));

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const actionIndex = i + 1;

      try {
        let result = null;

        switch (action.type) {
          case 'click': {
            // Validate selector
            this._validateSelector(action.selector);

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
            // Validate selector
            this._validateSelector(action.selector);

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

            // Get the final value of the field after typing
            const valueResult = await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Runtime.evaluate',
              params: {
                expression: `document.querySelector(${JSON.stringify(action.selector)})?.value`,
                returnByValue: true
              }
            });

            // Check if querySelector found the element
            if (valueResult.result?.type === 'undefined') {
              result = `Typed "${action.text}" into ${action.selector} (⚠️ value not verified - selector may not match typed element)`;
            } else {
              const finalValue = valueResult.result?.value || '';
              result = `Typed "${action.text}" into ${action.selector} (final value: "${finalValue}")`;
            }
            break;
          }

          case 'clear': {
            // Validate selector
            this._validateSelector(action.selector);

            // Clear the field by selecting all and deleting
            await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Runtime.evaluate',
              params: {
                expression: `
                  (() => {
                    const el = document.querySelector(${JSON.stringify(action.selector)});
                    if (!el) return false;
                    el.value = '';
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                  })()
                `,
                returnByValue: true
              }
            });

            result = `Cleared ${action.selector}`;
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
            // Validate selector
            this._validateSelector(action.selector);

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
            // Validate selector
            this._validateSelector(action.selector);

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
            // Validate selector
            this._validateSelector(action.selector);

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
            // Validate selector
            this._validateSelector(action.selector);

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

    // Detect new tabs opened during interactions
    const tabsAfterResult = await this._transport.sendCommand('getTabs', {});
    const tabsAfter = tabsAfterResult.tabs || [];
    const newTabs = tabsAfter.filter(t => !tabIdsBefore.has(t.id));

    let newTabsInfo = '';
    if (newTabs.length > 0) {
      newTabsInfo = '\n\n### 🆕 New Tabs Opened\n\n';
      newTabs.forEach(tab => {
        const title = tab.title || 'Untitled';
        const url = tab.url || 'N/A';
        newTabsInfo += `**Tab ${tab.index}:** ${title}\n`;
        newTabsInfo += `**URL:** ${url}\n\n`;
      });
    }

    return {
      content: [{
        type: 'text',
        text: `### Interactions Complete\n\nTotal: ${results.length}\nSucceeded: ${successCount}\nFailed: ${errorCount}\n\n${summary}${newTabsInfo}`
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

  /**
   * Generate CSS selector hint for interactive elements
   */
  _generateSelectorHint(role, name, value) {
    // Only provide hints for interactive form elements
    const interactiveRoles = ['textbox', 'combobox', 'searchbox', 'spinbutton'];

    if (!interactiveRoles.includes(role)) {
      return ''; // No hint for non-form elements
    }

    // Provide generic hint - we can't reliably suggest selectors from ARIA tree alone
    // The 'name' is accessible name (from label/aria-label), not necessarily a real attribute
    return ` [CSS: #id, input[type="..."], or input[name="..."]]`;
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
          const value = node.value?.value || '';
          const nameStr = name ? `: ${name}` : '';
          const valueStr = value ? `\n${indent}  value: "${value}"` : '';
          const selectorHint = this._generateSelectorHint(group.role, name, value);
          output += `${indent}${group.role}${nameStr}${selectorHint}${valueStr}\n`;
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
          const value = node.value?.value || '';
          const nameStr = name ? `: ${name}` : '';
          const valueStr = value ? `\n${indent}  value: "${value}"` : '';
          const selectorHint = this._generateSelectorHint(group.role, name, value);
          output += `${indent}${group.role}${nameStr}${selectorHint}${valueStr}\n`;
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
          const value = node.value?.value || '';
          const nameStr = name ? `: ${name}` : '';
          const valueStr = value ? `\n${indent}  value: "${value}"` : '';
          const selectorHint = this._generateSelectorHint(group.role, name, value);
          output += `${indent}${group.role}${nameStr}${selectorHint}${valueStr}\n`;
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

  async _handleExtractContent(args) {
    const mode = args.mode || 'auto';
    const selector = args.selector;
    const maxLines = args.max_lines || 250;
    const offset = args.offset || 0;

    debugLog(`Extracting content in ${mode} mode${selector ? ` with selector: ${selector}` : ''}, max_lines: ${maxLines}, offset: ${offset}`);

    try {
      // Execute content extraction in browser context
      const result = await this._transport.sendCommand('forwardCDPCommand', {
        method: 'Runtime.evaluate',
        params: {
          expression: `
            (() => {
              const mode = ${JSON.stringify(mode)};
              const customSelector = ${JSON.stringify(selector)};

              // HTML to Markdown converter
              function htmlToMarkdown(element, baseUrl) {
                let markdown = '';

                function processNode(node, indent = '') {
                  if (node.nodeType === Node.TEXT_NODE) {
                    const text = node.textContent.trim();
                    if (text) markdown += text + ' ';
                    return;
                  }

                  if (node.nodeType !== Node.ELEMENT_NODE) return;

                  const tag = node.tagName.toLowerCase();

                  // Skip script, style, noscript
                  if (['script', 'style', 'noscript', 'svg'].includes(tag)) return;

                  switch (tag) {
                    case 'h1':
                      markdown += '\\n\\n# ' + node.textContent.trim() + '\\n\\n';
                      break;
                    case 'h2':
                      markdown += '\\n\\n## ' + node.textContent.trim() + '\\n\\n';
                      break;
                    case 'h3':
                      markdown += '\\n\\n### ' + node.textContent.trim() + '\\n\\n';
                      break;
                    case 'h4':
                      markdown += '\\n\\n#### ' + node.textContent.trim() + '\\n\\n';
                      break;
                    case 'h5':
                      markdown += '\\n\\n##### ' + node.textContent.trim() + '\\n\\n';
                      break;
                    case 'h6':
                      markdown += '\\n\\n###### ' + node.textContent.trim() + '\\n\\n';
                      break;

                    case 'p':
                      markdown += '\\n\\n';
                      Array.from(node.childNodes).forEach(child => processNode(child, indent));
                      markdown += '\\n\\n';
                      break;

                    case 'a':
                      const href = node.getAttribute('href');
                      const text = node.textContent.trim();
                      if (href && text) {
                        const fullUrl = new URL(href, baseUrl).href;
                        markdown += \`[\${text}](\${fullUrl})\`;
                      } else if (text) {
                        markdown += text;
                      }
                      break;

                    case 'img':
                      const src = node.getAttribute('src');
                      const alt = node.getAttribute('alt') || '';
                      if (src) {
                        const fullSrc = new URL(src, baseUrl).href;
                        markdown += \`\\n\\n![\${alt}](\${fullSrc})\\n\\n\`;
                      }
                      break;

                    case 'strong':
                    case 'b':
                      markdown += '**' + node.textContent.trim() + '**';
                      break;

                    case 'em':
                    case 'i':
                      markdown += '*' + node.textContent.trim() + '*';
                      break;

                    case 'code':
                      if (node.parentElement.tagName.toLowerCase() === 'pre') {
                        // Already handled in pre
                        return;
                      }
                      markdown += \`\\\`\${node.textContent.trim()}\\\`\`;
                      break;

                    case 'pre':
                      const code = node.querySelector('code');
                      const codeText = code ? code.textContent : node.textContent;
                      markdown += \`\\n\\n\\\`\\\`\\\`\\n\${codeText}\\n\\\`\\\`\\\`\\n\\n\`;
                      break;

                    case 'ul':
                      markdown += '\\n';
                      Array.from(node.children).forEach(li => {
                        if (li.tagName.toLowerCase() === 'li') {
                          markdown += indent + '- ';
                          Array.from(li.childNodes).forEach(child => processNode(child, indent + '  '));
                          markdown += '\\n';
                        }
                      });
                      markdown += '\\n';
                      break;

                    case 'ol':
                      markdown += '\\n';
                      Array.from(node.children).forEach((li, idx) => {
                        if (li.tagName.toLowerCase() === 'li') {
                          markdown += indent + (idx + 1) + '. ';
                          Array.from(li.childNodes).forEach(child => processNode(child, indent + '   '));
                          markdown += '\\n';
                        }
                      });
                      markdown += '\\n';
                      break;

                    case 'blockquote':
                      markdown += '\\n\\n> ';
                      Array.from(node.childNodes).forEach(child => processNode(child, indent));
                      markdown += '\\n\\n';
                      break;

                    case 'hr':
                      markdown += '\\n\\n---\\n\\n';
                      break;

                    case 'br':
                      markdown += '  \\n';
                      break;

                    case 'table':
                      // Skip tables for now - they're complex
                      markdown += '\\n\\n[Table content omitted]\\n\\n';
                      break;

                    default:
                      // Process children for other elements
                      Array.from(node.childNodes).forEach(child => processNode(child, indent));
                      break;
                  }
                }

                processNode(element);
                return markdown;
              }

              // Find content area based on mode
              let contentElement;

              if (mode === 'selector') {
                if (!customSelector) {
                  throw new Error('Selector required when mode is "selector"');
                }
                contentElement = document.querySelector(customSelector);
                if (!contentElement) {
                  throw new Error(\`Element not found: \${customSelector}\`);
                }
              } else if (mode === 'full') {
                contentElement = document.body;
              } else {
                // Auto mode - smart detection
                // Try common main content selectors
                const selectors = [
                  'article',
                  'main',
                  '[role="main"]',
                  '.content',
                  '#content',
                  '.post',
                  '.article'
                ];

                for (const sel of selectors) {
                  const el = document.querySelector(sel);
                  if (el && el.textContent.trim().length > 200) {
                    contentElement = el;
                    break;
                  }
                }

                // Fallback to body if nothing found
                if (!contentElement) {
                  contentElement = document.body;
                }
              }

              // Convert to markdown
              const markdown = htmlToMarkdown(contentElement, window.location.href);

              // Clean up excessive whitespace
              const cleaned = markdown
                .replace(/\\n{3,}/g, '\\n\\n')  // Max 2 consecutive newlines
                .replace(/[ \\t]+/g, ' ')       // Collapse spaces
                .trim();

              return {
                markdown: cleaned,
                mode: mode,
                detectedSelector: mode === 'auto' ? (contentElement.tagName.toLowerCase() + (contentElement.className ? '.' + contentElement.className.split(' ')[0] : '')) : null,
                contentLength: cleaned.length
              };
            })()
          `,
          returnByValue: true
        }
      });

      const data = result.result?.value;
      if (!data || !data.markdown) {
        throw new Error('Failed to extract content');
      }

      // Apply line-based pagination
      const lines = data.markdown.split('\n');
      const totalLines = lines.length;
      const startLine = Math.min(offset, totalLines);
      const endLine = Math.min(startLine + maxLines, totalLines);
      const chunk = lines.slice(startLine, endLine).join('\n');
      const truncated = endLine < totalLines;

      let infoText = `### Extracted Content\n\n`;
      infoText += `**Mode:** ${data.mode}\n`;
      if (data.detectedSelector) {
        infoText += `**Detected element:** ${data.detectedSelector}\n`;
      }
      infoText += `**Total lines:** ${totalLines}\n`;
      infoText += `**Showing:** lines ${startLine + 1}-${endLine} (${endLine - startLine} lines)\n`;
      if (truncated) {
        infoText += `**⚠️ Truncated:** Use offset=${endLine} to get next chunk\n`;
      }
      infoText += `\n---\n\n`;
      infoText += chunk;

      return {
        content: [{
          type: 'text',
          text: infoText
        }],
        isError: false
      };
    } catch (error) {
      debugLog('Content extraction error:', error);
      throw new Error(`Failed to extract content: ${error.message}`);
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
