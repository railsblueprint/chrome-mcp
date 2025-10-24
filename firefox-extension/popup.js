// Constants (matching Chrome's config.ts)
const API_HOST = 'https://mcp-for-chrome.railsblueprint.com';
const config = {
  loginUrl: (extensionId) => `${API_HOST}/extension/login?extension_id=${extensionId}`,
  upgradeUrl: (extensionId) => `${API_HOST}/pro?extension_id=${extensionId}`,
  docsUrl: `${API_HOST}/docs`,
  buyMeACoffeeUrl: 'https://www.buymeacoffee.com/mcp.for.chrome',
  defaultMcpPort: '5555',
};

// State
let state = {
  enabled: true,
  currentTabConnected: false,
  stealthMode: null,
  anyConnected: false,
  connecting: false,
  isPro: false,
  userEmail: null,
  browserName: 'Firefox',
  showSettings: false,
  port: '5555',
  connectionStatus: null,
  projectName: null,
  debugMode: false,
  version: '1.0.0',
};

// Utility: Decode JWT (without validation - only for display)
function decodeJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    return payload;
  } catch (e) {
    return null;
  }
}

// Get user info from stored JWT
async function getUserInfoFromStorage() {
  const result = await browser.storage.local.get(['accessToken']);
  if (!result.accessToken) return null;

  const payload = decodeJWT(result.accessToken);
  if (!payload) return null;

  return {
    email: payload.email || payload.sub || null,
    sub: payload.sub,
  };
}

// Get default browser name
function getDefaultBrowserName() {
  return 'Firefox';
}

// Update status
async function updateStatus() {
  // Get current tab
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const currentTab = tabs[0];

  // Get connection status from background
  const response = await browser.runtime.sendMessage({ type: 'getConnectionStatus' });
  const connectedTabId = response?.connectedTabId;
  const isCurrentTabConnected = currentTab?.id === connectedTabId;

  state.anyConnected = response?.connected === true;
  state.currentTabConnected = isCurrentTabConnected;
  state.stealthMode = isCurrentTabConnected ? (response?.stealthMode ?? null) : null;
  state.projectName = response?.projectName || null;

  // Set connecting state: enabled but not connected
  const storage = await browser.storage.local.get(['extensionEnabled']);
  const isEnabled = storage.extensionEnabled !== false;
  state.connecting = isEnabled && response?.connected !== true;

  render();
}

// Load state
async function loadState() {
  const storage = await browser.storage.local.get([
    'extensionEnabled',
    'isPro',
    'browserName',
    'mcpPort',
    'connectionStatus',
    'debugMode'
  ]);

  state.enabled = storage.extensionEnabled !== false;
  state.isPro = storage.isPro === true;
  state.browserName = storage.browserName || getDefaultBrowserName();
  state.port = storage.mcpPort || '5555';
  state.connectionStatus = storage.connectionStatus || null;
  state.debugMode = storage.debugMode || false;

  // Load email from JWT token
  const userInfo = await getUserInfoFromStorage();
  if (userInfo) {
    state.userEmail = userInfo.email;
  }

  // Get version from manifest
  const manifest = browser.runtime.getManifest();
  state.version = manifest.version;

  render();
}

// Toggle enabled
async function toggleEnabled() {
  state.enabled = !state.enabled;
  await browser.storage.local.set({ extensionEnabled: state.enabled });
  render();
}

// Save settings
async function saveSettings() {
  // Always save debug mode
  await browser.storage.local.set({ debugMode: state.debugMode });

  if (state.isPro) {
    // Save browser name for PRO users
    await browser.storage.local.set({ browserName: state.browserName });
  } else {
    // Save port for free users
    await browser.storage.local.set({ mcpPort: state.port });
    // Reload extension to apply new port
    browser.runtime.reload();
  }
  state.showSettings = false;
  render();
}

// Cancel settings
async function cancelSettings() {
  // Reload original values
  const storage = await browser.storage.local.get(['browserName', 'mcpPort', 'debugMode']);
  state.browserName = storage.browserName || getDefaultBrowserName();
  state.port = storage.mcpPort || '5555';
  state.debugMode = storage.debugMode || false;
  state.showSettings = false;
  render();
}

// Handle sign in
function handleSignIn() {
  const extensionId = browser.runtime.id;
  browser.tabs.create({ url: config.loginUrl(extensionId), active: false });
}

// Handle logout
async function handleLogout() {
  await browser.storage.local.remove(['accessToken', 'refreshToken', 'isPro']);
  state.isPro = false;
  state.userEmail = null;
  render();
}

