/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export function debugLog(...args: unknown[]): void {
  const enabled = true;
  if (enabled) {
    // eslint-disable-next-line no-console
    console.log('[Extension]', ...args);
  }
}

type ProtocolCommand = {
  id: number | string; // Can be numeric (direct mode) or string (proxy mode)
  method: string;
  params?: any;
};

type ProtocolResponse = {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: {
    code: number;
    message: string;
  };
};

// Connection mode detection
type ConnectionMode = 'direct' | 'proxy' | 'proxy-control';

function detectConnectionMode(id: number | string): ConnectionMode {
  if (typeof id === 'number') {
    return 'direct';
  }
  if (typeof id === 'string' && id.startsWith('proxy:')) {
    return 'proxy-control';
  }
  if (typeof id === 'string' && id.includes(':')) {
    return 'proxy';
  }
  return 'direct';
}

export class RelayConnection {
  private _debuggee: chrome.debugger.Debuggee;
  private _ws: WebSocket;
  private _eventListener: (source: chrome.debugger.DebuggerSession, method: string, params: any) => void;
  private _detachListener: (source: chrome.debugger.Debuggee, reason: string) => void;
  private _tabPromise: Promise<void>;
  private _tabPromiseResolve!: () => void;
  private _closed = false;
  private _stealthMode: boolean = false;
  private _connectionMap: Map<string, number> = new Map(); // connectionId → tabId
  private _browserName: string;
  private _accessToken?: string;

  onclose?: () => void;
  onStealthModeSet?: (stealth: boolean) => void;
  onTabConnected?: (tabId: number) => void;
  onProjectConnected?: (projectName: string) => void;

  constructor(ws: WebSocket, browserName: string, accessToken?: string) {
    this._debuggee = { };
    this._tabPromise = new Promise(resolve => this._tabPromiseResolve = resolve);
    this._ws = ws;
    this._browserName = browserName;
    this._accessToken = accessToken;

    console.error('[Extension] Setting up WebSocket handlers');
    this._ws.onmessage = this._onMessage.bind(this);
    this._ws.onclose = () => {
      console.error('[Extension] WebSocket closed');
      this._onClose();
    };
    this._ws.onerror = (error) => {
      console.error('[Extension] WebSocket error:', error);
    };

    // Store listeners for cleanup
    this._eventListener = this._onDebuggerEvent.bind(this);
    this._detachListener = this._onDebuggerDetach.bind(this);
    chrome.debugger.onEvent.addListener(this._eventListener);
    chrome.debugger.onDetach.addListener(this._detachListener);

    // In proxy mode: Extension is PASSIVE - wait for proxy to send authenticate request
    // In direct mode: This still works but is legacy (will be replaced by JSON-RPC)
    console.error('[Extension] Connection established, WebSocket state:', ws.readyState);
    debugLog('[Extension] Connection established, waiting for authenticate request from proxy');
  }

  // Either setTabId or close is called after creating the connection.
  setTabId(tabId: number | undefined): void {
    if (tabId !== undefined) {
      this._debuggee = { tabId };
    }
    // Always resolve the promise, even in lazy mode without tabId
    this._tabPromiseResolve();
  }

  close(message: string): void {
    this._ws.close(1000, message);
    // ws.onclose is called asynchronously, so we call it here to avoid forwarding
    // CDP events to the closed connection.
    this._onClose();
  }

  private _onClose() {
    if (this._closed)
      return;
    this._closed = true;
    chrome.debugger.onEvent.removeListener(this._eventListener);
    chrome.debugger.onDetach.removeListener(this._detachListener);
    chrome.debugger.detach(this._debuggee).catch(() => {});
    this.onclose?.();
  }

  private _onDebuggerEvent(source: chrome.debugger.DebuggerSession, method: string, params: any): void {
    if (source.tabId !== this._debuggee.tabId)
      return;

    // Stealth mode: Filter out console-related CDP events
    if (this._stealthMode && (
      method.startsWith('Runtime.consoleAPICalled') ||
      method.startsWith('Runtime.exceptionThrown') ||
      method.startsWith('Console.')
    )) {
      debugLog('Stealth mode: Blocking console event:', method);
      return;
    }

    debugLog('Forwarding CDP event:', method, params);
    const sessionId = source.sessionId;
    this._sendMessage({
      jsonrpc: '2.0',
      method: 'forwardCDPEvent',
      params: {
        sessionId,
        method,
        params,
      },
    });
  }

