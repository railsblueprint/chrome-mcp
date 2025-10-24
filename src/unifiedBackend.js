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
      // DEBUG: Show what _attachedTab is (only in debug mode)
      const debugInfo = global.DEBUG_MODE
        ? `\n🐛 DEBUG: _attachedTab = ${JSON.stringify(this._statefulBackend._attachedTab)}\n`
        : '';

      // Find the first text content item and prepend status header with response status
      const textContent = response.content.find(c => c && c.type === 'text');
      if (textContent && textContent.text) {
        const statusEmoji = response.isError ? '❌' : '✅';
        const statusText = response.isError ? 'Error' : 'Success';
        const header = this._statefulBackend._getStatusHeader().replace('\n---\n\n', ` | ${statusEmoji} ${statusText}\n---\n\n`);
        textContent.text = header + debugInfo + textContent.text;
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
        description: 'Perform one or more browser interactions in sequence (click, type, press keys, hover, scroll, wait). Scroll actions report success/failure and detect all scrollable areas on the page.',
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
                  selector: { type: 'string', description: 'CSS selector (for click, type, clear, hover, scroll_to, scroll_by, scroll_into_view, select_option, file_upload). For scroll_to/scroll_by: scrolls the element instead of the window' },
                  text: { type: 'string', description: 'Text to type (for type action)' },
                  key: { type: 'string', description: 'Key to press (for press_key action)' },
                  value: { type: 'string', description: 'Option value to select (for select_option action)' },
                  files: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'File paths to upload (for file_upload action)'
                  },
                  x: { type: 'number', description: 'X coordinate in viewport coordinates (for mouse_move, mouse_click, scroll_to, scroll_by). Use viewport size, NOT screenshot pixel dimensions!' },
                  y: { type: 'number', description: 'Y coordinate in viewport coordinates (for mouse_move, mouse_click, scroll_to, scroll_by). Use viewport size, NOT screenshot pixel dimensions!' },
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

      // Lookup elements
      {
        name: 'browser_lookup',
        description: 'Search for elements by text content and return their selectors and details. Useful for finding the right selector before clicking. Works like the "Did you mean?" feature but returns results directly instead of failing first.',
        inputSchema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'Text to search for in elements'
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return (default: 10)'
            }
          },
          required: ['text']
        }
      },

      // Screenshot
      {
        name: 'browser_take_screenshot',
        description: 'Capture screenshot of the page (default: JPEG quality 80, viewport only, 1:1 scale). Returns image data if no path provided, saves to file if path is specified.',
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default: jpeg)' },
            fullPage: { type: 'boolean', description: 'Capture full page (default: false, viewport only)' },
            quality: { type: 'number', description: 'JPEG quality 0-100 (default: 80)' },
            path: { type: 'string', description: 'Optional: file path to save screenshot. If provided, saves to disk instead of returning image data.' },
            highlightClickables: { type: 'boolean', description: 'Highlight clickable elements with green border and background (default: false)' },
            deviceScale: { type: 'number', description: 'Device scale factor for pixel-perfect screenshots (default: 1 for 1:1, use 0 for device native)' }
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
        description: 'Powerful network monitoring and replay tool with multiple actions: list (lightweight overview with filtering/pagination), details (full request/response with headers/bodies), replay (re-execute request), clear (free memory). Supports JSONPath filtering for large JSON responses.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'details', 'replay', 'clear'],
              description: 'Action to perform: list (default, shows requests with filtering/pagination), details (get full data for specific request), replay (re-execute request), clear (clear history)'
            },
            // List action filters
            urlPattern: {
              type: 'string',
              description: 'Filter requests by URL substring (case-insensitive, for list action). Example: "api/users"'
            },
            method: {
              type: 'string',
              description: 'Filter by HTTP method (for list action). Example: "GET", "POST"'
            },
            status: {
              type: 'number',
              description: 'Filter by HTTP status code (for list action). Example: 200, 404, 500'
            },
            resourceType: {
              type: 'string',
              description: 'Filter by resource type (for list action). Examples: "document", "xhr", "fetch", "script", "stylesheet", "image"'
            },
            limit: {
              type: 'number',
              description: 'Maximum number of requests to return (for list action, default: 20)'
            },
            offset: {
              type: 'number',
              description: 'Number of requests to skip for pagination (for list action, default: 0)'
            },
            // Details/replay actions
            requestId: {
              type: 'string',
              description: 'Request ID from list view (required for details/replay actions). Format: "12345.67"'
            },
            jsonPath: {
              type: 'string',
              description: 'JSONPath query to filter large JSON responses (optional, for details action). Examples: "$.data.items[0]", "$..name", "$.items[?(@.price < 100)]"'
            }
          }
        }
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
          result = await this._handleNetworkRequests(args);
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

        case 'browser_lookup':
          result = await this._handleLookup(args);
          break;

        default:
          throw new Error(`Tool '${name}' not implemented yet`);
      }

      // Add status header to all browser tool responses
      return this._addStatusHeader(result);
    } catch (error) {
      debugLog(`Error in ${name}:`, error);

      // Detect no tab attached error (different from extension disconnected)
      const errorMsg = error.message || String(error);
      if (errorMsg.includes('No active connection')) {
        debugLog('No tab attached - connection to tab lost');

        const errorResponse = {
          content: [{
            type: 'text',
            text: `### No Tab Attached\n\nThe browser tab connection was lost (tab was closed or detached).\n\n**To continue:**\n1. Call \`browser_tabs action='list'\` to see available tabs\n2. Call \`browser_tabs action='attach' index=N\` to attach to a tab\n3. Or call \`browser_tabs action='new' url='https://...'\` to create a new tab\n\n**Note:** The browser extension is still connected - only the tab attachment was lost.`
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
          text: `### Tab Created and Attached\n\nURL: ${args.url || 'about:blank'}\nTab ID: ${result.tab?.id}\nTab Index: ${tabIndex}\n\n**This tab is now attached.** All browser commands will execute on this tab.\n\n**Note:** The tab was inserted at index ${tabIndex} (not necessarily at the end of the list).\n\n**Next Steps:**\n- \`browser_take_screenshot\` - Capture visual appearance of the page\n- \`browser_snapshot\` - Get accessibility tree structure for interactions\n- \`browser_extract_content\` - Extract page content as clean markdown`
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
          text: `### ✅ Tab Attached\n\n**Index:** ${args.index}\n**Title:** ${result.tab?.title}\n**URL:** ${result.tab?.url || 'N/A'}\n\n**Next Steps:**\n- \`browser_take_screenshot\` - Capture visual appearance of the page\n- \`browser_snapshot\` - Get accessibility tree structure for interactions\n- \`browser_extract_content\` - Extract page content as clean markdown`
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
   * Find all matching elements with visibility information
   * Returns array of {x, y, visible, reason} objects
   */
  async _findAllElements(selectorOrObj) {
    // Handle :has-text() selector
    if (typeof selectorOrObj === 'object' && selectorOrObj.type === 'has-text') {
      const result = await this._transport.sendCommand('forwardCDPCommand', {
        method: 'Runtime.evaluate',
        params: {
          expression: `
            (() => {
              const baseSelector = ${JSON.stringify(selectorOrObj.baseSelector)};
              const searchText = ${JSON.stringify(selectorOrObj.searchText)};
              const elements = document.querySelectorAll(baseSelector);
              const matches = [];

              for (const el of elements) {
                const text = (el.textContent || el.innerText || '').trim();
                const searchTextLower = searchText.trim().toLowerCase();
                if (text.toLowerCase().includes(searchTextLower)) {
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);

                  // Check visibility
                  let visible = true;
                  let reason = '';

                  if (style.display === 'none') {
                    visible = false;
                    reason = 'display: none';
                  } else if (style.visibility === 'hidden') {
                    visible = false;
                    reason = 'visibility: hidden';
                  } else if (style.opacity === '0') {
                    visible = false;
                    reason = 'opacity: 0';
                  } else if (rect.width === 0 || rect.height === 0) {
                    visible = false;
                    reason = 'zero size';
                  }

                  matches.push({
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                    visible: visible,
                    reason: reason
                  });
                }
              }
              return matches;
            })()
          `,
          returnByValue: true
        }
      });

      return result.result?.value || [];
    }

    // Handle regular CSS selector
    const result = await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Runtime.evaluate',
      params: {
        expression: `
          (() => {
            const elements = document.querySelectorAll(${JSON.stringify(selectorOrObj)});
            const matches = [];

            for (const el of elements) {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);

              // Check visibility
              let visible = true;
              let reason = '';

              if (style.display === 'none') {
                visible = false;
                reason = 'display: none';
              } else if (style.visibility === 'hidden') {
                visible = false;
                reason = 'visibility: hidden';
              } else if (style.opacity === '0') {
                visible = false;
                reason = 'opacity: 0';
              } else if (rect.width === 0 || rect.height === 0) {
                visible = false;
                reason = 'zero size';
              }

              matches.push({
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                visible: visible,
                reason: reason
              });
            }
            return matches;
          })()
        `,
        returnByValue: true
      }
    });

    return result.result?.value || [];
  }

  /**
   * Find element and return its coordinates (prioritizes visible elements)
   * Handles both regular CSS selectors and :has-text() pseudo-selectors
   * Returns: { x, y, warning } or null
   */
  async _findElement(selectorOrObj) {
    const matches = await this._findAllElements(selectorOrObj);

    if (matches.length === 0) {
      return null;
    }

    // Prioritize visible elements
    const visibleMatches = matches.filter(m => m.visible);
    const hiddenMatches = matches.filter(m => !m.visible);

    let warning = '';
    if (matches.length > 1) {
      warning = `Found ${matches.length} matching elements`;
      if (visibleMatches.length > 0 && hiddenMatches.length > 0) {
        warning += ` (${visibleMatches.length} visible, ${hiddenMatches.length} hidden)`;
      }
      if (visibleMatches.length > 1) {
        warning += `. Clicked first visible element.`;
      } else if (visibleMatches.length === 1) {
        warning += `. Clicked the visible one.`;
      } else {
        warning += `. All hidden - clicked first one (${matches[0].reason}).`;
      }
    } else if (matches.length === 1 && !matches[0].visible) {
      warning = `Element is hidden (${matches[0].reason})`;
    }

    // Use first visible element, or first element if all hidden
    const selectedMatch = visibleMatches.length > 0 ? visibleMatches[0] : matches[0];

    return {
      x: selectedMatch.x,
      y: selectedMatch.y,
      warning: warning
    };
  }

  /**
   * Find alternative selectors when original selector fails
   * For :has-text() selectors, searches for broader matches
   */
  async _findAlternativeSelectors(processedSelector, originalSelector) {
    // Only works for :has-text() selectors with a base selector
    if (typeof processedSelector !== 'object' || processedSelector.type !== 'has-text') {
      return [];
    }

    const { searchText, baseSelector } = processedSelector;

    // If base selector is already '*', no broader search possible
    if (baseSelector === '*') {
      return [];
    }

    // Search for any element containing the text (using broader :has-text)
    const broaderSelector = { type: 'has-text', baseSelector: '*', searchText };
    const matches = await this._findAllElements(broaderSelector);

    if (matches.length === 0) {
      return [];
    }

    // Get actual selectors for each match
    const result = await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Runtime.evaluate',
      params: {
        expression: `
          (() => {
            const searchText = ${JSON.stringify(searchText)};
            const searchTextLower = searchText.trim().toLowerCase();
            const elements = document.querySelectorAll('*');
            const alternatives = [];

            for (const el of elements) {
              // Get direct text content (not including children)
              let directText = '';
              for (const node of el.childNodes) {
                if (node.nodeType === Node.TEXT_NODE) {
                  directText += node.textContent;
                }
              }
              directText = directText.trim();

              // Only match if the direct text contains the search text
              if (directText.toLowerCase().includes(searchTextLower)) {
                // Generate a meaningful selector for this element
                let selector = el.tagName.toLowerCase();

                // Add ID if present
                if (el.id) {
                  selector += '#' + el.id;
                }
                // Or add classes (up to 2 most specific)
                else if (el.className && typeof el.className === 'string') {
                  const classes = el.className.trim().split(/\\s+/).filter(c => c);
                  if (classes.length > 0) {
                    selector += '.' + classes.slice(0, 2).join('.');
                  }
                }
                // Or add role if present
                else if (el.getAttribute('role')) {
                  selector += '[role="' + el.getAttribute('role') + '"]';
                }

                // Check visibility
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                const visible = style.display !== 'none' &&
                               style.visibility !== 'hidden' &&
                               style.opacity !== '0' &&
                               rect.width > 0 && rect.height > 0;

                alternatives.push({
                  selector: selector,
                  visible: visible,
                  text: directText.length > 50 ? directText.substring(0, 50) + '...' : directText
                });
              }
            }

            // Return up to 5 alternatives, prioritize visible ones
            const visibleAlts = alternatives.filter(a => a.visible);
            const hiddenAlts = alternatives.filter(a => !a.visible);
            const shown = [...visibleAlts.slice(0, 3), ...hiddenAlts.slice(0, 2)];

            return {
              alternatives: shown,
              totalCount: alternatives.length
            };
          })()
        `,
        returnByValue: true
      }
    });

    const data = result.result?.value || { alternatives: [], totalCount: 0 };
    return {
      alternatives: data.alternatives || [],
      totalCount: data.totalCount || 0
    };
  }

  /**
   * Validate CSS selector - reject common accessibility role names
   */
  /**
   * Process selector: preprocess + validate
   * Returns processed selector (string or object for :has-text)
   */
  _processSelector(selector) {
    const processed = this._preprocessSelector(selector);
    // Only validate if it's a simple string selector (not :has-text object)
    if (typeof processed === 'string') {
      this._validateSelector(processed);
    }
    return processed;
  }

  /**
   * Get JavaScript expression to find element by processed selector
   * For use in Runtime.evaluate when you need the element itself (not just coordinates)
   */
  _getSelectorExpression(selectorOrObj) {
    if (typeof selectorOrObj === 'object' && selectorOrObj.type === 'has-text') {
      // Generate JS to find element by text
      return `(() => {
        const baseSelector = ${JSON.stringify(selectorOrObj.baseSelector)};
        const searchText = ${JSON.stringify(selectorOrObj.searchText)};
        const elements = document.querySelectorAll(baseSelector);
        for (const el of elements) {
          const text = el.textContent || el.innerText || '';
          if (text.includes(searchText)) return el;
        }
        return null;
      })()`;
    }
    // Regular CSS selector
    return `document.querySelector(${JSON.stringify(selectorOrObj)})`;
  }

  /**
   * Preprocess selector to translate Playwright-like syntax to valid CSS
   * Supports:
   * - 'button' -> button, input[type="button"], input[type="submit"], a.btn, a[role="button"]
   * - ':has-text("...")' -> custom JS evaluation to find element by text content
   */
  _preprocessSelector(selector) {
    if (!selector) return selector;

    // Handle :has-text() pseudo-selector
    // Pattern: :has-text("some text") or :has-text('some text')
    const hasTextMatch = selector.match(/:has-text\(["']([^"']+)["']\)/);
    if (hasTextMatch) {
      const searchText = hasTextMatch[1];
      let baseSelectorPart = selector.substring(0, hasTextMatch.index);

      // Expand 'button' in the base selector before creating has-text object
      if (baseSelectorPart === 'button') {
        baseSelectorPart = 'button, input[type="button"], input[type="submit"], a.btn, a[role="button"]';
      } else if (baseSelectorPart.startsWith('button.') || baseSelectorPart.startsWith('button#') || baseSelectorPart.startsWith('button[')) {
        const rest = baseSelectorPart.substring(6); // Remove 'button'
        baseSelectorPart = `button${rest}, input[type="button"]${rest}, input[type="submit"]${rest}`;
      }

      // Return special marker that will be handled in element finding
      return {
        type: 'has-text',
        baseSelector: baseSelectorPart || '*',
        searchText: searchText,
        originalSelector: selector
      };
    }

    // Handle standalone 'button' selector
    if (selector === 'button') {
      return 'button, input[type="button"], input[type="submit"], a.btn, a[role="button"]';
    }

    // Handle 'button' with additional selectors (e.g., 'button.primary')
    if (selector.startsWith('button.') || selector.startsWith('button#') || selector.startsWith('button[')) {
      const rest = selector.substring(6); // Remove 'button'
      return `button${rest}, input[type="button"]${rest}, input[type="submit"]${rest}`;
    }

    return selector;
  }

  _validateSelector(selector, context = '') {
    // Common accessibility roles that should NOT be used as CSS selectors
    const INVALID_SELECTORS = [
      'textbox', 'link', 'heading', 'list', 'listitem',
      'checkbox', 'radio', 'combobox', 'menu', 'menuitem', 'tab',
      'tabpanel', 'dialog', 'alertdialog', 'toolbar', 'tooltip',
      'navigation', 'search', 'banner', 'main', 'contentinfo',
      'complementary', 'region', 'article', 'form', 'table',
      'row', 'cell', 'columnheader', 'rowheader', 'grid',
      'StaticText', 'paragraph', 'figure', 'img', 'image'
    ];

    // Note: 'button' is now allowed and will be preprocessed

    if (INVALID_SELECTORS.includes(selector)) {
      const suggestion = context ? ` ${context}` : '';
      throw new Error(
        `Invalid selector "${selector}". This is an accessibility role, not a CSS selector.${suggestion}\n\n` +
        `Use CSS selectors instead:\n` +
        `  - input[type="text"], input[placeholder="..."]  (for text fields)\n` +
        `  - button, button[type="submit"]  (for buttons)\n` +
        `  - #id, .class-name  (for any element with id or class)\n` +
        `  - a[href="..."]  (for links)\n` +
        `  - button:has-text("Click me")  (for buttons with text)\n\n` +
        `Check the accessibility snapshot for element names and values to construct proper selectors.`
      );
    }
  }

  async _handleInteract(args) {
    const actions = args.actions || [];
    const onError = args.onError || 'stop';
    const results = [];

    // Install/check iframe monitor
    const iframeChanges = await this._checkIframeChanges();

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
            // Process selector (preprocess + validate)
            const processedSelector = this._processSelector(action.selector);

            // Get element location
            const elemResult = await this._findElement(processedSelector);

            if (!elemResult) {
              // Try to find alternative selectors
              let errorMsg = `Element not found: ${action.selector}`;

              // If it's a :has-text() with a tag selector, search for alternatives
              if (typeof processedSelector === 'object' && processedSelector.type === 'has-text' &&
                  processedSelector.baseSelector !== '*') {
                const result = await this._findAlternativeSelectors(processedSelector, action.selector);
                const alternatives = result.alternatives;
                const totalCount = result.totalCount;

                if (alternatives.length > 0) {
                  errorMsg += `\n\nDid you mean?`;
                  alternatives.forEach((alt, i) => {
                    const visibility = alt.visible ? '✓' : '✗ (hidden)';
                    errorMsg += `\n  ${i + 1}. ${alt.selector}:has-text('${processedSelector.searchText}') ${visibility}`;
                    if (alt.text) {
                      errorMsg += `\n     Text: "${alt.text}"`;
                    }
                  });

                  // Show count of additional matches if there are more
                  if (totalCount > alternatives.length) {
                    const remaining = totalCount - alternatives.length;
                    errorMsg += `\n  And ${remaining} more...`;
                  }
                } else {
                  errorMsg += `\n\n💡 No elements found with text: "${processedSelector.searchText}"`;
                }

                errorMsg += `\n\n💡 Other options:`;
                errorMsg += `\n- Take screenshot with highlightClickables=true to see all clickable elements`;
                errorMsg += `\n- Use mouse_click action with coordinates if you know the position`;
              } else {
                errorMsg += `\n\n💡 Suggestions:`;
                errorMsg += `\n- Take screenshot with highlightClickables=true to see clickable elements`;
                errorMsg += `\n- Use browser_snapshot to inspect page structure`;
              }

              throw new Error(errorMsg);
            }

            const { x, y, warning } = elemResult;
            const button = action.button || 'left';

            // Add visual click effect
            await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Runtime.evaluate',
              params: {
                expression: `
                  (() => {
                    // Add visual click effect
                    const marker = document.createElement('div');
                    marker.style.cssText = \`
                      position: fixed;
                      left: \${${x} - 15}px;
                      top: \${${y} - 15}px;
                      width: 30px;
                      height: 30px;
                      border: 3px solid #ff0000;
                      border-radius: 50%;
                      background: rgba(255, 0, 0, 0.2);
                      pointer-events: none;
                      z-index: 999999;
                      animation: clickPulse 0.6s ease-out;
                    \`;

                    // Add animation if not already present
                    if (!document.getElementById('__mcp_click_animation__')) {
                      const style = document.createElement('style');
                      style.id = '__mcp_click_animation__';
                      style.textContent = \`
                        @keyframes clickPulse {
                          0% { transform: scale(0.5); opacity: 1; }
                          100% { transform: scale(2); opacity: 0; }
                        }
                      \`;
                      document.head.appendChild(style);
                    }
                    document.body.appendChild(marker);

                    // Remove after animation
                    setTimeout(() => marker.remove(), 600);
                  })()
                `,
                returnByValue: false
              }
            });

            // Move mouse to element first (some React apps check for mouse movement)
            await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Input.dispatchMouseEvent',
              params: {
                type: 'mouseMoved',
                x, y
              }
            });

            // Small delay to let React process the mouseMoved event and show visual effect
            await new Promise(resolve => setTimeout(resolve, 50));

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
            if (warning) {
              result += ` ⚠️ ${warning}`;
            }
            break;
          }

          case 'type': {
            // Process selector (preprocess + validate)
            const processedSelector = this._processSelector(action.selector);
            const selectorExpr = this._getSelectorExpression(processedSelector);

            // Focus element first
            await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Runtime.evaluate',
              params: {
                expression: `${selectorExpr}?.focus()`,
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
                expression: `${selectorExpr}?.value`,
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
            // Process selector (preprocess + validate)
            const processedSelector = this._processSelector(action.selector);
            const selectorExpr = this._getSelectorExpression(processedSelector);

            // Clear the field by selecting all and deleting
            await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Runtime.evaluate',
              params: {
                expression: `
                  (() => {
                    const el = ${selectorExpr};
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
            // Process selector (preprocess + validate)
            const processedSelector = this._processSelector(action.selector);

            // Get element location
            const elemResult = await this._findElement(processedSelector);

            if (!elemResult) {
              // Try to find alternative selectors
              let errorMsg = `Element not found: ${action.selector}`;

              // If it's a :has-text() with a tag selector, search for alternatives
              if (typeof processedSelector === 'object' && processedSelector.type === 'has-text' &&
                  processedSelector.baseSelector !== '*') {
                const result = await this._findAlternativeSelectors(processedSelector, action.selector);
                const alternatives = result.alternatives;
                const totalCount = result.totalCount;

                if (alternatives.length > 0) {
                  errorMsg += `\n\nDid you mean?`;
                  alternatives.forEach((alt, i) => {
                    const visibility = alt.visible ? '✓' : '✗ (hidden)';
                    errorMsg += `\n  ${i + 1}. ${alt.selector}:has-text('${processedSelector.searchText}') ${visibility}`;
                    if (alt.text) {
                      errorMsg += `\n     Text: "${alt.text}"`;
                    }
                  });

                  // Show count of additional matches if there are more
                  if (totalCount > alternatives.length) {
                    const remaining = totalCount - alternatives.length;
                    errorMsg += `\n  And ${remaining} more...`;
                  }
                } else {
                  errorMsg += `\n\n💡 No elements found with text: "${processedSelector.searchText}"`;
                }

                errorMsg += `\n\n💡 Other options:`;
                errorMsg += `\n- Take screenshot with highlightClickables=true to see all elements`;
              } else {
                errorMsg += `\n\n💡 Suggestions:`;
                errorMsg += `\n- Take screenshot with highlightClickables=true to see elements`;
                errorMsg += `\n- Use browser_snapshot to inspect page structure`;
              }

              throw new Error(errorMsg);
            }

            const { x, y, warning } = elemResult;

            // Move mouse
            await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Input.dispatchMouseEvent',
              params: {
                type: 'mouseMoved',
                x, y
              }
            });

            result = `Hovered over ${action.selector}`;
            if (warning) {
              result += ` ⚠️ ${warning}`;
            }
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

            // First, check what element is at these coordinates and add visual effect
            const elementAtPoint = await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Runtime.evaluate',
              params: {
                expression: `
                  (() => {
                    const el = document.elementFromPoint(${action.x}, ${action.y});

                    // Add visual click effect
                    const marker = document.createElement('div');
                    marker.style.cssText = \`
                      position: fixed;
                      left: \${${action.x} - 15}px;
                      top: \${${action.y} - 15}px;
                      width: 30px;
                      height: 30px;
                      border: 3px solid #ff0000;
                      border-radius: 50%;
                      background: rgba(255, 0, 0, 0.2);
                      pointer-events: none;
                      z-index: 999999;
                      animation: clickPulse 0.6s ease-out;
                    \`;

                    // Add animation
                    const style = document.createElement('style');
                    style.textContent = \`
                      @keyframes clickPulse {
                        0% { transform: scale(0.5); opacity: 1; }
                        100% { transform: scale(2); opacity: 0; }
                      }
                    \`;
                    document.head.appendChild(style);
                    document.body.appendChild(marker);

                    // Remove after animation
                    setTimeout(() => {
                      marker.remove();
                      style.remove();
                    }, 600);

                    if (!el) return null;

                    // Generate a meaningful selector
                    let selector = el.tagName.toLowerCase();
                    if (el.id) {
                      selector += '#' + el.id;
                    } else if (el.className && typeof el.className === 'string') {
                      const classes = el.className.trim().split(/\\s+/).filter(c => c);
                      if (classes.length > 0) {
                        selector += '.' + classes.slice(0, 2).join('.');
                      }
                    }

                    // Get text content (first 50 chars)
                    let text = '';
                    for (const node of el.childNodes) {
                      if (node.nodeType === Node.TEXT_NODE) {
                        text += node.textContent;
                      }
                    }
                    text = text.trim();

                    return {
                      selector: selector,
                      tag: el.tagName.toLowerCase(),
                      text: text.length > 50 ? text.substring(0, 50) + '...' : text
                    };
                  })()
                `,
                returnByValue: true
              }
            });

            // Wait a tiny bit to ensure visual effect shows
            await new Promise(resolve => setTimeout(resolve, 50));

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

            // Add element info if found
            const elementInfo = elementAtPoint.result?.value;
            if (elementInfo) {
              result += ` - found ${elementInfo.selector}`;
              if (elementInfo.text) {
                result += ` "${elementInfo.text}"`;
              }
            }

            break;
          }

          case 'scroll_to': {
            // Process selector if provided (preprocess + validate)
            const processedSelector = action.selector ? this._processSelector(action.selector) : null;
            const selectorExpr = processedSelector ? this._getSelectorExpression(processedSelector) : null;

            // Scroll window or element to specific coordinates and detect scrollable areas
            const scrollToResult = await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Runtime.evaluate',
              params: {
                expression: `
                  (() => {
                    ${action.selector ? `
                      const el = ${selectorExpr};
                      if (!el) return { error: 'Element not found: ${action.selector}' };
                      const beforeX = el.scrollLeft;
                      const beforeY = el.scrollTop;
                      el.scrollTo(${action.x || 0}, ${action.y || 0});
                      const afterX = el.scrollLeft;
                      const afterY = el.scrollTop;
                      const target = ${JSON.stringify(action.selector)};
                    ` : `
                      const beforeX = window.scrollX;
                      const beforeY = window.scrollY;
                      window.scrollTo(${action.x || 0}, ${action.y || 0});
                      const afterX = window.scrollX;
                      const afterY = window.scrollY;
                      const target = 'window';
                    `}

                    const success = afterX !== beforeX || afterY !== beforeY;

                    // Detect scrollable areas
                    const scrollableAreas = [];
                    document.querySelectorAll('*').forEach(el => {
                      const style = window.getComputedStyle(el);
                      const overflowX = style.overflowX;
                      const overflowY = style.overflowY;

                      if ((overflowX === 'auto' || overflowX === 'scroll' ||
                           overflowY === 'auto' || overflowY === 'scroll') &&
                          (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)) {

                        // Generate selector
                        let selector = el.tagName.toLowerCase();
                        if (el.id) selector += '#' + el.id;
                        else if (el.className && typeof el.className === 'string') {
                          const classes = el.className.trim().split(/\\s+/).slice(0, 2);
                          if (classes.length) selector += '.' + classes.join('.');
                        }

                        scrollableAreas.push({
                          selector,
                          canScrollX: el.scrollWidth > el.clientWidth,
                          canScrollY: el.scrollHeight > el.clientHeight,
                          scrollWidth: el.scrollWidth,
                          scrollHeight: el.scrollHeight,
                          clientWidth: el.clientWidth,
                          clientHeight: el.clientHeight
                        });
                      }
                    });

                    return { success, beforeX, beforeY, afterX, afterY, scrollableAreas, target };
                  })()
                `,
                returnByValue: true
              }
            });

            const scrollData = scrollToResult.result?.value || {};
            if (scrollData.error) {
              throw new Error(scrollData.error);
            }

            const targetDesc = action.selector ? `element "${action.selector}"` : 'window';
            if (scrollData.success) {
              result = `Scrolled ${targetDesc} to (${action.x || 0}, ${action.y || 0}) - actual position: (${scrollData.afterX}, ${scrollData.afterY})`;
            } else {
              result = `Scroll ${targetDesc} to (${action.x || 0}, ${action.y || 0}) had no effect - already at position (${scrollData.afterX}, ${scrollData.afterY})`;
            }

            if (scrollData.scrollableAreas && scrollData.scrollableAreas.length > 0) {
              result += `\n\nScrollable areas on page (${scrollData.scrollableAreas.length} found):`;
              scrollData.scrollableAreas.slice(0, 10).forEach((area, i) => {
                const directions = [];
                if (area.canScrollX) directions.push('horizontal');
                if (area.canScrollY) directions.push('vertical');
                result += `\n${i + 1}. ${area.selector} (${directions.join(', ')}) - ${area.scrollWidth}x${area.scrollHeight} content in ${area.clientWidth}x${area.clientHeight} viewport`;
              });
              if (scrollData.scrollableAreas.length > 10) {
                result += `\n... and ${scrollData.scrollableAreas.length - 10} more`;
              }
            }
            break;
          }

          case 'scroll_by': {
            // Process selector if provided (preprocess + validate)
            const processedSelector = action.selector ? this._processSelector(action.selector) : null;
            const selectorExpr = processedSelector ? this._getSelectorExpression(processedSelector) : null;

            // Scroll window or element by offset and detect scrollable areas
            const scrollByResult = await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Runtime.evaluate',
              params: {
                expression: `
                  (() => {
                    ${action.selector ? `
                      const el = ${selectorExpr};
                      if (!el) return { error: 'Element not found: ${action.selector}' };
                      const beforeX = el.scrollLeft;
                      const beforeY = el.scrollTop;
                      el.scrollBy(${action.x || 0}, ${action.y || 0});
                      const afterX = el.scrollLeft;
                      const afterY = el.scrollTop;
                      const target = ${JSON.stringify(action.selector)};
                    ` : `
                      const beforeX = window.scrollX;
                      const beforeY = window.scrollY;
                      window.scrollBy(${action.x || 0}, ${action.y || 0});
                      const afterX = window.scrollX;
                      const afterY = window.scrollY;
                      const target = 'window';
                    `}

                    const success = afterX !== beforeX || afterY !== beforeY;

                    // Detect scrollable areas
                    const scrollableAreas = [];
                    document.querySelectorAll('*').forEach(el => {
                      const style = window.getComputedStyle(el);
                      const overflowX = style.overflowX;
                      const overflowY = style.overflowY;

                      if ((overflowX === 'auto' || overflowX === 'scroll' ||
                           overflowY === 'auto' || overflowY === 'scroll') &&
                          (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)) {

                        // Generate selector
                        let selector = el.tagName.toLowerCase();
                        if (el.id) selector += '#' + el.id;
                        else if (el.className && typeof el.className === 'string') {
                          const classes = el.className.trim().split(/\\s+/).slice(0, 2);
                          if (classes.length) selector += '.' + classes.join('.');
                        }

                        scrollableAreas.push({
                          selector,
                          canScrollX: el.scrollWidth > el.clientWidth,
                          canScrollY: el.scrollHeight > el.clientHeight,
                          scrollWidth: el.scrollWidth,
                          scrollHeight: el.scrollHeight,
                          clientWidth: el.clientWidth,
                          clientHeight: el.clientHeight
                        });
                      }
                    });

                    return { success, beforeX, beforeY, afterX, afterY, scrollableAreas, target };
                  })()
                `,
                returnByValue: true
              }
            });

            const scrollData = scrollByResult.result?.value || {};
            if (scrollData.error) {
              throw new Error(scrollData.error);
            }

            const targetDesc = action.selector ? `element "${action.selector}"` : 'window';
            if (scrollData.success) {
              result = `Scrolled ${targetDesc} by (${action.x || 0}, ${action.y || 0}) - now at position: (${scrollData.afterX}, ${scrollData.afterY})`;
            } else {
              result = `Scroll ${targetDesc} by (${action.x || 0}, ${action.y || 0}) had no effect - still at position (${scrollData.afterX}, ${scrollData.afterY}). The ${targetDesc} may not be scrollable in that direction.`;
            }

            if (scrollData.scrollableAreas && scrollData.scrollableAreas.length > 0) {
              result += `\n\nScrollable areas on page (${scrollData.scrollableAreas.length} found):`;
              scrollData.scrollableAreas.slice(0, 10).forEach((area, i) => {
                const directions = [];
                if (area.canScrollX) directions.push('horizontal');
                if (area.canScrollY) directions.push('vertical');
                result += `\n${i + 1}. ${area.selector} (${directions.join(', ')}) - ${area.scrollWidth}x${area.scrollHeight} content in ${area.clientWidth}x${area.clientHeight} viewport`;
              });
              if (scrollData.scrollableAreas.length > 10) {
                result += `\n... and ${scrollData.scrollableAreas.length - 10} more`;
              }
            }
            break;
          }

          case 'scroll_into_view': {
            // Process selector (preprocess + validate)
            const processedSelector = this._processSelector(action.selector);
            const selectorExpr = this._getSelectorExpression(processedSelector);

            // Scroll element into view
            const scrollResult = await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Runtime.evaluate',
              params: {
                expression: `
                  (() => {
                    const el = ${selectorExpr};
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
            // Process selector (preprocess + validate)
            const processedSelector = this._processSelector(action.selector);
            const selectorExpr = this._getSelectorExpression(processedSelector);

            // Select option in dropdown
            const selectResult = await this._transport.sendCommand('forwardCDPCommand', {
              method: 'Runtime.evaluate',
              params: {
                expression: `
                  (() => {
                    const select = ${selectorExpr};
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
            // Process selector (preprocess + validate)
            const processedSelector = this._processSelector(action.selector);
            const selectorExpr = this._getSelectorExpression(processedSelector);

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
                    const el = ${selectorExpr};
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

    // Format iframe changes warning if any
    let iframeWarning = '';
    if (iframeChanges && iframeChanges.length > 0) {
      iframeWarning = '\n\n### ⚠️ IFrame Changes Detected\n\n';
      iframeChanges.forEach(change => {
        if (change.type === 'added') {
          iframeWarning += `**New iframe added:** ${change.src || '(no src)'}\n`;
          iframeWarning += `  Size: ${change.width}x${change.height} at (${change.x}, ${change.y})\n`;
          if (change.coversViewport) {
            iframeWarning += `  ⚠️ **This iframe covers significant viewport area!**\n`;
          }
        } else if (change.type === 'resized') {
          iframeWarning += `**Iframe resized:** ${change.src || '(no src)'}\n`;
          iframeWarning += `  Old: ${change.oldWidth}x${change.oldHeight}, New: ${change.width}x${change.height}\n`;
          if (change.coversViewport) {
            iframeWarning += `  ⚠️ **Now covers significant viewport area!**\n`;
          }
        } else if (change.type === 'moved') {
          iframeWarning += `**Iframe repositioned:** ${change.src || '(no src)'}\n`;
          iframeWarning += `  From (${change.oldX}, ${change.oldY}) to (${change.x}, ${change.y})\n`;
          if (change.coversViewport) {
            iframeWarning += `  ⚠️ **Now covers significant viewport area!**\n`;
          }
        }
        iframeWarning += '\n';
      });
    }

    return {
      content: [{
        type: 'text',
        text: `### Interactions Complete\n\nTotal: ${results.length}\nSucceeded: ${successCount}\nFailed: ${errorCount}\n\n${summary}${newTabsInfo}${iframeWarning}`
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
    // Get formatted accessibility tree snapshot from extension
    // Extension now does the heavy processing (grouping, collapsing, truncating)
    // and sends us a structured, compact JSON (~100KB instead of ~12MB)
    const result = await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Accessibility.getFullAXTree',
      params: {}
    });

    // Extension returns { formattedSnapshot: { nodes, totalLines, truncated } }
    if (!result.formattedSnapshot) {
      return {
        content: [{
          type: 'text',
          text: '### Page Snapshot\n\nError: No formatted snapshot received from extension'
        }],
        isError: true
      };
    }

    const formatted = result.formattedSnapshot;
    debugLog(`Received formatted snapshot: ${formatted.totalLines} lines, truncated: ${formatted.truncated}`);

    // Convert structured JSON to plain text
    const snapshot = this._formatStructuredSnapshot(formatted.nodes);
    const truncationMessage = formatted.truncated ? `\n\n--- ${formatted.truncationMessage} ---` : '';

    return {
      content: [{
        type: 'text',
        text: `### Page Snapshot\n\n${snapshot}${truncationMessage}`
      }],
      isError: false
    };
  }

  /**
   * Convert structured snapshot nodes to plain text
   */
  _formatStructuredSnapshot(nodes, depth = 0) {
    if (!nodes || nodes.length === 0) return '';

    const indent = '  '.repeat(depth);
    let output = '';

    for (const node of nodes) {
      if (node.isGroupSummary) {
        // Group summary line
        output += `${indent}... ${node.groupCount} more ${node.role} element${node.groupCount > 1 ? 's' : ''} skipped\n`;
      } else {
        // Regular node
        const nameStr = node.name ? `: ${node.name}` : '';
        const selectorHint = node.selectorHint ? ` [${node.selectorHint}]` : '';
        const valueStr = node.value ? `\n${indent}  value: "${node.value}"` : '';

        output += `${indent}${node.role}${nameStr}${selectorHint}${valueStr}\n`;

        // Recursively format children
        if (node.children && node.children.length > 0) {
          output += this._formatStructuredSnapshot(node.children, depth + 1);
        }
      }
    }

    return output;
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
    const highlightClickables = args.highlightClickables || false;  // Optional: highlight clickable elements
    const deviceScale = args.deviceScale !== undefined ? args.deviceScale : 1;  // Default 1:1, use 0 for device native

    // Get viewport info and pixel ratio
    const viewportInfo = await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Runtime.evaluate',
      params: {
        expression: '({width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio})',
        returnByValue: true
      }
    });
    const viewport = viewportInfo.result?.value || {};

    // Highlight clickable elements if requested
    if (highlightClickables) {
      await this._transport.sendCommand('forwardCDPCommand', {
        method: 'Runtime.evaluate',
        params: {
          expression: `
            (() => {
              // Find all clickable elements
              const clickableSelectors = [
                'button',
                'a[href]',
                '[onclick]',
                '[role="button"]',
                'input[type="button"]',
                'input[type="submit"]',
                'input[type="reset"]',
                '[tabindex]:not([tabindex="-1"])'
              ];

              const clickables = new Set(document.querySelectorAll(clickableSelectors.join(',')));

              // Filter out hidden clickables
              const visibleClickables = new Set();
              clickables.forEach(el => {
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                if (style.display !== 'none' && style.visibility !== 'hidden' &&
                    style.opacity !== '0' && rect.width > 0 && rect.height > 0) {
                  visibleClickables.add(el);
                }
              });

              // Create container for clickable highlights
              const highlightContainer = document.createElement('div');
              highlightContainer.id = '__mcp_clickable_overlay__';
              highlightContainer.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 999998;';
              document.body.appendChild(highlightContainer);

              // Add green border + semi-transparent green highlight to clickables
              visibleClickables.forEach(el => {
                const rect = el.getBoundingClientRect();
                const highlight = document.createElement('div');
                highlight.className = '__mcp_clickable_marker__';
                highlight.style.cssText = \`
                  position: absolute;
                  left: \${rect.left + window.scrollX}px;
                  top: \${rect.top + window.scrollY}px;
                  width: \${rect.width}px;
                  height: \${rect.height}px;
                  background: rgba(0, 255, 0, 0.25);
                  border: 4px solid rgb(0, 200, 0);
                  box-sizing: border-box;
                  pointer-events: none;
                \`;
                highlightContainer.appendChild(highlight);
              });

              return visibleClickables.size;
            })()
          `,
          returnByValue: true
        }
      });
    }

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

    // Capture screenshot at device native resolution, we'll downscale locally if needed
    const result = await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Page.captureScreenshot',
      params: {
        format: format,
        quality: format === 'jpeg' ? quality : undefined,  // Quality only applies to JPEG
        captureBeyondViewport: args.fullPage || false
      }
    });

    // Remove clickable overlay if it was added
    if (highlightClickables) {
      await this._transport.sendCommand('forwardCDPCommand', {
        method: 'Runtime.evaluate',
        params: {
          expression: `
            (() => {
              const overlay = document.getElementById('__mcp_clickable_overlay__');
              if (overlay) overlay.remove();
            })()
          `,
          returnByValue: false
        }
      });
    }

    let buffer = Buffer.from(result.data, 'base64');

    // Check image dimensions
    const { default: sizeOf } = require('image-size');
    let dimensions = sizeOf(buffer);

    // Downscale if needed for 1:1 screenshots
    if (deviceScale > 0 && deviceScale < (viewport.devicePixelRatio || 1) && !args.fullPage) {
      const sharp = require('sharp');
      const targetWidth = Math.round(viewport.width * deviceScale);
      const targetHeight = Math.round(viewport.height * deviceScale);

      buffer = await sharp(buffer)
        .resize(targetWidth, targetHeight, {
          fit: 'fill',
          kernel: 'lanczos3'
        })
        .toFormat(format === 'png' ? 'png' : 'jpeg', {
          quality: format === 'jpeg' ? quality : undefined
        })
        .toBuffer();

      dimensions = sizeOf(buffer);
    }

    // Additional check: ensure dimensions don't exceed Claude's limit (2000px)
    // This is important for fullPage screenshots or high-DPI displays
    const MAX_DIMENSION = 2000;
    if (!args.path && (dimensions.width > MAX_DIMENSION || dimensions.height > MAX_DIMENSION)) {
      const sharp = require('sharp');

      // Calculate scaling factor to fit within limits
      const scale = Math.min(MAX_DIMENSION / dimensions.width, MAX_DIMENSION / dimensions.height);
      const targetWidth = Math.round(dimensions.width * scale);
      const targetHeight = Math.round(dimensions.height * scale);

      buffer = await sharp(buffer)
        .resize(targetWidth, targetHeight, {
          fit: 'fill',
          kernel: 'lanczos3'
        })
        .toFormat(format === 'png' ? 'png' : 'jpeg', {
          quality: format === 'jpeg' ? quality : undefined
        })
        .toBuffer();

      dimensions = sizeOf(buffer);
    }

    const sizeKB = buffer.length / 1024;

    // If path is provided, save the screenshot to disk
    if (args.path && result.data) {
      const fs = require('fs');
      fs.writeFileSync(args.path, buffer);

      const actualScale = deviceScale === 0 ? viewport.devicePixelRatio : deviceScale;
      const viewportStr = viewport.width && viewport.height ? `\nViewport: ${viewport.width}x${viewport.height}` : '';
      const scaleStr = actualScale ? `\nScale: ${actualScale}x` : '';
      const coordWarning = actualScale > 1
        ? `\n\n⚠️ **Important:** When clicking coordinates, use viewport coordinates (${viewport.width}x${viewport.height}), NOT screenshot pixels (${dimensions.width}x${dimensions.height})!`
        : '';

      return {
        content: [{
          type: 'text',
          text: `### Screenshot Saved\n\nFile: ${args.path}\nFormat: ${format.toUpperCase()}\nDimensions: ${dimensions.width}x${dimensions.height}${viewportStr}${scaleStr}\nSize: ${sizeKB.toFixed(2)} KB\nType: ${args.fullPage ? 'Full page' : 'Viewport only'}${coordWarning}`
        }],
        isError: false
      };
    }

    // Dimension check is no longer needed here - we auto-downscale above
    // This is kept as a safety check in case downscaling failed
    if (dimensions.width > MAX_DIMENSION || dimensions.height > MAX_DIMENSION) {
      const viewportInfo = viewport.width && viewport.height && viewport.devicePixelRatio
        ? `\n**Viewport:** ${viewport.width}x${viewport.height}\n**Device Pixel Ratio:** ${viewport.devicePixelRatio}x`
        : '';

      return {
        content: [{
          type: 'text',
          text: `### Screenshot Dimensions Too Large (Downscaling Failed)\n\n**Screenshot Dimensions:** ${dimensions.width}x${dimensions.height} px${viewportInfo}\n**Limit:** ${MAX_DIMENSION}px (width or height)\n**Size:** ${sizeKB.toFixed(2)} KB\n\n**The automatic downscaling failed. Please save to a file instead:**\n\`\`\`\nbrowser_take_screenshot path='/path/to/screenshot.${format}' ${args.fullPage ? 'fullPage=true ' : ''}${format === 'jpeg' ? `quality=${quality}` : ''}\n\`\`\`\n\n**Tips to reduce dimensions:**\n- Use viewport only (remove \`fullPage=true\`) - typically 1280x720 or similar\n- Resize browser window to smaller size before screenshot\n- Use \`browser_window action='resize' width=1280 height=720\``
        }],
        isError: true
      };
    }

    // Return base64 image if no path provided and dimensions are acceptable
    // Use the processed buffer (not original result.data) in case it was downscaled
    return {
      content: [{
        type: 'image',
        data: buffer.toString('base64'),
        mimeType: `image/${format}`
      }],
      isError: false
    };
  }

  async _handleEvaluate(args) {
    const expression = args.function || args.expression;

    // If expression looks like a function definition, wrap and call it
    // Match: () => ..., function() {...}, async () => ..., etc.
    const isFunctionExpression = /^\s*(async\s+)?\([^)]*\)\s*=>|^\s*function\s*\(/.test(expression);
    const finalExpression = (args.function || isFunctionExpression)
      ? `(${expression})()`
      : expression;

    const result = await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Runtime.evaluate',
      params: {
        expression: finalExpression,
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

  async _handleNetworkRequests(args = {}) {
    const action = args.action || 'list';

    // Action: clear
    if (action === 'clear') {
      await this._transport.sendCommand('clearTracking');
      return {
        content: [{
          type: 'text',
          text: `### Network Requests Cleared\n\nAll captured network requests have been cleared from memory.`
        }],
        isError: false
      };
    }

    // Get requests list
    const result = await this._transport.sendCommand('getNetworkRequests');
    const requests = result.requests || [];

    if (requests.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `### Network Requests\n\nNo network requests captured yet.\n\n**Tip:** Use \`action='clear'\` to clear history.`
        }],
        isError: false
      };
    }

    // Action: list (default - lightweight view with filtering and pagination)
    if (action === 'list') {
      // Apply filters
      let filteredRequests = requests;

      // Filter by URL pattern (case-insensitive substring match)
      if (args.urlPattern) {
        const pattern = args.urlPattern.toLowerCase();
        filteredRequests = filteredRequests.filter(req => req.url.toLowerCase().includes(pattern));
      }

      // Filter by method
      if (args.method) {
        filteredRequests = filteredRequests.filter(req => req.method === args.method.toUpperCase());
      }

      // Filter by status code
      if (args.status) {
        filteredRequests = filteredRequests.filter(req => req.statusCode === args.status);
      }

      // Filter by resource type
      if (args.resourceType) {
        filteredRequests = filteredRequests.filter(req => req.type === args.resourceType);
      }

      const totalFiltered = filteredRequests.length;

      // Pagination
      const limit = args.limit !== undefined ? args.limit : 20; // Default: 20 requests
      const offset = args.offset || 0;
      const paginatedRequests = filteredRequests.slice(offset, offset + limit);

      if (paginatedRequests.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `### Network Requests\n\nNo requests match your filters.\n\n**Total captured:** ${requests.length}\n**After filters:** 0\n\n**Try:**\n- Remove or adjust filters\n- Use \`action='clear'\` to clear history and start fresh`
          }],
          isError: false
        };
      }

      const listItems = paginatedRequests.map((req, index) => {
        const actualIndex = offset + index;
        const status = req.statusCode ? `${req.statusCode} ${req.statusText}` : 'Pending';
        const type = req.type ? ` [${req.type}]` : '';
        const timestamp = new Date(req.timestamp).toISOString().split('T')[1].split('.')[0];
        return `${actualIndex}. **${req.method} ${req.url.length > 80 ? req.url.substring(0, 80) + '...' : req.url}**${type}\n   Status: ${status} | Time: ${timestamp} | ID: \`${req.requestId}\``;
      }).join('\n\n');

      // Build filter summary
      const filterSummary = [];
      if (args.urlPattern) filterSummary.push(`URL: *${args.urlPattern}*`);
      if (args.method) filterSummary.push(`Method: ${args.method}`);
      if (args.status) filterSummary.push(`Status: ${args.status}`);
      if (args.resourceType) filterSummary.push(`Type: ${args.resourceType}`);
      const filterText = filterSummary.length > 0 ? `\n**Filters:** ${filterSummary.join(', ')}` : '';

      // Pagination info
      const hasMore = offset + limit < totalFiltered;
      const paginationInfo = totalFiltered > limit
        ? `\n**Showing:** ${offset + 1}-${offset + paginatedRequests.length} of ${totalFiltered}${hasMore ? ` (use \`offset=${offset + limit}\` for next page)` : ''}`
        : '';

      return {
        content: [{
          type: 'text',
          text: `### Network Requests${filterText}${paginationInfo}\n\n${listItems}\n\n**Actions:**\n- \`action='details', requestId='...'\` - Get full details including headers and body\n- \`action='replay', requestId='...'\` - Replay a request\n- \`action='clear'\` - Clear history\n\n**Filters:** Add \`urlPattern\`, \`method\`, \`status\`, or \`resourceType\` parameters\n**Pagination:** Use \`limit\` (default: 20) and \`offset\` (default: 0) parameters`
        }],
        isError: false
      };
    }

    // Action: details - full details for specific request
    if (action === 'details') {
      const { requestId, jsonPath } = args;
      if (!requestId) {
        return {
          content: [{
            type: 'text',
            text: `### Error\n\nMissing required parameter: \`requestId\`\n\nUse \`action='list'\` to see available request IDs.`
          }],
          isError: true
        };
      }

      const req = requests.find(r => r.requestId === requestId);
      if (!req) {
        return {
          content: [{
            type: 'text',
            text: `### Error\n\nRequest ID \`${requestId}\` not found.\n\nUse \`action='list'\` to see available request IDs.`
          }],
          isError: true
        };
      }

      const status = req.statusCode ? `${req.statusCode} ${req.statusText}` : 'Pending';
      const type = req.type ? ` [${req.type}]` : '';
      let details = `### Request Details\n\n**${req.method} ${req.url}${type}**\nStatus: ${status}\nRequest ID: \`${requestId}\``;

      // Add request headers
      if (req.requestHeaders && Object.keys(req.requestHeaders).length > 0) {
        const importantHeaders = ['content-type', 'authorization', 'accept', 'user-agent', 'cookie'];
        const headerLines = Object.entries(req.requestHeaders)
          .filter(([key]) => importantHeaders.includes(key.toLowerCase()))
          .map(([key, value]) => `  ${key}: ${value.length > 100 ? value.substring(0, 100) + '...' : value}`)
          .join('\n');
        if (headerLines) {
          details += `\n\n**Request Headers:**\n${headerLines}`;
        }
      }

      // Add request body if present
      if (req.requestBody) {
        try {
          const parsed = JSON.parse(req.requestBody);
          details += `\n\n**Request Body:**\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
        } catch {
          details += `\n\n**Request Body:**\n\`\`\`\n${req.requestBody.substring(0, 1000)}${req.requestBody.length > 1000 ? '\n...(truncated)' : ''}\n\`\`\``;
        }
      }

      // Add response headers
      if (req.responseHeaders && Object.keys(req.responseHeaders).length > 0) {
        const importantHeaders = ['content-type', 'content-length', 'cache-control', 'set-cookie'];
        const headerLines = Object.entries(req.responseHeaders)
          .filter(([key]) => importantHeaders.includes(key.toLowerCase()))
          .map(([key, value]) => `  ${key}: ${value.length > 100 ? value.substring(0, 100) + '...' : value}`)
          .join('\n');
        if (headerLines) {
          details += `\n\n**Response Headers:**\n${headerLines}`;
        }
      }

      // Fetch response body if available
      if (req.statusCode && req.statusCode >= 200 && req.statusCode < 400) {
        try {
          const bodyResult = await this._transport.sendCommand('getResponseBody', { requestId: req.requestId });
          if (bodyResult.body && !bodyResult.error) {
            let body = bodyResult.body;
            // Decode base64 if needed
            if (bodyResult.base64Encoded) {
              body = Buffer.from(body, 'base64').toString('utf-8');
            }

            // Try to parse as JSON for better formatting
            try {
              let parsed = JSON.parse(body);

              // Apply JSONPath filter if provided
              if (jsonPath) {
                const { JSONPath } = require('jsonpath-plus');
                const filtered = JSONPath({ path: jsonPath, json: parsed });
                parsed = filtered;
                details += `\n\n**Response Body** (filtered with \`${jsonPath}\`):\n\`\`\`json\n${JSON.stringify(parsed, null, 2).substring(0, 5000)}${JSON.stringify(parsed, null, 2).length > 5000 ? '\n...(truncated)' : ''}\n\`\`\``;
              } else {
                details += `\n\n**Response Body:**\n\`\`\`json\n${JSON.stringify(parsed, null, 2).substring(0, 5000)}${JSON.stringify(parsed, null, 2).length > 5000 ? '\n...(truncated)' : ''}\n\`\`\``;
              }

              if (JSON.stringify(parsed, null, 2).length > 5000) {
                details += `\n\n_Tip: Use \`jsonPath\` parameter to filter large responses (e.g., \`$.data.items[0]\`)_`;
              }
            } catch (jsonError) {
              // Not JSON or parse error, show as text (truncated)
              details += `\n\n**Response Body:**\n\`\`\`\n${body.substring(0, 1000)}${body.length > 1000 ? '\n...(truncated)' : ''}\n\`\`\``;
            }
          } else if (bodyResult.error) {
            details += `\n\n_Response body unavailable: ${bodyResult.error}_`;
          }
        } catch (error) {
          details += `\n\n_Could not fetch response body: ${error.message}_`;
          debugLog(`Could not fetch response body for ${req.requestId}:`, error);
        }
      }

      return {
        content: [{
          type: 'text',
          text: details
        }],
        isError: false
      };
    }

    // Action: replay - replay a captured request
    if (action === 'replay') {
      const { requestId } = args;
      if (!requestId) {
        return {
          content: [{
            type: 'text',
            text: `### Error\n\nMissing required parameter: \`requestId\`\n\nUse \`action='list'\` to see available request IDs.`
          }],
          isError: true
        };
      }

      const req = requests.find(r => r.requestId === requestId);
      if (!req) {
        return {
          content: [{
            type: 'text',
            text: `### Error\n\nRequest ID \`${requestId}\` not found.\n\nUse \`action='list'\` to see available request IDs.`
          }],
          isError: true
        };
      }

      try {
        // Use CDP Fetch domain to replay the request
        // First enable Fetch domain
        await this._transport.sendCommand('forwardCDPCommand', {
          method: 'Fetch.enable',
          params: {
            patterns: [{ urlPattern: '*' }]
          }
        });

        // Construct the fetch request
        const fetchParams = {
          url: req.url,
          method: req.method,
          headers: Object.entries(req.requestHeaders || {}).map(([name, value]) => ({ name, value })),
        };

        if (req.requestBody) {
          fetchParams.postData = req.requestBody;
        }

        // Execute using Runtime.evaluate to use fetch API
        const evalResult = await this._transport.sendCommand('forwardCDPCommand', {
          method: 'Runtime.evaluate',
          params: {
            expression: `
              (async () => {
                const response = await fetch(${JSON.stringify(req.url)}, ${JSON.stringify({
                  method: req.method,
                  headers: req.requestHeaders,
                  body: req.requestBody || undefined
                })});
                const text = await response.text();
                return {
                  status: response.status,
                  statusText: response.statusText,
                  headers: Object.fromEntries(response.headers.entries()),
                  body: text
                };
              })()
            `,
            awaitPromise: true,
            returnByValue: true
          }
        });

        // Disable Fetch domain
        await this._transport.sendCommand('forwardCDPCommand', {
          method: 'Fetch.disable',
          params: {}
        });

        if (evalResult.result && evalResult.result.value) {
          const replay = evalResult.result.value;
          let resultText = `### Request Replayed\n\n**${req.method} ${req.url}**\n\n**Response:**\nStatus: ${replay.status} ${replay.statusText}`;

          // Try to parse body as JSON
          try {
            const parsed = JSON.parse(replay.body);
            resultText += `\n\n**Body:**\n\`\`\`json\n${JSON.stringify(parsed, null, 2).substring(0, 2000)}${JSON.stringify(parsed, null, 2).length > 2000 ? '\n...(truncated)' : ''}\n\`\`\``;
          } catch {
            resultText += `\n\n**Body:**\n\`\`\`\n${replay.body.substring(0, 1000)}${replay.body.length > 1000 ? '\n...(truncated)' : ''}\n\`\`\``;
          }

          return {
            content: [{
              type: 'text',
              text: resultText
            }],
            isError: false
          };
        } else {
          throw new Error('No result from fetch evaluation');
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `### Replay Failed\n\nError: ${error.message}\n\n**Possible reasons:**\n- CORS restrictions\n- Authentication required\n- Request parameters changed\n- Network connectivity issues`
          }],
          isError: true
        };
      }
    }

    // Unknown action
    return {
      content: [{
        type: 'text',
        text: `### Error\n\nUnknown action: \`${action}\`\n\nAvailable actions: \`list\`, \`details\`, \`replay\`, \`clear\``
      }],
      isError: true
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

  /**
   * Lookup elements by text content
   */
  async _handleLookup(args) {
    const searchText = args.text;
    const limit = args.limit || 10;

    try {
      // Search for all elements containing the text
      const result = await this._transport.sendCommand('forwardCDPCommand', {
        method: 'Runtime.evaluate',
        params: {
          expression: `
            (() => {
              const searchText = ${JSON.stringify(searchText)};
              const searchTextLower = searchText.trim().toLowerCase();
              const elements = document.querySelectorAll('*');
              const matches = [];

              for (const el of elements) {
                // Get direct text content (not including children)
                let directText = '';
                for (const node of el.childNodes) {
                  if (node.nodeType === Node.TEXT_NODE) {
                    directText += node.textContent;
                  }
                }
                directText = directText.trim();

                // Only match if the direct text contains the search text
                if (directText.toLowerCase().includes(searchTextLower)) {
                  // Generate a meaningful selector for this element
                  let selector = el.tagName.toLowerCase();

                  // Add ID if present
                  if (el.id) {
                    selector += '#' + el.id;
                  }
                  // Or add classes (up to 2 most specific)
                  else if (el.className && typeof el.className === 'string') {
                    const classes = el.className.trim().split(/\\s+/).filter(c => c);
                    if (classes.length > 0) {
                      selector += '.' + classes.slice(0, 2).join('.');
                    }
                  }
                  // Or add role if present
                  else if (el.getAttribute('role')) {
                    selector += '[role="' + el.getAttribute('role') + '"]';
                  }

                  // Check visibility
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  const visible = style.display !== 'none' &&
                                 style.visibility !== 'hidden' &&
                                 style.opacity !== '0' &&
                                 rect.width > 0 && rect.height > 0;

                  // Get tag name
                  const tag = el.tagName.toLowerCase();

                  matches.push({
                    selector: selector,
                    visible: visible,
                    text: directText.length > 100 ? directText.substring(0, 100) + '...' : directText,
                    tag: tag,
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height / 2)
                  });
                }
              }

              // Return up to limit, prioritize visible ones
              const visibleMatches = matches.filter(m => m.visible);
              const hiddenMatches = matches.filter(m => !m.visible);
              const shown = [...visibleMatches, ...hiddenMatches].slice(0, ${limit});

              return {
                matches: shown,
                totalCount: matches.length
              };
            })()
          `,
          returnByValue: true
        }
      });

      const data = result.result?.value || { matches: [], totalCount: 0 };
      const matches = data.matches || [];
      const totalCount = data.totalCount || 0;

      if (matches.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `### No Elements Found\n\nNo elements found with text: "${searchText}"`
          }],
          isError: false
        };
      }

      let output = `### Found ${totalCount} element(s) with text: "${searchText}"\n\n`;
      if (matches.length < totalCount) {
        output += `Showing first ${matches.length}:\n\n`;
      }

      matches.forEach((match, i) => {
        const visibility = match.visible ? '✓ visible' : '✗ hidden';
        output += `${i + 1}. **${match.selector}:has-text('${searchText}')** ${visibility}\n`;
        output += `   Tag: ${match.tag}\n`;
        output += `   Text: "${match.text}"\n`;
        output += `   Position: (${match.x}, ${match.y})\n\n`;
      });

      if (matches.length < totalCount) {
        output += `_...and ${totalCount - matches.length} more. Use limit parameter to see more._\n`;
      }

      return {
        content: [{
          type: 'text',
          text: output
        }],
        isError: false
      };
    } catch (error) {
      throw new Error(`Failed to lookup elements: ${error.message}`);
    }
  }

  /**
   * Check for iframe changes using MutationObserver
   * Installs monitor on first call, returns accumulated changes on subsequent calls
   */
  async _checkIframeChanges() {
    try {
      const result = await this._transport.sendCommand('forwardCDPCommand', {
        method: 'Runtime.evaluate',
        params: {
          expression: `
            (() => {
              // Install monitor if not present
              if (!window.__mcpIframeMonitor) {
                window.__mcpIframeMonitor = {
                  changes: [],
                  iframes: new Map(), // Track iframe state: src, width, height, x, y

                  // Initialize tracking for existing iframes
                  init() {
                    document.querySelectorAll('iframe').forEach(iframe => {
                      this.trackIframe(iframe);
                    });
                  },

                  // Track an iframe's current state
                  trackIframe(iframe) {
                    const rect = iframe.getBoundingClientRect();
                    const state = {
                      src: iframe.src || iframe.getAttribute('src') || '(no src)',
                      width: Math.round(rect.width),
                      height: Math.round(rect.height),
                      x: Math.round(rect.x),
                      y: Math.round(rect.y)
                    };
                    this.iframes.set(iframe, state);
                    return state;
                  },

                  // Check if iframe covers significant viewport area (>50%)
                  coversViewport(rect) {
                    const viewportArea = window.innerWidth * window.innerHeight;
                    const iframeArea = rect.width * rect.height;

                    // Also check if iframe is positioned to cover viewport
                    const coversCenterX = rect.x <= window.innerWidth / 2 &&
                                         (rect.x + rect.width) >= window.innerWidth / 2;
                    const coversCenterY = rect.y <= window.innerHeight / 2 &&
                                         (rect.y + rect.height) >= window.innerHeight / 2;

                    return (iframeArea / viewportArea > 0.5) || (coversCenterX && coversCenterY && iframeArea > 100000);
                  },

                  // Check for size/position changes on existing iframes
                  checkForChanges() {
                    this.iframes.forEach((oldState, iframe) => {
                      if (!document.contains(iframe)) {
                        // Iframe removed
                        this.iframes.delete(iframe);
                        return;
                      }

                      const rect = iframe.getBoundingClientRect();
                      const newState = {
                        src: iframe.src || iframe.getAttribute('src') || '(no src)',
                        width: Math.round(rect.width),
                        height: Math.round(rect.height),
                        x: Math.round(rect.x),
                        y: Math.round(rect.y)
                      };

                      // Check for resize
                      if (newState.width !== oldState.width || newState.height !== oldState.height) {
                        this.changes.push({
                          type: 'resized',
                          src: newState.src,
                          oldWidth: oldState.width,
                          oldHeight: oldState.height,
                          width: newState.width,
                          height: newState.height,
                          x: newState.x,
                          y: newState.y,
                          coversViewport: this.coversViewport(rect)
                        });
                        this.iframes.set(iframe, newState);
                      }
                      // Check for repositioning
                      else if (newState.x !== oldState.x || newState.y !== oldState.y) {
                        this.changes.push({
                          type: 'moved',
                          src: newState.src,
                          oldX: oldState.x,
                          oldY: oldState.y,
                          x: newState.x,
                          y: newState.y,
                          width: newState.width,
                          height: newState.height,
                          coversViewport: this.coversViewport(rect)
                        });
                        this.iframes.set(iframe, newState);
                      }
                    });
                  }
                };

                // Initialize with existing iframes
                window.__mcpIframeMonitor.init();

                // Set up MutationObserver for new iframes
                const observer = new MutationObserver((mutations) => {
                  mutations.forEach(mutation => {
                    mutation.addedNodes.forEach(node => {
                      if (node.tagName === 'IFRAME') {
                        const rect = node.getBoundingClientRect();
                        const state = window.__mcpIframeMonitor.trackIframe(node);
                        window.__mcpIframeMonitor.changes.push({
                          type: 'added',
                          src: state.src,
                          width: state.width,
                          height: state.height,
                          x: state.x,
                          y: state.y,
                          coversViewport: window.__mcpIframeMonitor.coversViewport(rect)
                        });
                      }
                      // Check child nodes recursively
                      if (node.querySelectorAll) {
                        node.querySelectorAll('iframe').forEach(iframe => {
                          const rect = iframe.getBoundingClientRect();
                          const state = window.__mcpIframeMonitor.trackIframe(iframe);
                          window.__mcpIframeMonitor.changes.push({
                            type: 'added',
                            src: state.src,
                            width: state.width,
                            height: state.height,
                            x: state.x,
                            y: state.y,
                            coversViewport: window.__mcpIframeMonitor.coversViewport(rect)
                          });
                        });
                      }
                    });
                  });
                });

                observer.observe(document.documentElement, {
                  childList: true,
                  subtree: true
                });

                // Also check for resize/reposition periodically (for CSS animations, etc.)
                setInterval(() => {
                  window.__mcpIframeMonitor.checkForChanges();
                }, 1000);
              }

              // Return and clear accumulated changes
              const changes = window.__mcpIframeMonitor.changes;
              window.__mcpIframeMonitor.changes = [];
              return changes;
            })()
          `,
          returnByValue: true,
          awaitPromise: false
        }
      });

      return result.result?.value || [];
    } catch (error) {
      debugLog('Iframe monitoring error:', error);
      return [];
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
