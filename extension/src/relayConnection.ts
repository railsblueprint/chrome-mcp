/**
 * Copyright (c) 2024 Rails Blueprint
 * Originally inspired by Microsoft's Playwright MCP
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

import { getStableClientId, storeExtensionId } from './utils/clientId';
import { formatAccessibilitySnapshot } from './utils/snapshotFormatter';

let debugModeEnabled = false;

// Initialize debug mode from storage
chrome.storage.local.get(['debugMode'], (result) => {
  debugModeEnabled = result.debugMode || false;
});

// Listen for debug mode changes
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.debugMode) {
    debugModeEnabled = changes.debugMode.newValue || false;
  }
});

export function debugLog(...args: unknown[]): void {
  if (debugModeEnabled) {
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
  private _tabConnectionMap: Map<number, string> = new Map(); // tabId → connectionId (for error messages)
  private _browserName: string;
  private _accessToken?: string;
  private _stableClientId?: string; // Stable client ID for rolling updates
  // Per-tab storage for console messages and network requests
  private _consoleMessages: Map<number, Array<{ type: string; text: string; timestamp: number; url?: string; lineNumber?: number }>> = new Map();
  private _networkRequests: Map<number, Array<{
    requestId: string;
    url: string;
    method: string;
    timestamp: number;
    statusCode?: number;
    statusText?: string;
    type?: string;
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
    requestBody?: string;
  }>> = new Map();
  private _requestsMap: Map<string, any> = new Map(); // requestId → request details
  private _executionContexts: Map<number, any> = new Map(); // contextId → context info
  private _mainContextId: number | null = null; // Main page execution context
  private _extensionContexts: Map<string, Set<number>> = new Map(); // extensionId → Set of contextIds
  private _cleanupInterval?: ReturnType<typeof setInterval>; // Periodic cleanup for stale tab data

  onclose?: () => void;
  onStealthModeSet?: (stealth: boolean) => void;
  onTabConnected?: (tabId: number) => void;
  onProjectConnected?: (projectName: string) => void;
  onConnectionStatus?: (status: { max_connections: number; connections_used: number; connections_to_this_browser: number }) => void;

  constructor(ws: WebSocket, browserName: string, accessToken?: string) {
    this._debuggee = { };
    this._tabPromise = new Promise(resolve => this._tabPromiseResolve = resolve);
    this._ws = ws;
    this._browserName = browserName;
    this._accessToken = accessToken;

    debugLog('Setting up WebSocket handlers');
    this._ws.onmessage = this._onMessage.bind(this);
    this._ws.onclose = () => {
      debugLog('WebSocket closed');
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

    // Start periodic cleanup for stale tab data (every 5 minutes)
    this._cleanupInterval = setInterval(() => {
      this.cleanupStaleTabData().catch(err => debugLog('Cleanup error:', err));
    }, 5 * 60 * 1000); // 5 minutes

    // In proxy mode: Extension is PASSIVE - wait for proxy to send authenticate request
    // In direct mode: This still works but is legacy (will be replaced by JSON-RPC)
    debugLog('Connection established, WebSocket state:', ws.readyState);
    debugLog('Connection established, waiting for authenticate request from proxy');
  }

  // Either setTabId or close is called after creating the connection.
  setTabId(tabId: number | undefined): void {
    if (tabId !== undefined) {
      this._debuggee = { tabId };
    }
    // Always resolve the promise, even in lazy mode without tabId
    this._tabPromiseResolve();
  }

  // Detach from current tab without closing WebSocket connection
  async detachTab(): Promise<void> {
    const tabId = this._debuggee.tabId;
    if (tabId) {
      debugLog(`Detaching from tab ${tabId} but keeping connection alive`);
      try {
        await chrome.debugger.detach({ tabId });
        debugLog(`Successfully detached debugger from tab ${tabId}`);
      } catch (error) {
        debugLog(`Error detaching debugger from tab ${tabId}:`, error);
      }
      // Clean up tracking data for this specific tab
      this.clearTabTracking(tabId);
    }
    this._debuggee = { };
    this._mainContextId = null;
  }

  close(message: string): void {
    this._ws.close(1000, message);
    // ws.onclose is called asynchronously, so we call it here to avoid forwarding
    // CDP events to the closed connection.
    this._onClose();
  }

  private async _enableDomainsForTracking(): Promise<void> {
    try {
      // Enable Console domain for console message tracking
      await chrome.debugger.sendCommand(this._debuggee, 'Runtime.enable');
      await chrome.debugger.sendCommand(this._debuggee, 'Log.enable');

      // Enable Network domain for network request tracking
      await chrome.debugger.sendCommand(this._debuggee, 'Network.enable');

      // Enable Page domain for navigation detection (to clear tracking on navigation)
      await chrome.debugger.sendCommand(this._debuggee, 'Page.enable');

      debugLog('Console, Network, and Page domains enabled for tracking');

      // Query existing execution contexts to find main page context
      // This is needed because contexts created before Runtime.enable won't trigger events
      try {
        const result: any = await chrome.debugger.sendCommand(this._debuggee, 'Runtime.evaluate', {
          expression: '1', // Dummy expression to trigger context detection
          returnByValue: true
        });

        if (result.executionContextId) {
          debugLog(`Current execution context from evaluate: ${result.executionContextId}`);
          // This will be updated by events if there are multiple contexts
          if (this._mainContextId === null) {
            this._mainContextId = result.executionContextId;
            debugLog(`Initial main context set to: ${this._mainContextId}`);
          }
        }
      } catch (error) {
        debugLog('Failed to get initial context, will rely on events:', error);
      }
    } catch (error) {
      console.error('[Extension] Failed to enable tracking domains:', error);
    }
  }

  clearTracking(): void {
    // Clear all tabs' data
    this._consoleMessages.clear();
    this._networkRequests.clear();
    this._requestsMap.clear();
  }

  // Clear tracking data for a specific tab
  clearTabTracking(tabId: number): void {
    this._consoleMessages.delete(tabId);
    this._networkRequests.delete(tabId);
    // Note: _requestsMap is not tab-specific, so we don't clear it here
  }

  // Clean up tracking data for tabs that no longer exist
  async cleanupStaleTabData(): Promise<void> {
    try {
      // Get all tracked tab IDs
      const trackedTabIds = new Set([
        ...this._consoleMessages.keys(),
        ...this._networkRequests.keys()
      ]);

      if (trackedTabIds.size === 0) {
        return; // Nothing to clean up
      }

      // Check which tabs still exist
      const openTabIds = new Set<number>();
      try {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          if (tab.id !== undefined) {
            openTabIds.add(tab.id);
          }
        }
      } catch (error) {
        debugLog('Error querying tabs for cleanup:', error);
        return; // Don't clean up if we can't verify tab state
      }

      // Remove data for tabs that no longer exist
      let cleaned = 0;
      for (const tabId of trackedTabIds) {
        if (!openTabIds.has(tabId)) {
          this.clearTabTracking(tabId);
          cleaned++;
          debugLog(`Cleaned up stale data for closed tab ${tabId}`);
        }
      }

      if (cleaned > 0) {
        debugLog(`Cleanup: Removed data for ${cleaned} closed tab(s)`);
      }
    } catch (error) {
      debugLog('Error during stale tab cleanup:', error);
    }
  }

  getConsoleMessages(): Array<{ type: string; text: string; timestamp: number; url?: string; lineNumber?: number }> {
    const tabId = this._debuggee.tabId;
    if (!tabId) {
      return []; // No tab attached
    }
    const messages = this._consoleMessages.get(tabId) || [];
    return messages.slice(); // Return a copy
  }

  getNetworkRequests(): Array<{
    requestId: string;
    url: string;
    method: string;
    timestamp: number;
    statusCode?: number;
    statusText?: string;
    type?: string;
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
    requestBody?: string;
  }> {
    const tabId = this._debuggee.tabId;
    if (!tabId) {
      return []; // No tab attached
    }
    const requests = this._networkRequests.get(tabId) || [];
    return requests.slice(); // Return a copy
  }

  async getResponseBody(requestId: string): Promise<{ body?: string; base64Encoded?: boolean; error?: string }> {
    try {
      const result = await chrome.debugger.sendCommand(this._debuggee, 'Network.getResponseBody', { requestId }) as { body: string; base64Encoded: boolean } | undefined;
      if (!result) {
        return {
          error: 'No response received from debugger'
        };
      }
      return {
        body: result.body,
        base64Encoded: result.base64Encoded
      };
    } catch (error: any) {
      debugLog(`Failed to get response body for ${requestId}:`, error);
      return {
        error: error.message || 'Failed to retrieve response body'
      };
    }
  }

  private _onClose() {
    if (this._closed)
      return;
    this._closed = true;

    // Stop periodic cleanup
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = undefined;
    }

    chrome.debugger.onEvent.removeListener(this._eventListener);
    chrome.debugger.onDetach.removeListener(this._detachListener);
    chrome.debugger.detach(this._debuggee).catch(() => {});

    // Clean up all tracking data when connection closes
    this.clearTracking();

    this.onclose?.();
  }

  private _onDebuggerEvent(source: chrome.debugger.DebuggerSession, method: string, params: any): void {
    if (source.tabId !== this._debuggee.tabId)
      return;

    // Log navigation events to understand detach timing
    if (method.startsWith('Page.frame')) {
      debugLog(`CDP Navigation Event: ${method}, frameId: ${params.frame?.id}, parentId: ${params.frame?.parentId}, url: ${params.frame?.url || params.url || 'unknown'}`);
    }

    // Clear tracking on navigation (main frame only)
    if (method === 'Page.frameNavigated') {
      // Only clear on main frame navigation, not iframes
      if (!params.frame?.parentId) {
        debugLog('Main frame navigated, clearing console and network tracking');
        this.clearTracking();
      }
    }

    // Track execution contexts (to avoid extension iframes)
    if (method === 'Runtime.executionContextCreated') {
      const context = params.context;
      this._executionContexts.set(context.id, context);

      debugLog(`Context created: id=${context.id}, origin=${context.origin}, name=${context.name}, isDefault=${context.auxData?.isDefault}, frameId=${context.auxData?.frameId}`);

      // Track chrome-extension:// contexts for debugging
      if (context.origin?.startsWith('chrome-extension://')) {
        const extensionId = context.origin.replace('chrome-extension://', '').split('/')[0];
        if (!this._extensionContexts.has(extensionId)) {
          this._extensionContexts.set(extensionId, new Set());
        }
        this._extensionContexts.get(extensionId)!.add(context.id);
        debugLog(`Tracking chrome-extension context: ${context.id}, extensionId: ${extensionId}`);
        return;
      }

      // Main page context: ONLY set once on first non-extension context
      // Don't update unless it gets destroyed - this prevents iframes from hijacking the main context
      if (this._mainContextId === null) {
        this._mainContextId = context.id;
        debugLog(`Main page context set: ${context.id} (origin: ${context.origin})`);
      }
    }

    if (method === 'Runtime.executionContextDestroyed') {
      const contextId = params.executionContextId;
      this._executionContexts.delete(contextId);

      // Remove from extension contexts tracking
      for (const [extensionId, contextIds] of this._extensionContexts.entries()) {
        contextIds.delete(contextId);
        if (contextIds.size === 0) {
          this._extensionContexts.delete(extensionId);
        }
      }

      if (this._mainContextId === contextId) {
        this._mainContextId = null;
        debugLog('Main context destroyed, will reset on next context creation');
      }
    }

    if (method === 'Runtime.executionContextsCleared') {
      this._executionContexts.clear();
      this._extensionContexts.clear();
      // Don't clear mainContextId - keep it as fallback until we get a new one
      // This is important for reattach scenarios where we can't get new contexts
      debugLog('All execution contexts cleared (keeping mainContextId as fallback)');
    }

    // Capture console messages (unless in stealth mode)
    if (method === 'Runtime.consoleAPICalled' && !this._stealthMode) {
      const tabId = this._debuggee.tabId;
      if (tabId) {
        const args = params.args || [];
        const textParts = args.map((arg: any) => arg.value || arg.description || String(arg)).join(' ');
        const messages = this._consoleMessages.get(tabId) || [];
        messages.push({
          type: params.type || 'log',
          text: textParts,
          timestamp: params.timestamp || Date.now(),
          url: params.stackTrace?.callFrames?.[0]?.url,
          lineNumber: params.stackTrace?.callFrames?.[0]?.lineNumber,
        });
        this._consoleMessages.set(tabId, messages);
      }
    }

    // Capture runtime exceptions
    if (method === 'Runtime.exceptionThrown' && !this._stealthMode) {
      const tabId = this._debuggee.tabId;
      if (tabId) {
        const exception = params.exceptionDetails;
        const messages = this._consoleMessages.get(tabId) || [];
        messages.push({
          type: 'error',
          text: exception?.text || exception?.exception?.description || 'Unknown error',
          timestamp: exception?.timestamp || Date.now(),
          url: exception?.url,
          lineNumber: exception?.lineNumber,
        });
        this._consoleMessages.set(tabId, messages);
      }
    }

    // Capture network requests
    if (method === 'Network.requestWillBeSent') {
      const request = params.request;
      this._requestsMap.set(params.requestId, {
        url: request.url,
        method: request.method,
        timestamp: params.timestamp || Date.now(),
        type: params.type,
        requestHeaders: request.headers,
        requestBody: request.postData, // May be undefined
      });
    }

    // Capture network responses
    if (method === 'Network.responseReceived') {
      const tabId = this._debuggee.tabId;
      const requestData = this._requestsMap.get(params.requestId);
      if (requestData && tabId) {
        const response = params.response;
        const requests = this._networkRequests.get(tabId) || [];
        requests.push({
          requestId: params.requestId,
          url: requestData.url,
          method: requestData.method,
          timestamp: requestData.timestamp,
          statusCode: response.status,
          statusText: response.statusText,
          type: requestData.type,
          requestHeaders: requestData.requestHeaders,
          responseHeaders: response.headers,
          requestBody: requestData.requestBody,
        });
        this._networkRequests.set(tabId, requests);
      }
    }

    // CDP events are captured locally only, not forwarded automatically
    // They will be sent when explicitly requested via getConsoleLogs or getNetworkRequests
    debugLog('CDP event captured locally:', method);
  }

  private async _onDebuggerDetach(source: chrome.debugger.Debuggee, reason: string): Promise<void> {
    if (source.tabId !== this._debuggee.tabId)
      return;

    const tabId = source.tabId;
    if (!tabId) {
      // No tabId means debugger was never properly attached, just clear state
      console.error(`[Extension] Debugger detached without tabId, reason: ${reason}`);
      this._debuggee = { };
      return;
    }

    console.error(`[Extension] Debugger detached from tab ${tabId}, reason: ${reason}`);

    // Check if tab still exists before deciding what to do
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab) {
        console.error(`[Extension] Tab ${tabId} still exists (URL: ${tab.url}), attempting to reattach debugger...`);

        // Check if tab URL is automatable before reattaching
        const isAutomatable = tab.url && !['chrome:', 'edge:', 'devtools:', 'chrome-extension:'].some(scheme => tab.url!.startsWith(scheme));
        if (!isAutomatable) {
          console.error(`[Extension] Tab ${tabId} has non-automatable URL (${tab.url}), cannot reattach. Clearing tab attachment but keeping connection alive.`);
          // Clean up tracking data for this tab
          this.clearTabTracking(tabId);
          this._debuggee = { };
          return;
        }

        // Try to reattach debugger
        try {
          await chrome.debugger.attach({ tabId }, '1.3');

          // Try to enable tracking domains, but don't fail if they can't be enabled
          // Chrome extensions (like iCloud Password Manager) inject iframes that block CDP tracking
          // Tracking is optional - automation still works without it
          let domainsEnabled = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 200));
            try {
              await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
              await chrome.debugger.sendCommand({ tabId }, 'Log.enable');
              await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
              await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
              domainsEnabled = true;
              console.error(`[Extension] Tracking domains enabled after ${attempt + 1} attempts`);
              break;
            } catch (domainError) {
              // Ignore - tracking is optional
            }
          }

          if (!domainsEnabled) {
            console.error(`[Extension] Could not enable tracking domains (likely due to extension iframes), continuing without console/network tracking`);
          }

          // Get a valid execution context even if domains failed to enable
          // This is critical for Runtime.evaluate to work
          // Wait longer for extension iframes to settle
          if (this._mainContextId === null) {
            for (let attempt = 0; attempt < 10; attempt++) {
              await new Promise(resolve => setTimeout(resolve, 300));
              try {
                // Force enable Runtime domain just to get context
                await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
                // Do a simple evaluate to get the current context ID
                const result: any = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
                  expression: '1',
                  returnByValue: true
                });
                if (result.executionContextId) {
                  this._mainContextId = result.executionContextId;
                  console.error(`[Extension] Got execution context ${this._mainContextId} from evaluate after ${attempt + 1} attempts`);
                  break;
                }
              } catch (error) {
                console.error(`[Extension] Attempt ${attempt + 1}/10 to get execution context failed:`, error);
              }
            }

            if (this._mainContextId === null) {
              console.error('[Extension] Failed to get execution context after 10 attempts, automation may not work');
            }
          }

          console.error(`[Extension] Successfully reattached debugger to tab ${tabId}`);
          return; // Successfully reattached
        } catch (reattachError: any) {
          console.error(`[Extension] Failed to reattach debugger:`, reattachError);
          // Fall through to handle as tab lost
        }
      }
    } catch (error) {
      // Tab doesn't exist
      console.error(`[Extension] Tab ${tabId} no longer exists`);
    }

    // Tab no longer exists or couldn't reattach
    // DON'T close WebSocket connection - just clear the tab attachment
    // Extension should remain connected and operational for tab management commands
    console.error(`[Extension] Clearing tab attachment but keeping connection alive`);

    // Clean up tracking data for this tab
    this.clearTabTracking(tabId);

    this._debuggee = { };
  }

  private _onMessage(event: MessageEvent): void {
    this._onMessageAsync(event).catch(e => debugLog('Error handling message:', e));
  }

  private async _onMessageAsync(event: MessageEvent): Promise<void> {
    debugLog('_onMessageAsync called, data length:', event.data?.length);

    let message: any;
    try {
      message = JSON.parse(event.data);
      debugLog('Received message:', message);
    } catch (error: any) {
      debugLog('Error parsing message:', error);
      this._sendError(-32700, `Error parsing message: ${error.message}`);
      return;
    }

    // Check if this is a JSON-RPC notification (has "method" but NO "id")
    // Notifications don't require a response
    if (message.method && message.id === undefined) {
      debugLog('Received notification:', message.method, message.params);

      // Handle specific notifications
      if (message.method === 'disconnected') {
        await this._handleDisconnectedNotification(message.params);
      } else if (message.method === 'connection_status') {
        await this._handleConnectionStatusNotification(message.params);
      } else if (message.method === 'authenticated') {
        await this._handleAuthenticatedNotification(message.params);
      }

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

      debugLog(`About to add currentTab, debuggee.tabId=${this._debuggee.tabId}`);

      // Add current tab info to result (not to response itself - that would be non-standard JSON-RPC)
      // Always include currentTab (null if no tab attached) so MCP knows to clear stale state
      if (this._debuggee.tabId) {
        try {
          const tab = await chrome.tabs.get(this._debuggee.tabId);
          response.result.currentTab = {
            id: tab.id,
            title: tab.title,
            url: tab.url,
            index: tab.index
          };
          debugLog('Added current tab info to result:', tab.url);
        } catch (error: any) {
          debugLog('Failed to get current tab info:', error);
          // Tab might have been closed, set to null
          response.result.currentTab = null;
          debugLog('Set currentTab to null due to error getting tab');
        }
      } else {
        // No tab attached - explicitly set to null so MCP clears its cached state
        response.result.currentTab = null;
        debugLog('No tab attached, set currentTab to null');
      }
    } catch (error: any) {
      debugLog('Error handling command:', message.method, error);
      debugLog('Error stack:', error.stack);
      response.error = {
        code: -32000,
        message: error.message || String(error)
      };
    }

    try {
      debugLog(`About to send response, result.currentTab: ${response.result?.currentTab}`);
      debugLog('Sending response:', JSON.stringify(response).substring(0, 200));
      this._sendMessage(response);
      debugLog('Response sent successfully');
    } catch (sendError: any) {
      debugLog('ERROR sending response:', sendError);
    }
  }

  private async _handleDisconnectedNotification(params: any): Promise<void> {
    const connectionId = params?.connection_id;
    const reason = params?.reason || 'Unknown reason';

    debugLog(`Received disconnected notification for connection ${connectionId}: ${reason}`);

    if (!connectionId) {
      debugLog('No connection_id in disconnected notification');
      return;
    }

    // Look up which tab is associated with this connection
    const tabId = this._connectionMap.get(connectionId);

    if (tabId) {
      debugLog(`Connection ${connectionId} was using tab ${tabId}, detaching debugger`);

      try {
        // Detach debugger from the tab
        await chrome.debugger.detach({ tabId });
        debugLog(`Successfully detached debugger from tab ${tabId}`);

        // Clear connection state
        this._connectionMap.delete(connectionId);
        this._tabConnectionMap.delete(tabId);

        // If this was our current debuggee, clear it
        if (this._debuggee.tabId === tabId) {
          debugLog(`Clearing current debuggee (was tab ${tabId})`);
          this._debuggee = {};
        }
      } catch (error: any) {
        debugLog(`Error detaching debugger from tab ${tabId}:`, error);
      }
    } else {
      debugLog(`No tab found for connection ${connectionId}`);
    }
  }

  private async _handleConnectionStatusNotification(params: any): Promise<void> {
    debugLog('connection_status notification params:', JSON.stringify(params, null, 2));

    // Extract project_name from active_connections if available
    if (params.active_connections && params.active_connections.length > 0) {
      const firstConnection = params.active_connections[0];
      // Try different field names: project_name, mcp_client_id, client_id, clientID, name
      let projectName = firstConnection.project_name ||
                        firstConnection.mcp_client_id ||
                        firstConnection.client_id ||
                        firstConnection.clientID ||
                        firstConnection.name;

      // Strip "mcp-" prefix if present
      if (projectName && projectName.startsWith('mcp-')) {
        projectName = projectName.substring(4); // Remove "mcp-"
      }

      if (projectName && this.onProjectConnected) {
        debugLog('Project connected from connection_status:', projectName);
        this.onProjectConnected(projectName);
      } else {
        debugLog('No project name found in connection. firstConnection:', JSON.stringify(firstConnection, null, 2));
      }
    } else {
      debugLog('No active_connections in params');
    }

    // Notify the background script about connection status update
    if (this.onConnectionStatus) {
      this.onConnectionStatus({
        max_connections: params.max_connections,
        connections_used: params.connections_used,
        connections_to_this_browser: params.connections_to_this_browser
      });
    }
  }

  private async _handleAuthenticatedNotification(params: any): Promise<void> {
    // Store the extension_id assigned by the server
    if (params.extension_id) {
      await storeExtensionId(params.extension_id);
      debugLog('Stored extension_id from server:', params.extension_id);
    }

    // Store user_id if provided
    if (params.user_id) {
      debugLog('User authenticated with ID:', params.user_id);
    }

    // Store and notify project name (client_id) if provided
    if (params.client_id && this.onProjectConnected) {
      debugLog('Project connected:', params.client_id);
      this.onProjectConnected(params.client_id);
    }
  }

  private async _handleCommand(message: ProtocolCommand, connectionId?: string): Promise<any> {
    // Handle authenticate request from proxy (proxy-control mode)
    if (message.method === 'authenticate') {
      debugLog('Received authenticate request from proxy');

      // Get or generate stable client_id for rolling updates
      if (!this._stableClientId) {
        this._stableClientId = await getStableClientId();
      }

      return {
        name: this._browserName,
        access_token: this._accessToken,
        client_id: this._stableClientId
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
        await this._enableDomainsForTracking();
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
            this._tabConnectionMap.set(tab.id, connectionId);
            debugLog(`Stored connection mapping: ${connectionId} ↔ tab ${tab.id}`);
          }

          // Notify background script
          if (this.onTabConnected) {
            this.onTabConnected(tab.id);
          }

          // Wait for page to load, then attach debugger
          await new Promise(resolve => setTimeout(resolve, 500));
          debugLog('Attaching debugger to test page tab:', this._debuggee);
          await chrome.debugger.attach(this._debuggee, '1.3');
          await this._enableDomainsForTracking();
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
      throw new Error('No tab is connected. The extension will reconnect automatically - please wait a moment and try again.');

    if (message.method === 'getConsoleMessages') {
      return {
        messages: this.getConsoleMessages(),
      };
    }

    if (message.method === 'getNetworkRequests') {
      return {
        requests: this.getNetworkRequests(),
      };
    }

    if (message.method === 'getResponseBody') {
      const { requestId } = message.params;
      return await this.getResponseBody(requestId);
    }

    if (message.method === 'clearTracking') {
      this.clearTracking();
      return {
        success: true,
      };
    }

    if (message.method === 'forwardCDPCommand') {
      const { sessionId, method, params } = message.params;
      debugLog('CDP command:', method, params);

      // Don't inject contextId - let CDP use default page context
      // The mainContextId tracking was causing issues with context becoming invalid
      // CDP should default to the main page context automatically
      let modifiedParams = params;

      const debuggerSession: chrome.debugger.DebuggerSession = {
        ...this._debuggee,
        sessionId,
      };

      // Forward CDP command to chrome.debugger with enhanced error handling
      try {
        const result = await chrome.debugger.sendCommand(
            debuggerSession,
            method,
            modifiedParams
        );

        // Post-process accessibility snapshots to reduce size
        if (method === 'Accessibility.getFullAXTree' && result) {
          const formatted = formatAccessibilitySnapshot(result as { nodes: any[] });
          debugLog(`Formatted snapshot: ${formatted.totalLines} lines, truncated: ${formatted.truncated}`);
          return { formattedSnapshot: formatted };
        }

        return result;
      } catch (error: any) {
        // Detect extension blocking errors
        if (error.message && error.message.includes('chrome-extension://')) {
          const extensionInfo = await this._getBlockingExtensionsInfo();
          throw new Error(
            `Browser extension blocking debugging: ${extensionInfo}\n\n` +
            `This page has extensions that inject iframes, preventing automation. ` +
            `Please disable the blocking extension(s) and try again.\n\n` +
            `Original error: ${error.message}`
          );
        }
        throw error;
      }
    }
  }

  private async _getBlockingExtensionsInfo(): Promise<string> {
    const extensionInfos: string[] = [];

    // First, check if we have tracked extension contexts
    if (this._extensionContexts.size > 0) {
      for (const extensionId of this._extensionContexts.keys()) {
        try {
          const extInfo = await chrome.management.get(extensionId);
          extensionInfos.push(`"${extInfo.name}" (ID: ${extensionId})`);
        } catch {
          // If we can't get extension info, just show the ID
          extensionInfos.push(`Extension ID: ${extensionId}`);
        }
      }
      return extensionInfos.join(', ');
    }

    // If no contexts tracked yet, list all enabled extensions that commonly inject iframes
    // This includes password managers and similar tools
    try {
      const allExtensions = await chrome.management.getAll();
      const ourExtensionId = chrome.runtime.id;

      // Known problematic extension types (password managers, etc.)
      const suspiciousKeywords = [
        'password', 'icloud', 'lastpass', '1password', 'bitwarden',
        'dashlane', 'keeper', 'roboform', 'enpass'
      ];

      const likelyBlockers = allExtensions.filter(ext => {
        if (!ext.enabled || ext.id === ourExtensionId) return false;
        const name = ext.name.toLowerCase();
        return suspiciousKeywords.some(keyword => name.includes(keyword));
      });

      if (likelyBlockers.length > 0) {
        return likelyBlockers
          .map(ext => `"${ext.name}" (ID: ${ext.id})`)
          .join(', ') + ' (likely culprit based on extension type)';
      }
    } catch {
      // Ignore errors when listing extensions
    }

    return 'Unknown extension - check for password managers or similar extensions that inject iframes into pages';
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
    // Get our own extension name
    const ourManifest = chrome.runtime.getManifest();
    const ourExtensionName = ourManifest.name;

    // When no extension name provided, default to reloading ourselves safely
    if (!extensionName) {
      debugLog(`No extension name provided, reloading ${ourExtensionName} using chrome.runtime.reload()`);
      setTimeout(() => {
        chrome.runtime.reload();
      }, 100);
      return {
        reloadedCount: 1,
        reloadedExtensions: [ourExtensionName],
        message: 'Extension will reload and reconnect automatically. Please wait a moment before making the next request.',
      };
    }

    // Special case: reloading Blueprint MCP itself by name
    if (extensionName === ourExtensionName || extensionName === 'Blueprint MCP for Chrome') {
      debugLog(`Reloading ${ourExtensionName} using chrome.runtime.reload()`);
      setTimeout(() => {
        chrome.runtime.reload();
      }, 100);
      return {
        reloadedCount: 1,
        reloadedExtensions: [ourExtensionName],
        message: 'Extension will reload and reconnect automatically. Please wait a moment before making the next request.',
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

        // Skip ourselves - use chrome.runtime.reload() for self-reload
        if (ext.name === ourExtensionName) {
          debugLog(`Skipping self-reload via disable/enable for ${ext.name}, use chrome.runtime.reload() instead`);
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

    // Get our own extension ID to help filter internal tabs
    const ourExtensionId = chrome.runtime.id;

    return {
      tabs: allTabs.map((tab, index) => {
        const isAutomatable = tab.url && !['chrome:', 'edge:', 'devtools:', 'chrome-extension:'].some(scheme => tab.url!.startsWith(scheme));

        // Extract extension ID from chrome-extension:// URLs
        let extensionId = undefined;
        if (tab.url?.startsWith('chrome-extension://')) {
          const match = tab.url.match(/^chrome-extension:\/\/([^\/]+)/);
          if (match) {
            extensionId = match[1];
          }
        }

        return {
          id: tab.id,
          title: tab.title,
          url: tab.url,
          active: tab.active,
          windowId: tab.windowId,
          index: index, // Use array index for consistency
          windowFocused: tab.windowId === focusedWindowId,
          automatable: isAutomatable,
          extensionId: extensionId, // Include extension ID for chrome-extension:// tabs
        };
      }),
      count: allTabs.length,
      focusedWindowId,
      ourExtensionId, // Include our extension ID so backend can filter our tabs
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

    debugLog(`_selectTab: index=${tabIndex}, id=${selectedTab.id}, url=${selectedTab.url}, title=${selectedTab.title}`);

    // Check if tab is automatable (not chrome://, edge://, devtools://, chrome-extension://)
    const isAutomatable = selectedTab.url && !['chrome:', 'edge:', 'devtools:', 'chrome-extension:'].some(scheme => selectedTab.url!.startsWith(scheme));
    if (!isAutomatable) {
      throw new Error(`Cannot automate tab ${tabIndex}: "${selectedTab.title}" (${selectedTab.url || 'no url'}) - chrome://, edge://, devtools://, and chrome-extension:// pages cannot be automated`);
    }

    // Optionally switch to the tab (default: false - attach in background)
    if (activate) {
      await chrome.tabs.update(selectedTab.id, { active: true });
      await chrome.windows.update(selectedTab.windowId!, { focused: true });
    }

    // Update the debuggee to attach to this tab
    this._debuggee = { tabId: selectedTab.id };

    // Check if tab is already attached to another connection (in proxy mode)
    if (connectionId) {
      const existingConnectionId = this._tabConnectionMap.get(selectedTab.id);
      if (existingConnectionId && existingConnectionId !== connectionId) {
        throw new Error(
          `Tab ${tabIndex} ("${selectedTab.title}") is already attached to another MCP connection.\n\n` +
          `This tab is being used by another MCP client. Please:\n` +
          `1. Use a different tab, OR\n` +
          `2. Disconnect the other MCP client first\n\n` +
          `Other connection ID: ${existingConnectionId}`
        );
      }
    }

    // In proxy mode, store connection mapping
    if (connectionId) {
      this._connectionMap.set(connectionId, selectedTab.id);
      this._tabConnectionMap.set(selectedTab.id, connectionId);
      debugLog(`Stored connection mapping: ${connectionId} ↔ tab ${selectedTab.id}`);
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
    try {
      await chrome.debugger.attach(this._debuggee, '1.3');
      await this._enableDomainsForTracking();
      debugLog('Debugger attached successfully');
    } catch (error: any) {
      // Detect extension blocking errors
      if (error.message && error.message.includes('chrome-extension://')) {
        const extensionInfo = await this._getBlockingExtensionsInfo();
        throw new Error(
          `Browser extension blocking debugging: ${extensionInfo}\n\n` +
          `This page has extensions that inject iframes, preventing automation. ` +
          `Please disable the blocking extension(s) and try again.\n\n` +
          `Original error: ${error.message}`
        );
      }
      // Improve "Another debugger" error message
      if (error.message && error.message.includes('Another debugger')) {
        throw new Error(
          `Tab ${tabIndex} ("${selectedTab.title}") is already attached to another debugger/MCP.\n\n` +
          `This usually means another MCP connection or DevTools is using this tab. Please:\n` +
          `1. Close DevTools if open on this tab\n` +
          `2. Disconnect other MCP clients\n` +
          `3. Use a different tab\n\n` +
          `Original error: ${error.message}`
        );
      }
      throw error;
    }

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
      this._tabConnectionMap.set(newTab.id, connectionId);
      debugLog(`Stored connection mapping: ${connectionId} ↔ tab ${newTab.id}`);
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

    // Wait for tab to have a URL before attaching debugger
    // Tabs created with chrome.tabs.create start with empty URL
    let tabInfo = await chrome.tabs.get(newTab.id);
    let attempts = 0;
    while (!tabInfo.url && attempts < 50) {
      await new Promise(resolve => setTimeout(resolve, 100));
      tabInfo = await chrome.tabs.get(newTab.id);
      attempts++;
    }

    debugLog(`Tab ${newTab.id} URL before attach: ${tabInfo.url}, status: ${tabInfo.status}`);

    // Check if tab URL is automatable
    if (tabInfo.url) {
      const isAutomatable = !['chrome:', 'edge:', 'devtools:', 'chrome-extension:', 'about:'].some(scheme => tabInfo.url!.startsWith(scheme));
      if (!isAutomatable) {
        throw new Error(`Cannot automate tab with URL: ${tabInfo.url}`);
      }
    }

    debugLog('Attaching debugger to new tab:', this._debuggee);
    try {
      await chrome.debugger.attach(this._debuggee, '1.3');
      await this._enableDomainsForTracking();
      debugLog('Debugger attached successfully');

      // Wait for page and extension iframes to fully load before returning
      // This prevents issues with other extensions (like iCloud Password Manager) that inject iframes
      debugLog('Waiting for page to stabilize...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error: any) {
      // Detect extension blocking errors
      if (error.message && error.message.includes('chrome-extension://')) {
        const extensionInfo = await this._getBlockingExtensionsInfo();
        throw new Error(
          `Browser extension blocking debugging: ${extensionInfo}\n\n` +
          `This page has extensions that inject iframes, preventing automation. ` +
          `Please disable the blocking extension(s) and try again.\n\n` +
          `Original error: ${error.message}`
        );
      }

      // Improve "Another debugger" error message
      if (error.message && error.message.includes('Another debugger')) {
        throw new Error(
          `New tab "${url}" is already attached to another debugger/MCP.\n\n` +
          `This usually means another MCP connection or DevTools is using this tab. Please:\n` +
          `1. Close DevTools if open on this tab\n` +
          `2. Disconnect other MCP clients\n` +
          `3. Try creating a different tab\n\n` +
          `Original error: ${error.message}`
        );
      }
      throw error;
    }

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
    debugLog('_sendMessage called, readyState:', this._ws.readyState, 'messageType:', message.method || 'response');
    if (this._ws.readyState === WebSocket.OPEN) {
      const data = JSON.stringify(message);
      debugLog('Sending message, length:', data.length);

      // Warn about large messages (>2MB might cause WebSocket issues)
      if (data.length > 2 * 1024 * 1024) {
        console.warn(`[Extension] WARNING: Large message (${(data.length / 1024 / 1024).toFixed(2)}MB) may cause WebSocket connection issues. Consider using lower quality screenshots or viewport-only captures.`);
      }

      try {
        this._ws.send(data);
        debugLog('Message sent successfully');
      } catch (error) {
        console.error('[Extension] Failed to send message:', error);
        // Don't close connection on send error - let it be handled by onclose
      }
    } else {
      console.error('[Extension] WebSocket not OPEN, cannot send. State:', this._ws.readyState);
    }
  }
}
