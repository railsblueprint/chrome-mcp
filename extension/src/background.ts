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

import { RelayConnection, debugLog } from './relayConnection';

type PageMessage = {
  type: 'connectToMCPRelay';
  mcpRelayUrl: string;
} | {
  type: 'getTabs';
} | {
  type: 'connectToTab';
  tabId?: number;  // Optional: if not provided, lazy tab attachment mode
  windowId?: number;
  mcpRelayUrl: string;
} | {
  type: 'getConnectionStatus';
} | {
  type: 'disconnect';
} | {
  type: 'loginSuccess';
  accessToken: string;
  refreshToken: string;
} | {
  type: 'focusTab';
};

class TabShareExtension {
  private _activeConnection: RelayConnection | undefined;
  private _connectedTabId: number | null = null;
  private _stealthMode: boolean | null = null; // null = N/A, true = On, false = Off
  private _pendingTabSelection = new Map<number, { connection: RelayConnection, timerId?: number }>();
  private _autoConnecting: boolean = false;
  private _autoConnectAttempts: number = 0;
  private _maxAutoConnectAttempts: number = 3; // Stop auto-retrying after 3 failed attempts
  private _logs: Array<{ timestamp: number; message: string }> = [];
  private _maxLogs = 100;

  constructor() {
    chrome.tabs.onRemoved.addListener(this._onTabRemoved.bind(this));
    chrome.tabs.onUpdated.addListener(this._onTabUpdated.bind(this));
    chrome.tabs.onActivated.addListener(this._onTabActivated.bind(this));
    chrome.runtime.onMessage.addListener(this._onMessage.bind(this));
    chrome.storage.onChanged.addListener(this._onStorageChanged.bind(this));

    // Initialize extension as enabled by default
    chrome.storage.local.get(['extensionEnabled'], (result) => {
      if (result.extensionEnabled === undefined) {
        chrome.storage.local.set({ extensionEnabled: true });
      }
    });

    // FORCE GRAY ICON IMMEDIATELY
    console.error('[Background] Constructor: forcing gray icon immediately');
    this._updateGlobalIcon(false);

    // Auto-connect to MCP server on startup (will set icon based on connection result)
    this._autoConnect();
  }

  private async _autoConnect(): Promise<void> {
    if (this._autoConnecting) {
      debugLog('Auto-connect already in progress, skipping');
      return;
    }

    this._autoConnecting = true;

    // Get port from settings
    const port = await new Promise<string>((resolve) => {
      chrome.storage.local.get(['mcpPort'], (result) => {
        resolve(result.mcpPort || '5555');
      });
    });

    const mcpRelayUrl = `ws://127.0.0.1:${port}/extension`;
    debugLog('Auto-connecting to MCP server at ' + mcpRelayUrl);
    try {
      await this._connectToRelay(0, mcpRelayUrl);
      // Connect in lazy mode (no specific tab, tab will be selected on first command)
      await this._connectTab(0, undefined, undefined, mcpRelayUrl);
      debugLog('Auto-connection successful');
      this._autoConnecting = false;
      await this._updateGlobalIcon(true);
      this._broadcastStatusChange();
    } catch (error: any) {
      debugLog('Auto-connection failed: ' + error.message);
      this._autoConnecting = false;
      await this._updateGlobalIcon(false);
      // Retry after 1 second
      setTimeout(() => this._autoConnect(), 1000);
    }
  }

  private async _isExtensionEnabled(): Promise<boolean> {
    return new Promise((resolve) => {
      chrome.storage.local.get(['extensionEnabled'], (result) => {
        resolve(result.extensionEnabled !== false); // Default to true
      });
    });
  }

