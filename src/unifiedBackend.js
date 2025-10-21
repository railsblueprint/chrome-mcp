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
        description: 'Navigate in the browser - go to URL, back, forward, or reload',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['url', 'back', 'forward', 'reload'],
              description: 'Navigation action to perform'
            },
            url: { type: 'string', description: 'URL to navigate to (required when action=url)' }
          },
          required: ['action']
        }
      },

      // Interaction
      {
        name: 'browser_click',
        description: 'Click an element by selector',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button' },
            clickCount: { type: 'number', description: 'Number of clicks' }
          },
          required: ['selector']
        }
      },
      {
        name: 'browser_type',
        description: 'Type text into an element',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector' },
            text: { type: 'string', description: 'Text to type' }
          },
          required: ['selector', 'text']
        }
      },
      {
        name: 'browser_press_key',
        description: 'Press a keyboard key',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Key to press (e.g., Enter, Escape, ArrowDown)' }
          },
          required: ['key']
        }
      },
      {
        name: 'browser_hover',
        description: 'Hover over an element',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector' }
          },
          required: ['selector']
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
        description: 'Capture screenshot of the page',
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format' },
            fullPage: { type: 'boolean', description: 'Capture full page' },
            quality: { type: 'number', description: 'JPEG quality 0-100' }
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
        name: 'browser_select_option',
        description: 'Select option in dropdown',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector for select element' },
            value: { type: 'string', description: 'Option value to select' }
          },
          required: ['selector', 'value']
        }
      },
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
      {
        name: 'browser_file_upload',
        description: 'Upload file to input element',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector for file input' },
            filePath: { type: 'string', description: 'Path to file' }
          },
          required: ['selector', 'filePath']
        }
      },

      // Mouse operations
      {
        name: 'browser_mouse_click_xy',
        description: 'Click at specific coordinates',
        inputSchema: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            button: { type: 'string', enum: ['left', 'right', 'middle'] }
          },
          required: ['x', 'y']
        }
      },
      {
        name: 'browser_mouse_move_xy',
        description: 'Move mouse to coordinates',
        inputSchema: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' }
          },
          required: ['x', 'y']
        }
      },
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

      // Wait
      {
        name: 'browser_wait_for',
        description: 'Wait for condition',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'Wait for element to appear' },
            timeout: { type: 'number', description: 'Timeout in ms' }
          }
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
        description: 'Save page as PDF',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Output file path' }
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

        case 'browser_click':
          return await this._handleClick(args);

        case 'browser_type':
          return await this._handleType(args);

        case 'browser_press_key':
          return await this._handlePressKey(args);

        case 'browser_hover':
          return await this._handleHover(args);

        case 'browser_snapshot':
          return await this._handleSnapshot();

        case 'browser_take_screenshot':
          return await this._handleScreenshot(args);

        case 'browser_evaluate':
          return await this._handleEvaluate(args);

        case 'browser_console_messages':
          return await this._handleConsoleMessages();

        // Forms
        case 'browser_select_option':
          return await this._handleSelectOption(args);

        case 'browser_fill_form':
          return await this._handleFillForm(args);

        case 'browser_file_upload':
          return await this._handleFileUpload(args);

        // Mouse
        case 'browser_mouse_click_xy':
          return await this._handleMouseClickXY(args);

        case 'browser_mouse_move_xy':
          return await this._handleMouseMoveXY(args);

        case 'browser_drag':
          return await this._handleDrag(args);

        // Window
        case 'browser_window':
          return await this._handleWindow(args);

        // Wait
        case 'browser_wait_for':
          return await this._handleWaitFor(args);

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

      // Format each tab with all metadata
      const tabList = tabs.map((tab, i) => {
        const markers = [];
        if (tab.active) markers.push('ACTIVE');
        if (tab.windowFocused) markers.push('FOCUSED WINDOW');
        if (!tab.automatable) markers.push('NOT AUTOMATABLE');

        const markerStr = markers.length > 0 ? ` [${markers.join(', ')}]` : '';
        return `${i}. ${tab.title || 'Untitled'} (${tab.url || 'about:blank'})${markerStr}`;
      }).join('\n');

      return {
        content: [{
          type: 'text',
          text: `### Browser Tabs\n\nTotal: ${tabs.length}\nFocused Window: ${result.focusedWindowId}\n\n${tabList}`
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

      return {
        content: [{
          type: 'text',
          text: `### Tab Created\n\nURL: ${args.url || 'about:blank'}\nTab ID: ${result.tab?.id}`
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

    throw new Error(`Unknown navigation action: ${action}`);
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

    // Send keyDown
    await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Input.dispatchKeyEvent',
      params: {
        type: 'keyDown',
        key: key
      }
    });

    // Send keyUp
    await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Input.dispatchKeyEvent',
      params: {
        type: 'keyUp',
        key: key
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

    // Format snapshot as text
    const nodes = result.nodes || [];
    const snapshot = this._formatAXTree(nodes);

    return {
      content: [{
        type: 'text',
        text: `### Page Snapshot\n\n${snapshot}`
      }],
      isError: false
    };
  }

  _formatAXTree(nodes, depth = 0) {
    if (!nodes || nodes.length === 0) return '';

    let output = '';
    for (const node of nodes.slice(0, 50)) { // Limit to first 50 nodes
      const indent = '  '.repeat(depth);
      const role = node.role?.value || 'unknown';
      const name = node.name?.value || '';
      output += `${indent}${role}${name ? `: ${name}` : ''}\n`;

      if (node.children) {
        output += this._formatAXTree(node.children, depth + 1);
      }
    }
    return output;
  }

  async _handleScreenshot(args) {
    const result = await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Page.captureScreenshot',
      params: {
        format: args.type || 'png',
        quality: args.quality,
        captureBeyondViewport: args.fullPage || false
      }
    });

    // Return base64 image
    return {
      content: [{
        type: 'image',
        data: result.data,
        mimeType: `image/${args.type || 'png'}`
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
    // This would require storing console messages on the extension side
    // For now, return a placeholder
    return {
      content: [{
        type: 'text',
        text: `### Console Messages\n\n(Console message collection not yet implemented)`
      }],
      isError: false
    };
  }

  // ==================== FORMS ====================

  async _handleSelectOption(args) {
    await this._transport.sendCommand('forwardCDPCommand', {
      method: 'Runtime.evaluate',
      params: {
        expression: `
          (() => {
            const select = document.querySelector(${JSON.stringify(args.selector)});
            if (!select) throw new Error('Select element not found');
            select.value = ${JSON.stringify(args.value)};
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return { success: true };
          })()
        `,
        returnByValue: true
      }
    });

    return {
      content: [{
        type: 'text',
        text: `### Option Selected\n\nSelector: ${args.selector}\nValue: ${args.value}`
      }],
      isError: false
    };
  }

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

  async _handleFileUpload(args) {
    await this._transport.sendCommand('forwardCDPCommand', {
      method: 'DOM.setFileInputFiles',
      params: {
        files: [args.filePath]
      }
    });

    return {
      content: [{
        type: 'text',
        text: `### File Uploaded\n\nFile: ${args.filePath}`
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
    // Would need to enable Network domain and collect requests
    return {
      content: [{
        type: 'text',
        text: `### Network Requests\n\n(Network monitoring not yet implemented)`
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

    return {
      content: [{
        type: 'text',
        text: `### PDF Generated\n\nBase64 data length: ${result.data?.length || 0} bytes\n\n(Save to file: ${args.path})`
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

  serverClosed() {
    debugLog('serverClosed');
    if (this._transport) {
      this._transport.close();
    }
  }
}

module.exports = { UnifiedBackend };