  private _onDebuggerDetach(source: chrome.debugger.Debuggee, reason: string): void {
    if (source.tabId !== this._debuggee.tabId)
      return;
    this.close(`Debugger detached: ${reason}`);
    this._debuggee = { };
  }

  private _onMessage(event: MessageEvent): void {
    this._onMessageAsync(event).catch(e => debugLog('Error handling message:', e));
  }

  private async _onMessageAsync(event: MessageEvent): Promise<void> {
    // Force log to verify this is being called
    console.error('[Extension] _onMessageAsync called, data length:', event.data?.length);

    let message: any;
    try {
      message = JSON.parse(event.data);
      console.error('[Extension] Parsed message:', message);
    } catch (error: any) {
      console.error('[Extension] Error parsing message:', error);
      debugLog('Error parsing message:', error);
      this._sendError(-32700, `Error parsing message: ${error.message}`);
      return;
    }

    debugLog('Received message:', message);

    // Check if this is a JSON-RPC notification (has "method" but NO "id")
    // Notifications don't require a response
    if (message.method && message.id === undefined) {
      debugLog('Received notification:', message.method, message.params);
      // Just log it, don't send a response
      return;
    }

    // Check for legacy notifications (has "type" instead of "method")
    if (message.type && !message.method) {
      debugLog('Received legacy notification:', message.type);
      // Just log it, don't send a response
      return;
    }

    // This is a command - must have "method" and "id"
    if (!message.method) {
      debugLog('Invalid command: missing method field');
      return;
    }

    if (message.id === undefined) {
      debugLog('Invalid command: missing id field (use notification if no response expected)');
      return;
    }

    // Detect connection mode and extract connectionId if in proxy mode
    const mode = detectConnectionMode(message.id);
    let connectionId: string | undefined;

    if (mode === 'proxy' && typeof message.id === 'string') {
      // Extract connectionId from "conn-abc:requestId" → "conn-abc"
      // Use indexOf to find first colon, then split there
      const colonIndex = message.id.indexOf(':');
      if (colonIndex !== -1) {
        connectionId = message.id.substring(0, colonIndex);
        debugLog('Proxy mode detected, connectionId:', connectionId);
      } else {
        debugLog('Warning: Proxy mode detected but no colon in ID:', message.id);
      }
    }

    const response: ProtocolResponse = {
      jsonrpc: '2.0',
      id: message.id, // Always preserve the same ID we received
    };
    try {
      debugLog('Executing command:', message.method, 'with connectionId:', connectionId);
      const result = await this._handleCommand(message as ProtocolCommand, connectionId);
      debugLog('Command completed successfully:', message.method);
      // Ensure result is always set, even if undefined (for JSON-RPC compliance)
      response.result = result !== undefined ? result : {};
    } catch (error: any) {
      debugLog('Error handling command:', message.method, error);
      debugLog('Error stack:', error.stack);
      response.error = {
        code: -32000,
        message: error.message || String(error)
      };
    }

    try {
      debugLog('Sending response:', JSON.stringify(response).substring(0, 200));
      this._sendMessage(response);
      debugLog('Response sent successfully');
    } catch (sendError: any) {
      debugLog('ERROR sending response:', sendError);
    }
  }

