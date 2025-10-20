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

import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './popup.css';
import { config } from '../config';

const Popup: React.FC = () => {
  const [enabled, setEnabled] = useState<boolean>(true);
  const [currentTabConnected, setCurrentTabConnected] = useState<boolean>(false);
  const [stealthMode, setStealthMode] = useState<boolean | null>(null);
  const [anyConnected, setAnyConnected] = useState<boolean>(false);
  const [connecting, setConnecting] = useState<boolean>(false);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [port, setPort] = useState<string>('5555');
  const [isPro, setIsPro] = useState<boolean>(false);

  const updateStatus = async () => {
    // Get current tab
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Get connection status from background
    chrome.runtime.sendMessage({ type: 'getConnectionStatus' }, (response) => {
      const connectedTabId = response?.connectedTabId;
      const isCurrentTabConnected = currentTab?.id === connectedTabId;

      setAnyConnected(response?.connected === true);
      setCurrentTabConnected(isCurrentTabConnected);
      setStealthMode(isCurrentTabConnected ? (response?.stealthMode ?? null) : null);

      // Set connecting state: enabled but not connected
      chrome.storage.local.get(['extensionEnabled'], (result) => {
        const isEnabled = result.extensionEnabled !== false;
        setConnecting(isEnabled && response?.connected !== true);
      });
    });
  };

  useEffect(() => {
    // Load initial state
    const loadState = () => {
      console.log('[Popup] Loading state from storage...');
      chrome.storage.local.get(['extensionEnabled', 'mcpPort', 'isPro'], (result) => {
        console.log('[Popup] Storage contents:', result);
        setEnabled(result.extensionEnabled !== false); // Default to true
        setPort(result.mcpPort || '5555'); // Default to 5555
        setIsPro(result.isPro === true); // Default to false
        console.log('[Popup] Set isPro to:', result.isPro === true);
      });
    };

    loadState();

    // Get initial status
    updateStatus();

    // Also reload state when popup becomes visible (e.g., after login)
    const visibilityListener = () => {
      if (!document.hidden) {
        loadState();
      }
    };
    document.addEventListener('visibilitychange', visibilityListener);

    // Listen for status change broadcasts from background script
    const messageListener = (message: any) => {
      if (message.type === 'statusChanged') {
        updateStatus();
      }
    };
    chrome.runtime.onMessage.addListener(messageListener);

    // Also listen for tab changes (user switches tabs)
    const tabListener = () => {
      updateStatus();
    };
    chrome.tabs.onActivated.addListener(tabListener);

    // Listen for storage changes (e.g., login completion)
    const storageListener = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName === 'local' && changes.isPro) {
        setIsPro(changes.isPro.newValue === true);
      }
    };
    chrome.storage.onChanged.addListener(storageListener);

    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
      chrome.tabs.onActivated.removeListener(tabListener);
      chrome.storage.onChanged.removeListener(storageListener);
      document.removeEventListener('visibilitychange', visibilityListener);
    };
  }, []);

  const toggleEnabled = async () => {
    const newEnabled = !enabled;
    setEnabled(newEnabled);
    await chrome.storage.local.set({ extensionEnabled: newEnabled });
  };

  const saveSettings = async () => {
    await chrome.storage.local.set({ mcpPort: port });
    setShowSettings(false);
    // Reload extension to apply new port
    chrome.runtime.reload();
  };

  const cancelSettings = () => {
    // Reload original port value
    chrome.storage.local.get(['mcpPort'], (result) => {
      setPort(result.mcpPort || '5555');
    });
    setShowSettings(false);
  };

  const handleSignIn = () => {
    const extensionId = chrome.runtime.id;
    chrome.tabs.create({ url: config.loginUrl(extensionId), active: false });
  };

  const handleLogout = () => {
    chrome.storage.local.remove(['accessToken', 'refreshToken', 'isPro'], () => {
      setIsPro(false);
    });
  };

  if (showSettings) {
    return (
      <div className="popup-container">
        <div className="popup-header">
          <button className="back-button" onClick={cancelSettings}>← Back</button>
          <h1>Settings</h1>
        </div>

        <div className="popup-content">
          <div className="settings-form">
            <label className="settings-label">
              MCP Server Port:
              <input
                type="number"
                className="settings-input"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                min="1"
                max="65535"
                placeholder="5555"
              />
            </label>
            <p className="settings-help">
              Default: 5555. Change this if your MCP server runs on a different port.
            </p>
          </div>

          <div className="settings-actions">
            <button className="settings-button save" onClick={saveSettings}>
              Save
            </button>
            <button className="settings-button cancel" onClick={cancelSettings}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="popup-container">
      <div className="popup-header">
        <h1>Blueprint MCP</h1>
      </div>

      <div className="popup-content">
        <div className="status-row">
          <span className="status-label">Status:</span>
          <div className="status-indicator">
            <span className={`status-dot ${connecting ? 'connecting' : anyConnected ? 'connected' : 'disconnected'}`}></span>
            <span className="status-text">
              {connecting ? 'Connecting' : anyConnected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>

        <div className="status-row">
          <span className="status-label">This tab:</span>
          <span className="status-text">{currentTabConnected ? '✓ Automated' : 'Not automated'}</span>
        </div>

        {currentTabConnected && (
          <div className="status-row">
            <span className="status-label">Stealth mode:</span>
            <span className="status-text">
              {stealthMode === null ? 'N/A' : stealthMode ? '🕵️ On' : '👁️ Off'}
            </span>
          </div>
        )}

        <div className="toggle-row">
          <button
            className={`toggle-button ${enabled ? 'enabled' : 'disabled'}`}
            onClick={toggleEnabled}
          >
            {enabled ? 'Disable' : 'Enable'}
          </button>
        </div>

        {!isPro && (
          <div className="pro-section">
            <p className="pro-text">Unlock advanced features with PRO</p>
            <button
              className="pro-button"
              onClick={() => {
                const extensionId = chrome.runtime.id;
                chrome.tabs.create({ url: config.upgradeUrl(extensionId), active: false });
              }}
            >
              Upgrade to PRO
            </button>
            <div className="signin-text">
              Already have PRO? <button className="signin-link" onClick={handleSignIn}>Sign in</button>
            </div>
          </div>
        )}

        {isPro && (
          <div className="pro-section pro-active">
            <p className="pro-text">✓ PRO Account Active</p>
            <button className="logout-link" onClick={handleLogout}>
              Logout
            </button>
          </div>
        )}

        <div className="links-section">
          <button
            className="settings-link"
            onClick={() => setShowSettings(true)}
          >
            ⚙️ Settings
          </button>
          <a
            href={config.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="doc-link"
          >
            📖 Documentation
          </a>
          {!isPro && (
            <a
              href={config.buyMeACoffeeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="beer-link"
            >
              🍺 Buy me a beer
            </a>
          )}
        </div>
      </div>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<Popup />);