  // Promise-based message handling is not supported in Chrome: https://issues.chromium.org/issues/40753031
  private _onMessage(message: PageMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) {
    switch (message.type) {
      case 'connectToMCPRelay':
        // Use tab ID if called from tab, or 0 if called from popup
        const sourceId = sender.tab?.id ?? 0;
        this._connectToRelay(sourceId, message.mcpRelayUrl).then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'getTabs':
        this._getTabs().then(
            tabs => sendResponse({ success: true, tabs, currentTabId: sender.tab?.id }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'connectToTab':
        // If no tabId specified, connect in lazy mode (tab will be created/selected on first command)
        const tabId = message.tabId;
        const windowId = message.windowId;
        this._connectTab(sender.tab!.id!, tabId, windowId, message.mcpRelayUrl!).then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true; // Return true to indicate that the response will be sent asynchronously
      case 'getConnectionStatus':
        sendResponse({
          connectedTabId: this._connectedTabId,
          connected: this._activeConnection !== undefined,
          stealthMode: this._stealthMode
        });
        return false;
      case 'disconnect':
        this._disconnect().then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'loginSuccess':
        debugLog('Login success received, saving tokens...');
        chrome.storage.local.set({
          accessToken: message.accessToken,
          refreshToken: message.refreshToken,
          isPro: true
        }, () => {
          debugLog('Tokens saved to storage');
          sendResponse({ success: true });
        });
        return true;
      case 'focusTab':
        debugLog('Focus tab request received from tab:', sender.tab?.id);
        if (sender.tab?.id) {
          chrome.tabs.update(sender.tab.id, { active: true }, () => {
            debugLog('Tab focused successfully');
            sendResponse({ success: true });
          });
        } else {
          sendResponse({ success: false, error: 'No tab ID' });
        }
        return true;
    }
    return false;
  }

  private async _connectToRelay(selectorTabId: number, mcpRelayUrl: string): Promise<void> {
    try {
      const enabled = await this._isExtensionEnabled();
      if (!enabled) {
        throw new Error('Extension is disabled. Please enable it from the extension popup.');
      }

      debugLog(`Connecting to relay at ${mcpRelayUrl}`);

      const socket = new WebSocket(mcpRelayUrl);
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error('WebSocket error'));
        socket.onclose = (event) => {
          // Server rejected the connection (e.g., "Another extension connection already established")
          reject(new Error(`WebSocket closed: ${event.reason || 'Unknown reason'}`));
        };
        // Reduced timeout from 5s to 2s for faster retries
        setTimeout(() => reject(new Error('Connection timeout')), 2000);
      });

      const connection = new RelayConnection(socket);
      connection.onclose = () => {
        debugLog('Connection closed');
        this._pendingTabSelection.delete(selectorTabId);
        // TODO: show error in the selector tab?
      };
      connection.onStealthModeSet = (stealth: boolean) => {
        debugLog('Stealth mode set:', stealth);
        console.error('[Background] Stealth mode set to:', stealth); // Force visible log
        this._stealthMode = stealth;
        this._broadcastStatusChange();
      };
      this._pendingTabSelection.set(selectorTabId, { connection });
      debugLog(`Connected to MCP relay`);
    } catch (error: any) {
      const message = `Failed to connect to MCP relay: ${error.message}`;
      debugLog(message);
      throw new Error(message);
    }
  }

  private async _connectTab(selectorTabId: number, tabId: number | undefined, windowId: number | undefined, mcpRelayUrl: string): Promise<void> {
    try {
      debugLog(`Connecting to relay at ${mcpRelayUrl} (lazy mode: ${!tabId})`);
      try {
        this._activeConnection?.close('Another connection is requested');
      } catch (error: any) {
        debugLog(`Error closing active connection:`, error);
      }
      await this._setConnectedTabId(null);

      this._activeConnection = this._pendingTabSelection.get(selectorTabId)?.connection;
      if (!this._activeConnection)
        throw new Error('No active MCP relay connection');
      this._pendingTabSelection.delete(selectorTabId);

      // Set up stealth mode callback for active connection
      this._activeConnection.onStealthModeSet = (stealth: boolean) => {
        debugLog('Stealth mode set on active connection:', stealth);
        console.error('[Background] Stealth mode set on active connection to:', stealth); // Force visible log
        this._stealthMode = stealth;
        // Update badge to reflect stealth mode
        if (this._connectedTabId) {
          void this._updateBadgeForTab(this._connectedTabId);
        }
        this._broadcastStatusChange();
      };

      // Set up tab connection callback
      this._activeConnection.onTabConnected = (tabId: number) => {
        debugLog('Tab connected:', tabId);
        void this._setConnectedTabId(tabId);
        void this._updateGlobalIcon(true);
        this._broadcastStatusChange();
      };

      // Lazy connection mode: resolve the tab promise without setting tabId
      // The tab will be created when first command arrives
      if (tabId) {
        this._activeConnection.setTabId(tabId);
        await Promise.all([
          this._setConnectedTabId(tabId),
          chrome.tabs.update(tabId, { active: true }),
          chrome.windows.update(windowId!, { focused: true }),
        ]);
      } else {
        // Lazy mode: signal that we're ready, tab will be created on first command
        this._activeConnection.setTabId(undefined as any);
      }

      this._activeConnection.onclose = () => {
        debugLog('MCP connection closed, will auto-reconnect...');
        this._activeConnection = undefined;
        this._stealthMode = null;
        void this._setConnectedTabId(null);
        void this._updateGlobalIcon(false);
        this._broadcastStatusChange();
        // Auto-reconnect after connection loss
        setTimeout(() => this._autoConnect(), 1000);
      };

      debugLog(`Connected to MCP bridge (lazy mode: ${!tabId})`);
    } catch (error: any) {
      await this._setConnectedTabId(null);
      debugLog(`Failed to connect:`, error.message);
      throw error;
    }
  }

  private async _setConnectedTabId(tabId: number | null): Promise<void> {
    const oldTabId = this._connectedTabId;
    this._connectedTabId = tabId;
    if (oldTabId && oldTabId !== tabId)
      await this._updateBadge(oldTabId, { text: '' });
    if (tabId)
      await this._updateBadgeForTab(tabId);
  }

  private async _updateBadgeForTab(tabId: number): Promise<void> {
    // Use checkmark with different colors: blue for normal, black for stealth
    const text = '✓';
    const color = this._stealthMode ? '#000000' : '#1c75bc';
    const title = this._stealthMode ? 'Connected (Stealth Mode)' : 'Connected to MCP client';
    await this._updateBadge(tabId, { text, color, title });
  }

  private async _updateBadge(tabId: number, { text, color, title }: { text: string; color?: string, title?: string }): Promise<void> {
    try {
      await chrome.action.setBadgeText({ tabId, text });
      await chrome.action.setTitle({ tabId, title: title || '' });
      if (color)
        await chrome.action.setBadgeBackgroundColor({ tabId, color });
    } catch (error: any) {
      // Ignore errors as the tab may be closed already.
    }
  }

  private async _updateGlobalIcon(connected: boolean): Promise<void> {
    try {
      console.error('[Background] _updateGlobalIcon called with connected:', connected);
      const iconPath = connected ? {
        "16": "/icons/icon-16.png",
        "32": "/icons/icon-32.png",
        "48": "/icons/icon-48.png",
        "128": "/icons/icon-128.png"
      } : {
        "16": "/icons/icon-16-gray.png",
        "32": "/icons/icon-32-gray.png",
        "48": "/icons/icon-48-gray.png",
        "128": "/icons/icon-128-gray.png"
      };
      console.error('[Background] Setting icon to:', connected ? 'COLOR' : 'GRAY');
      await chrome.action.setIcon({ path: iconPath });
      console.error('[Background] Icon updated successfully');
    } catch (error: any) {
      console.error('[Background] Failed to update icon:', error);
      debugLog('Failed to update icon:', error.message);
    }
  }

  private async _onTabRemoved(tabId: number): Promise<void> {
    const pendingConnection = this._pendingTabSelection.get(tabId)?.connection;
    if (pendingConnection) {
      this._pendingTabSelection.delete(tabId);
      pendingConnection.close('Browser tab closed');
      return;
    }
    if (this._connectedTabId !== tabId)
      return;
    this._activeConnection?.close('Browser tab closed');
    this._activeConnection = undefined;
    this._connectedTabId = null;
  }

  private _onTabActivated(activeInfo: chrome.tabs.TabActiveInfo) {
    for (const [tabId, pending] of this._pendingTabSelection) {
      if (tabId === activeInfo.tabId) {
        if (pending.timerId) {
          clearTimeout(pending.timerId);
          pending.timerId = undefined;
        }
        continue;
      }
      if (!pending.timerId) {
        pending.timerId = setTimeout(() => {
          const existed = this._pendingTabSelection.delete(tabId);
          if (existed) {
            pending.connection.close('Tab has been inactive for 5 seconds');
            chrome.tabs.sendMessage(tabId, { type: 'connectionTimeout' });
          }
        }, 5000);
        return;
      }
    }
  }

  private _onTabUpdated(tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) {
    if (this._connectedTabId === tabId)
      void this._setConnectedTabId(tabId);
  }

  private async _getTabs(): Promise<chrome.tabs.Tab[]> {
    const tabs = await chrome.tabs.query({});
    return tabs.filter(tab => tab.url && !['chrome:', 'edge:', 'devtools:'].some(scheme => tab.url!.startsWith(scheme)));
  }

  private async _disconnect(): Promise<void> {
    this._activeConnection?.close('User disconnected');
    this._activeConnection = undefined;
    this._stealthMode = null; // Reset to N/A when disconnecting
    await this._setConnectedTabId(null);
    await this._updateGlobalIcon(false);
    this._broadcastStatusChange();
  }

  private _broadcastStatusChange(): void {
    // Broadcast status change to all extension pages (popup, etc.)
    chrome.runtime.sendMessage({
      type: 'statusChanged',
      connectedTabId: this._connectedTabId,
      connected: this._activeConnection !== undefined,
      stealthMode: this._stealthMode
    }).catch(() => {
      // Ignore errors if no listeners (popup might be closed)
    });
  }

  private _onStorageChanged(changes: { [key: string]: chrome.storage.StorageChange }, areaName: string): void {
    if (areaName === 'local' && changes.extensionEnabled) {
      const isEnabled = changes.extensionEnabled.newValue !== false;
      debugLog('Extension enabled changed to:', isEnabled);
      // Update icon based on enabled state AND connection state
      const isConnected = this._activeConnection !== undefined;
      void this._updateGlobalIcon(isEnabled && isConnected);

      // If disabled, disconnect
      if (!isEnabled && this._activeConnection) {
        void this._disconnect();
      }
    }
  }
}

new TabShareExtension();
