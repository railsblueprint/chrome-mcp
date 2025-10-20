/**
 * Content script that reads tokens from login page DOM
 */

// Watch for a div with class 'mcp-extension-tokens' containing data attributes
const observer = new MutationObserver(() => {
  // Check for focus request
  const focusElement = document.querySelector('.mcp-extension-focus-tab');
  if (focusElement) {
    console.log('[Content Script] Focus request detected, focusing tab...');
    chrome.runtime.sendMessage({ type: 'focusTab' });
    // Don't disconnect - we still need to watch for tokens
  }

  // Check for tokens
  const tokenElement = document.querySelector('.mcp-extension-tokens');
  if (tokenElement) {
    const accessToken = tokenElement.getAttribute('data-access-token');
    const refreshToken = tokenElement.getAttribute('data-refresh-token');

    if (accessToken && refreshToken) {
      console.log('[Content Script] Found tokens in DOM, sending to background...');

      // Send to background script
      chrome.runtime.sendMessage({
        type: 'loginSuccess',
        accessToken: accessToken,
        refreshToken: refreshToken
      }, (response) => {
        console.log('[Content Script] Response from background:', response);

        // Close the window after successful token save
        setTimeout(() => {
          window.close();
        }, 500);
      });

      // Stop observing
      observer.disconnect();
    }
  }
});

// Start observing the document for changes
observer.observe(document.documentElement, {
  childList: true,
  subtree: true
});

console.log('[Content Script] Ready to watch for login tokens');