  private async _handleCommand(message: ProtocolCommand, connectionId?: string): Promise<any> {
    // Handle authenticate request from proxy (proxy-control mode)
    if (message.method === 'authenticate') {
      debugLog('Received authenticate request from proxy');
      return {
        name: this._browserName,
        access_token: this._accessToken
      };
    }

    // In proxy mode, use connectionId to look up the correct tab
    if (connectionId) {
      const tabId = this._connectionMap.get(connectionId);
      if (tabId !== undefined) {
        debugLog(`Using tab ${tabId} for connection ${connectionId}`);
        // Override debuggee temporarily for this command
        this._debuggee = { tabId };
      } else {
        debugLog(`No tab mapped for connection ${connectionId} yet`);
      }
    }

    if (message.method === 'attachToTab') {
      await this._tabPromise;

      // This is only called for lazy startup mode (auto-connect without specific tab)
      // Create a fresh about:blank tab to avoid chrome:// URL issues
      if (!this._debuggee.tabId) {
        debugLog('No tab specified (lazy startup mode), creating fresh about:blank tab');
        const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
        this._debuggee = { tabId: tab.id };
        debugLog('Created fresh tab:', tab.id, '(about:blank)');

        // Notify background script
        if (this.onTabConnected && tab.id) {
          this.onTabConnected(tab.id);
        }

        // Wait for tab to be ready
        await new Promise(resolve => setTimeout(resolve, 100));

        debugLog('Attaching debugger to tab:', this._debuggee);
        await chrome.debugger.attach(this._debuggee, '1.3');
      }

      // If tab was already attached by _selectTab or _createTab, just get info
      const result: any = await chrome.debugger.sendCommand(this._debuggee, 'Target.getTargetInfo');
      return {
        targetInfo: result?.targetInfo,
      };
    }
    if (message.method === 'reloadExtensions') {
      const extensionName = message.params?.extensionName;
      debugLog('Reloading unpacked extensions...', extensionName ? `(${extensionName})` : '(all)');
      return await this._reloadExtensions(extensionName);
    }
    if (message.method === 'listExtensions') {
      debugLog('Listing unpacked extensions...');
      return await this._listExtensions();
    }
    if (message.method === 'getTabs') {
      debugLog('Getting browser tabs...');
      return await this._getTabs();
    }
    if (message.method === 'selectTab') {
      const tabIndex = message.params?.tabIndex;
      if (tabIndex === undefined) {
        throw new Error('tabIndex parameter is required');
      }
      const activate = message.params?.activate ?? false;
      const stealth = message.params?.stealth ?? false;
      debugLog('Selecting tab:', tabIndex, 'activate:', activate, 'stealth:', stealth);
      return await this._selectTab(tabIndex, activate, stealth, connectionId);
    }
    if (message.method === 'createTab') {
      const url = message.params?.url || 'about:blank';
      const activate = message.params?.activate ?? true;
      const stealth = message.params?.stealth ?? false;
      debugLog('Creating new tab - received params:', message.params);
      debugLog('Creating new tab - url:', url, 'activate:', activate, 'stealth:', stealth);
      return await this._createTab(url, activate, stealth, connectionId);
    }
    if (message.method === 'activateTab') {
      const tabIndex = message.params?.tabIndex;
      if (tabIndex === undefined) {
        throw new Error('tabIndex parameter is required');
      }
      debugLog('Activating tab:', tabIndex);
      return await this._activateTab(tabIndex);
    }
    if (message.method === 'reloadSelf') {
      debugLog('Reloading Blueprint MCP for Chrome extension...');
      // Reload this extension using chrome.runtime.reload()
      setTimeout(() => {
        chrome.runtime.reload();
      }, 100);
      return { reloaded: true };
    }
    if (message.method === 'openTestPage') {
      debugLog('Opening test page in new window...');
      const testPageUrl = chrome.runtime.getURL('test-interactions.html');
      const window = await chrome.windows.create({
        url: testPageUrl,
        type: 'normal',
        focused: true
      });

      // Get the tab that was created in the new window
      if (window.tabs && window.tabs.length > 0) {
        const tab = window.tabs[0];
        if (tab.id) {
          // Update debuggee to this new tab
          this._debuggee = { tabId: tab.id };

          // In proxy mode, store connection mapping
          if (connectionId) {
            this._connectionMap.set(connectionId, tab.id);
            debugLog(`Stored connection mapping: ${connectionId} → tab ${tab.id}`);
          }

          // Notify background script
          if (this.onTabConnected) {
            this.onTabConnected(tab.id);
          }

          // Wait for page to load, then attach debugger
          await new Promise(resolve => setTimeout(resolve, 500));
          debugLog('Attaching debugger to test page tab:', this._debuggee);
          await chrome.debugger.attach(this._debuggee, '1.3');
          debugLog('Debugger attached successfully');

          return {
            success: true,
            url: testPageUrl,
            tab: {
              id: tab.id,
              title: tab.title,
              url: testPageUrl
            }
          };
        }
      }
      throw new Error('Failed to create test page window');
    }
    if (!this._debuggee.tabId)
      throw new Error('No tab is connected. Please go to the Playwright MCP extension and select the tab you want to connect to.');
    if (message.method === 'forwardCDPCommand') {
      const { sessionId, method, params } = message.params;
      debugLog('CDP command:', method, params);
      const debuggerSession: chrome.debugger.DebuggerSession = {
        ...this._debuggee,
        sessionId,
      };
      // Forward CDP command to chrome.debugger
      return await chrome.debugger.sendCommand(
          debuggerSession,
          method,
          params
      );
    }
  }

  private async _listExtensions(): Promise<any> {
    const extensions = await chrome.management.getAll();
    const unpackedExtensions = extensions
      .filter(ext => ext.installType === 'development')
      .map(ext => ({
        name: ext.name,
        id: ext.id,
        enabled: ext.enabled,
        version: ext.version,
      }));

    return {
      extensions: unpackedExtensions,
      count: unpackedExtensions.length,
    };
  }

