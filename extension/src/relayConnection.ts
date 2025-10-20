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
  id: number;
  method: string;
  params?: any;
};

type ProtocolResponse = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: string;
};

export class RelayConnection {
  private _debuggee: chrome.debugger.Debuggee;
  private _ws: WebSocket;
  private _eventListener: (source: chrome.debugger.DebuggerSession, method: string, params: any) => void;
  private _detachListener: (source: chrome.debugger.Debuggee, reason: string) => void;
  private _tabPromise: Promise<void>;
  private _tabPromiseResolve!: () => void;
  private _closed = false;
  private _stealthMode: boolean = false;

  onclose?: () => void;
  onStealthModeSet?: (stealth: boolean) => void;
  onTabConnected?: (tabId: number) => void;
  onProjectConnected?: (projectName: string) => void;

  constructor(ws: WebSocket, browserName: string, accessToken?: string) {
    this._debuggee = { };
    this._tabPromise = new Promise(resolve => this._tabPromiseResolve = resolve);
    this._ws = ws;
    this._ws.onmessage = this._onMessage.bind(this);
    this._ws.onclose = () => this._onClose();
    // Store listeners for cleanup
    this._eventListener = this._onDebuggerEvent.bind(this);
    this._detachListener = this._onDebuggerDetach.bind(this);
    chrome.debugger.onEvent.addListener(this._eventListener);
    chrome.debugger.onDetach.addListener(this._detachListener);

    // Send handshake with browser name and optional access token
    this._sendHandshake(browserName, accessToken);
  }

  private _sendHandshake(browserName: string, accessToken?: string): void {
    const params: any = {
      name: browserName
    };

    if (accessToken) {
      params.accessToken = accessToken;
      debugLog('[Extension] Sending handshake with access token');
    } else {
      debugLog('[Extension] Sending handshake without access token (not authenticated)');
    }

    this._sendMessage({
      method: 'extension_handshake',
      params
    });
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
    let message: any;
    try {
      message = JSON.parse(event.data);
    } catch (error: any) {
      debugLog('Error parsing message:', error);
      this._sendError(-32700, `Error parsing message: ${error.message}`);
      return;
    }

    debugLog('Received message:', message);

    // Check if this is a notification/status message (has "type" instead of "method")
    // Notifications don't need a response
    if (message.type && !message.method) {
      debugLog('Received notification:', message.type);
      // Just log it, don't send a response
      return;
    }

    // This is a command - must have "method" and should have "id"
    if (!message.method) {
      debugLog('Invalid command: missing method field');
      return;
    }

    const response: ProtocolResponse = {
      id: message.id,
    };
    try {
      const result = await this._handleCommand(message as ProtocolCommand);
      // Ensure result is always set, even if undefined (for JSON-RPC compliance)
      response.result = result !== undefined ? result : {};
    } catch (error: any) {
      debugLog('Error handling command:', error);
      response.error = error.message;
    }
    debugLog('Sending response:', response);
    this._sendMessage(response);
  }

  private async _handleCommand(message: ProtocolCommand): Promise<any> {
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
      return await this._selectTab(tabIndex, activate, stealth);
    }
    if (message.method === 'createTab') {
      const url = message.params?.url || 'about:blank';
      const activate = message.params?.activate ?? true;
      const stealth = message.params?.stealth ?? false;
      debugLog('Creating new tab - received params:', message.params);
      debugLog('Creating new tab - url:', url, 'activate:', activate, 'stealth:', stealth);
      return await this._createTab(url, activate, stealth);
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

  private async _selectTab(tabIndex: number, activate: boolean = false, stealth: boolean = false): Promise<any> {
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

    // Notify background script about tab connection
    if (this.onTabConnected) {
      this.onTabConnected(selectedTab.id);
    }

    // Store and notify about stealth mode
    this._stealthMode = stealth;

    // Send stealth mode to CDP relay (for Playwright-level patches)
    this._sendMessage({
      method: 'setStealthMode',
      params: { stealthMode: stealth }
    });

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

  private async _createTab(url: string, activate: boolean = true, stealth: boolean = false): Promise<any> {
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

    // Notify background script about tab connection
    if (this.onTabConnected) {
      this.onTabConnected(newTab.id);
    }

    // Store and notify about stealth mode
    this._stealthMode = stealth;

    // Send stealth mode to CDP relay (for Playwright-level patches)
    this._sendMessage({
      method: 'setStealthMode',
      params: { stealthMode: stealth }
    });

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

  private _sendError(code: number, message: string): void {
    this._sendMessage({
      error: {
        code,
        message,
      },
    });
  }

  private _sendMessage(message: any): void {
    if (this._ws.readyState === WebSocket.OPEN)
      this._ws.send(JSON.stringify(message));
  }
}
