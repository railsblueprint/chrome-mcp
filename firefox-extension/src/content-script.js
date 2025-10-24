// Content script to capture console messages and forward to background
// Listens for console messages from page and sends to extension

window.addEventListener('message', (event) => {
  // Only accept messages from same origin
  if (event.source !== window) return;

  // Check if it's a console message
  if (event.data && event.data.__blueprintConsole) {
    // Forward to background script
    browser.runtime.sendMessage({
      type: 'console_message',
      data: event.data.__blueprintConsole
    }).catch(err => {
      // Ignore errors if background isn't listening
    });
  }
});