  private async _reloadExtensions(extensionName?: string): Promise<any> {
    // Special case: reloading Blueprint MCP itself
    if (extensionName === 'Blueprint MCP for Chrome') {
      debugLog('Reloading Blueprint MCP for Chrome using chrome.runtime.reload()');
      setTimeout(() => {
        chrome.runtime.reload();
      }, 100);
      return {
        reloadedCount: 1,
        reloadedExtensions: ['Blueprint MCP for Chrome'],
      };
    }

    // Remember current tab before reloading (but only if it's not a chrome:// URL)
    const currentTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    let targetTabId: number | undefined;

    if (currentTabs.length > 0 && currentTabs[0].url &&
        !currentTabs[0].url.startsWith('chrome://') &&
        !currentTabs[0].url.startsWith('chrome-extension://')) {
      targetTabId = currentTabs[0].id;
    }

    // If current tab is chrome://, find the first non-chrome:// tab
    if (targetTabId === undefined) {
      const allTabs = await chrome.tabs.query({});
      const validTab = allTabs.find(tab =>
        tab.url &&
        !tab.url.startsWith('chrome://') &&
        !tab.url.startsWith('chrome-extension://')
      );
      if (validTab) {
        targetTabId = validTab.id;
      }
    }

    const extensions = await chrome.management.getAll();
    const reloadedExtensions: string[] = [];

    for (const ext of extensions) {
      if ((ext.installType === 'development') &&
          (ext.enabled === true)) {

        // If extensionName is specified, only reload matching extension
        if (extensionName && ext.name !== extensionName) {
          continue;
        }

        try {
          await chrome.management.setEnabled(ext.id, false);
          await chrome.management.setEnabled(ext.id, true);
          reloadedExtensions.push(ext.name);
          debugLog(`Reloaded extension: ${ext.name}`);
        } catch (error: any) {
          debugLog(`Failed to reload extension ${ext.name}:`, error);
        }
      }
    }

    // Switch to a valid tab (not chrome://)
    if (targetTabId !== undefined) {
      try {
        await chrome.tabs.update(targetTabId, { active: true });
        debugLog(`Switched to valid tab ${targetTabId}`);
      } catch (error: any) {
        debugLog(`Failed to switch to tab ${targetTabId}:`, error);
      }
    } else {
      // No valid tabs found, create a new one with about:blank
      debugLog('No valid tabs found, creating new tab with about:blank');
      try {
        const newTab = await chrome.tabs.create({ url: 'about:blank', active: true });
        debugLog(`Created new tab ${newTab.id}`);
      } catch (error: any) {
        debugLog(`Failed to create new tab:`, error);
      }
    }

    return {
      reloadedCount: reloadedExtensions.length,
      reloadedExtensions,
    };
  }

  private async _getTabs(): Promise<any> {
    const allTabs = await chrome.tabs.query({});

    // Get the last focused window (the one the user is actually looking at)
    const focusedWindow = await chrome.windows.getLastFocused();
    const focusedWindowId = focusedWindow.id;

    return {
      tabs: allTabs.map((tab, index) => {
        const isAutomatable = tab.url && !['chrome:', 'edge:', 'devtools:'].some(scheme => tab.url!.startsWith(scheme));
        return {
          id: tab.id,
          title: tab.title,
          url: tab.url,
          active: tab.active,
          windowId: tab.windowId,
          index: index, // Use array index for consistency
          windowFocused: tab.windowId === focusedWindowId,
          automatable: isAutomatable,
        };
      }),
      count: allTabs.length,
      focusedWindowId,
    };
  }

