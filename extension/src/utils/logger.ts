/**
 * Logging utility with debug mode support
 */

let debugMode = false;

// Initialize debug mode from storage
chrome.storage.local.get(['debugMode'], (result) => {
  debugMode = result.debugMode || false;
});

// Listen for debug mode changes
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.debugMode) {
    debugMode = changes.debugMode.newValue || false;
  }
});

/**
 * Log a message (always shown, even in basic mode)
 */
export function log(message: string, ...args: any[]): void {
  console.log(`[Extension] ${message}`, ...args);
}

/**
 * Log a debug message (only shown in debug mode)
 */
export function debug(message: string, ...args: any[]): void {
  if (debugMode) {
    console.log(`[Extension] ${message}`, ...args);
  }
}

/**
 * Log an error (always shown)
 */
export function error(message: string, ...args: any[]): void {
  console.error(`[Extension] ERROR: ${message}`, ...args);
}

/**
 * Check if debug mode is enabled
 */
export function isDebugMode(): boolean {
  return debugMode;
}
