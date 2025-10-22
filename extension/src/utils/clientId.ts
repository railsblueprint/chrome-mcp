/**
 * Copyright (c) 404 Software Labs.
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

/**
 * Generate a stable client ID for this browser instance.
 * The ID is persisted in chrome.storage.local and will be reused across extension reloads.
 * This enables rolling updates without connection re-negotiation.
 */
export async function getStableClientId(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['stableClientId'], (result) => {
      if (result.stableClientId) {
        // Existing stable ID found
        console.log('[ClientID] Using existing stable client ID:', result.stableClientId);
        resolve(result.stableClientId);
      } else {
        // Generate new stable ID
        const clientId = `chrome-${crypto.randomUUID()}`;
        console.log('[ClientID] Generated new stable client ID:', clientId);

        // Persist for future use
        chrome.storage.local.set({ stableClientId: clientId }, () => {
          resolve(clientId);
        });
      }
    });
  });
}

/**
 * Store the extension ID received from the server after authentication.
 * This is the server's assigned ID for this browser instance.
 */
export async function storeExtensionId(extensionId: string): Promise<void> {
  return new Promise((resolve) => {
    console.log('[ClientID] Storing extension ID from server:', extensionId);
    chrome.storage.local.set({ serverExtensionId: extensionId }, () => {
      resolve();
    });
  });
}

/**
 * Get the extension ID assigned by the server.
 */
export async function getExtensionId(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['serverExtensionId'], (result) => {
      resolve(result.serverExtensionId || null);
    });
  });
}
