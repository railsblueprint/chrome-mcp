// Blueprint MCP Firefox Extension Popup Script - matching Chrome design

// Update status on load
updateStatus();

// Update status every 2 seconds
setInterval(updateStatus, 2000);

// Handle test page button
document.getElementById('testPageButton').addEventListener('click', () => {
  browser.tabs.create({ url: browser.runtime.getURL('test.html') });
});

async function updateStatus() {
  try {
    // Get current tab
    const [currentTab] = await browser.tabs.query({ active: true, currentWindow: true });

    // Get connection status from background script
    const response = await browser.runtime.sendMessage({ type: 'getStatus' });

    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const thisTabText = document.getElementById('thisTabText');
    const projectRow = document.getElementById('projectRow');
    const projectName = document.getElementById('projectName');

    // Update connection status with dot
    if (response && response.connected) {
      statusDot.className = 'status-dot connected';
      statusText.textContent = 'Connected';

      // Check if current tab is automated
      const isCurrentTabAutomated = response.attachedTab && response.attachedTab.id === currentTab.id;

      if (isCurrentTabAutomated) {
        thisTabText.textContent = '✓ Automated';

        // Show project name if available
        if (response.projectName) {
          projectRow.style.display = 'flex';
          projectName.textContent = response.projectName;
        } else {
          projectRow.style.display = 'none';
        }
      } else {
        thisTabText.textContent = 'Not automated';
        projectRow.style.display = 'none';
      }
    } else {
      statusDot.className = 'status-dot disconnected';
      statusText.textContent = 'Disconnected';
      thisTabText.textContent = 'Not automated';
      projectRow.style.display = 'none';
    }
  } catch (error) {
    console.error('[Firefox MCP Popup] Error updating status:', error);
  }
}
