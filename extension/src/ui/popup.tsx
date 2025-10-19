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

const Popup: React.FC = () => {
  const [enabled, setEnabled] = useState<boolean>(true);
  const [currentTabConnected, setCurrentTabConnected] = useState<boolean>(false);
  const [stealthMode, setStealthMode] = useState<boolean | null>(null);
  const [anyConnected, setAnyConnected] = useState<boolean>(false);
  const [connecting, setConnecting] = useState<boolean>(false);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [port, setPort] = useState<string>('5555');

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
    chrome.storage.local.get(['extensionEnabled', 'mcpPort'], (result) => {
      setEnabled(result.extensionEnabled !== false); // Default to true
      setPort(result.mcpPort || '5555'); // Default to 5555
    });

    // Get initial status
    updateStatus();

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

    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
      chrome.tabs.onActivated.removeListener(tabListener);
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

        <div className="links-section">
          <button
            className="settings-link"
            onClick={() => setShowSettings(true)}
          >
            ⚙️ Settings
          </button>
          <a
            href="http://mcp-for-chrome.railsblueprint.com/docs"
            target="_blank"
            rel="noopener noreferrer"
            className="doc-link"
          >
            📖 Documentation
          </a>
          <a
            href="https://www.buymeacoffee.com/mcp.for.chrome"
            target="_blank"
            rel="noopener noreferrer"
            className="beer-link"
          >
            🍺 Buy me a beer
          </a>
        </div>
      </div>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<Popup />);