// Render function
function render() {
  try {
    const root = document.getElementById('root');

    if (!root) {
      console.error('[Popup] Root element not found!');
      return;
    }

    if (state.showSettings) {
      root.innerHTML = renderSettings();
    } else {
      root.innerHTML = renderMain();
    }

    attachEventListeners();
  } catch (error) {
    console.error('[Popup] Render error:', error);
    throw error;
  }
}

// Render settings view
function renderSettings() {
  return `
    <div class="popup-container">
      <div class="popup-header">
        <img src="icons/icon-32.png" alt="Blueprint MCP" class="header-icon" />
        <h1>Blueprint MCP<span class="version-label">v${state.version}</span></h1>
      </div>

      <div class="popup-content">
        <div class="settings-form">
          ${state.isPro ? `
            <label class="settings-label">
              Browser Name:
              <input
                type="text"
                class="settings-input"
                id="browserNameInput"
                value="${state.browserName}"
                placeholder="Firefox"
              />
            </label>
          ` : `
            <label class="settings-label">
              MCP Server Port:
              <input
                type="number"
                class="settings-input"
                id="portInput"
                value="${state.port}"
                min="1"
                max="65535"
                placeholder="5555"
              />
            </label>
            <p class="settings-help">
              Default: 5555. Change this if your MCP server runs on a different port.
            </p>
          `}

          <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid #e0e0e0">
            <label class="settings-label" style="display: flex; align-items: center; cursor: pointer; user-select: none">
              <input
                type="checkbox"
                id="debugModeCheckbox"
                ${state.debugMode ? 'checked' : ''}
                style="width: 18px; height: 18px; margin-right: 10px; cursor: pointer"
              />
              <span>Debug Mode</span>
            </label>
            <p class="settings-help" style="margin-top: 8px; margin-left: 28px">
              Enable detailed logging for troubleshooting
            </p>
          </div>
        </div>

        <div class="settings-actions">
          <button class="settings-button save" id="saveButton">
            Save
          </button>
          <button class="settings-button cancel" id="cancelButton">
            Cancel
          </button>
        </div>
      </div>
    </div>
  `;
}