  private async _selectTab(tabIndex: number, activate: boolean = false, stealth: boolean = false, connectionId?: string): Promise<any> {
    const allTabs = await chrome.tabs.query({});

    if (tabIndex < 0 || tabIndex >= allTabs.length) {
      throw new Error(`Tab index ${tabIndex} out of range (0-${allTabs.length - 1})`);
    }

    const selectedTab = allTabs[tabIndex];
    if (!selectedTab.id) {
      throw new Error('Invalid tab ID');
    }

    // Check if tab is automatable (not chrome://, edge://, devtools://)
    const isAutomatable = selectedTab.url && !['chrome:', 'edge:', 'devtools:'].some(scheme => selectedTab.url!.startsWith(scheme));
    if (!isAutomatable) {
      throw new Error(`Cannot automate tab ${tabIndex}: "${selectedTab.title}" (${selectedTab.url || 'no url'}) - chrome://, edge://, and devtools:// pages cannot be automated`);
    }

    // Optionally switch to the tab (default: false - attach in background)
    if (activate) {
      await chrome.tabs.update(selectedTab.id, { active: true });
      await chrome.windows.update(selectedTab.windowId!, { focused: true });
    }

    // Update the debuggee to attach to this tab
    this._debuggee = { tabId: selectedTab.id };

    // In proxy mode, store connection mapping
    if (connectionId) {
      this._connectionMap.set(connectionId, selectedTab.id);
      debugLog(`Stored connection mapping: ${connectionId} → tab ${selectedTab.id}`);
    }

    // Notify background script about tab connection
    if (this.onTabConnected) {
      this.onTabConnected(selectedTab.id);
    }

    // Store and notify about stealth mode
    this._stealthMode = stealth;

    // Notify background script (UI display only)
    if (this.onStealthModeSet) {
      this.onStealthModeSet(stealth);
    }

    // Attach debugger immediately (no lazy attachment)
    debugLog('Attaching debugger to tab:', this._debuggee);
    await chrome.debugger.attach(this._debuggee, '1.3');
    debugLog('Debugger attached successfully');

    return {
      success: true,
      activated: activate,
      tab: {
        id: selectedTab.id,
        title: selectedTab.title,
        url: selectedTab.url,
        index: tabIndex,
      },
    };
  }

  private async _createTab(url: string, activate: boolean = true, stealth: boolean = false, connectionId?: string): Promise<any> {
    // Create a new tab
    const newTab = await chrome.tabs.create({
      url: url,
      active: activate,
    });

    if (!newTab.id) {
      throw new Error('Failed to create tab');
    }

    // Update the debuggee to attach to this new tab
    this._debuggee = { tabId: newTab.id };

    // In proxy mode, store connection mapping
    if (connectionId) {
      this._connectionMap.set(connectionId, newTab.id);
      debugLog(`Stored connection mapping: ${connectionId} → tab ${newTab.id}`);
    }

    // Notify background script about tab connection
    if (this.onTabConnected) {
      this.onTabConnected(newTab.id);
    }

    // Store and notify about stealth mode
    this._stealthMode = stealth;

    // Notify background script (UI display only)
    if (this.onStealthModeSet) {
      this.onStealthModeSet(stealth);
    }

    // Wait for tab to be ready, then attach debugger immediately
    await new Promise(resolve => setTimeout(resolve, 100));
    debugLog('Attaching debugger to new tab:', this._debuggee);
    await chrome.debugger.attach(this._debuggee, '1.3');
    debugLog('Debugger attached successfully');

    return {
      success: true,
      activated: activate,
      tab: {
        id: newTab.id,
        title: newTab.title,
        // Return the requested URL, not newTab.url which might be about:blank initially
        url: url
      },
    };
  }

  private async _activateTab(tabIndex: number): Promise<any> {
    const allTabs = await chrome.tabs.query({});
    const filteredTabs = allTabs.filter(tab =>
      tab.url && !['chrome:', 'edge:', 'devtools:'].some(scheme => tab.url!.startsWith(scheme))
    );

    if (tabIndex < 0 || tabIndex >= filteredTabs.length) {
      throw new Error(`Tab index ${tabIndex} out of range (0-${filteredTabs.length - 1})`);
    }

    const targetTab = filteredTabs[tabIndex];
    if (!targetTab.id) {
      throw new Error('Invalid tab ID');
    }

    // Activate the tab (bring to foreground)
    await chrome.tabs.update(targetTab.id, { active: true });
    await chrome.windows.update(targetTab.windowId!, { focused: true });

    // Do NOT change the debuggee - just activate the tab visually
    return {
      success: true,
      activated: true,
      tab: {
        id: targetTab.id,
        title: targetTab.title,
        url: targetTab.url,
        index: tabIndex,
      },
    };
  }

  private _sendError(code: number, message: string, id?: number | string): void {
    this._sendMessage({
      jsonrpc: '2.0',
      id: id ?? null,
      error: {
        code,
        message,
      },
    });
  }

  private _sendMessage(message: any): void {
    console.error('[Extension] _sendMessage called, readyState:', this._ws.readyState, 'messageType:', message.method || 'response');
    if (this._ws.readyState === WebSocket.OPEN) {
      const data = JSON.stringify(message);
      console.error('[Extension] Sending message, length:', data.length);
      this._ws.send(data);
      console.error('[Extension] Message sent successfully');
    } else {
      console.error('[Extension] WebSocket not OPEN, cannot send. State:', this._ws.readyState);
    }
  }
}