// Render main view
function renderMain() {
  const statusClass = state.connecting ? 'connecting' : state.anyConnected ? 'connected' : 'disconnected';
  const statusText = state.connecting ? 'Connecting' : state.anyConnected ? 'Connected' : 'Disconnected';

  return `
    <div class="popup-container">
      <div class="popup-header">
        <img src="icons/icon-32.png" alt="Blueprint MCP" class="header-icon" />
        <h1>Blueprint MCP<span class="version-label">v${state.version}</span></h1>
      </div>

      <div class="popup-content">
        <div class="status-row">
          <span class="status-label">Status:</span>
          <div class="status-indicator">
            <span class="status-dot ${statusClass}"></span>
            <span class="status-text">${statusText}</span>
          </div>
        </div>

        <div class="status-row">
          <span class="status-label">This tab:</span>
          <span class="status-text">${state.currentTabConnected ? '✓ Automated' : 'Not automated'}</span>
        </div>

        ${state.currentTabConnected && state.projectName ? `
          <div class="status-row">
            <span class="status-label"></span>
            <span class="status-text" style="font-size: 0.9em; color: #666">
              ${state.projectName}
            </span>
          </div>
        ` : ''}

        ${state.currentTabConnected ? `
          <div class="status-row">
            <span class="status-label">Stealth mode:</span>
            <span class="status-text">
              ${state.stealthMode === null ? 'N/A' : state.stealthMode ? '🕵️ On' : '👁️ Off'}
            </span>
          </div>
        ` : ''}

        <div class="toggle-row">
          <button
            class="toggle-button ${state.enabled ? 'enabled' : 'disabled'}"
            id="toggleButton"
          >
            ${state.enabled ? 'Disable' : 'Enable'}
          </button>
        </div>

        ${!state.isPro ? `
          <div class="pro-section">
            <p class="pro-text">Unlock advanced features with PRO</p>
            <button class="pro-button" id="upgradeButton">
              Upgrade to PRO
            </button>
            <div class="signin-text">
              Already have PRO? <button class="signin-link" id="signInButton">Sign in</button>
            </div>
          </div>
        ` : `
          <div class="pro-section pro-active">
            <div>
              <p class="pro-text">✓ PRO Account Active</p>
              ${state.userEmail ? `<p class="pro-email">${state.userEmail}</p>` : ''}
              ${state.connectionStatus ? `
                <div class="connection-status">
                  <p class="connection-limit">
                    Connections: ${state.connectionStatus.connections_used}/${state.connectionStatus.max_connections}
                  </p>
                  <p class="connection-browser">
                    This browser: ${state.connectionStatus.connections_to_this_browser}
                  </p>
                </div>
              ` : ''}
            </div>
            <button class="logout-link" id="logoutButton">
              Logout
            </button>
          </div>
        `}

        <div class="links-section">
          <button class="settings-link" id="settingsButton">
            ⚙️ Settings
          </button>
          <a
            href="${config.docsUrl}"
            target="_blank"
            rel="noopener noreferrer"
            class="doc-link"
          >
            📖 Documentation
          </a>
          <button class="test-page-link" id="testPageButton">
            🧪 Test Page
          </button>
          ${!state.isPro ? `
            <a
              href="${config.buyMeACoffeeUrl}"
              target="_blank"
              rel="noopener noreferrer"
              class="beer-link"
            >
              🍺 Buy me a beer
            </a>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

// Attach event listeners
function attachEventListeners() {
  if (state.showSettings) {
    // Settings view listeners
    const saveButton = document.getElementById('saveButton');
    const cancelButton = document.getElementById('cancelButton');
    const debugModeCheckbox = document.getElementById('debugModeCheckbox');

    if (saveButton) saveButton.addEventListener('click', saveSettings);
    if (cancelButton) cancelButton.addEventListener('click', cancelSettings);

    if (state.isPro) {
      const browserNameInput = document.getElementById('browserNameInput');
      if (browserNameInput) {
        browserNameInput.addEventListener('input', (e) => {
          state.browserName = e.target.value;
        });
      }
    } else {
      const portInput = document.getElementById('portInput');
      if (portInput) {
        portInput.addEventListener('input', (e) => {
          state.port = e.target.value;
        });
      }
    }

    if (debugModeCheckbox) {
      debugModeCheckbox.addEventListener('change', (e) => {
        state.debugMode = e.target.checked;
      });
    }
  } else {
    // Main view listeners
    const toggleButton = document.getElementById('toggleButton');
    const settingsButton = document.getElementById('settingsButton');
    const testPageButton = document.getElementById('testPageButton');
    const upgradeButton = document.getElementById('upgradeButton');
    const signInButton = document.getElementById('signInButton');
    const logoutButton = document.getElementById('logoutButton');

    if (toggleButton) toggleButton.addEventListener('click', toggleEnabled);
    if (settingsButton) {
      settingsButton.addEventListener('click', () => {
        state.showSettings = true;
        render();
      });
    }
    if (testPageButton) {
      testPageButton.addEventListener('click', () => {
        const testPageUrl = browser.runtime.getURL('test.html');
        browser.tabs.create({ url: testPageUrl, active: true });
      });
    }
    if (upgradeButton) {
      upgradeButton.addEventListener('click', () => {
        const extensionId = browser.runtime.id;
        browser.tabs.create({ url: config.upgradeUrl(extensionId), active: false });
      });
    }
    if (signInButton) signInButton.addEventListener('click', handleSignIn);
    if (logoutButton) logoutButton.addEventListener('click', handleLogout);
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  try {
    console.log('[Popup] Initializing...');
    await loadState();
    console.log('[Popup] State loaded:', state);
    await updateStatus();
    console.log('[Popup] Status updated');

    // Listen for status change broadcasts from background script
    browser.runtime.onMessage.addListener((message) => {
      if (message.type === 'statusChanged') {
        updateStatus();
      }
    });

    // Listen for tab changes
    browser.tabs.onActivated.addListener(updateStatus);

    // Listen for storage changes
    browser.storage.onChanged.addListener(async (changes, areaName) => {
      if (areaName === 'local') {
        if (changes.isPro) {
          state.isPro = changes.isPro.newValue === true;
          render();
        }
        if (changes.accessToken) {
          const userInfo = await getUserInfoFromStorage();
          state.userEmail = userInfo?.email || null;
          render();
        }
        if (changes.connectionStatus) {
          state.connectionStatus = changes.connectionStatus.newValue || null;
          render();
        }
      }
    });

    // Listen for visibility changes
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        loadState();
      }
    });

    console.log('[Popup] Initialization complete');
  } catch (error) {
    console.error('[Popup] Initialization error:', error);
    document.getElementById('root').innerHTML = `
      <div class="popup-container">
        <div class="popup-header">
          <h1>Error</h1>
        </div>
        <div class="popup-content">
          <p style="color: red">Failed to initialize popup: ${error.message}</p>
          <p style="font-size: 12px">${error.stack}</p>
        </div>
      </div>
    `;
  }
});
