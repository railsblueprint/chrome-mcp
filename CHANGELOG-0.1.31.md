# Version 0.1.31 - Enhanced Extension Blocking Detection

## Release Date
October 22, 2025

## Summary
This release adds enhanced error detection and reporting when browser extensions (like password managers) block debugging functionality.

## New Features

### Clear Extension Blocking Error Messages
When a browser extension blocks debugging (like iCloud Password Manager), the extension now provides a clear, actionable error message instead of the cryptic Chrome error.

**Before (v0.1.30):**
```
Cannot access a chrome-extension:// URL of different extension
```

**After (v0.1.31):**
```
Browser extension blocking debugging: "iCloud Passwords" (ID: pejdijmoenmkgeppbflobdenhhabjlaj)

This page has extensions that inject iframes, preventing automation.
Please disable the blocking extension(s) and try again.

Original error: Cannot access a chrome-extension:// URL of different extension
```

### Technical Implementation

1. **Extension Context Tracking**
   - Added `_extensionContexts` Map to track which extensions have execution contexts in the page
   - Extracts extension ID from `chrome-extension://` URLs
   - Maintains mapping of extension ID → context IDs

2. **Enhanced Error Handling**
   - Wrapped CDP command execution in try-catch
   - Detects chrome-extension blocking errors
   - Looks up extension names using `chrome.management.get()`
   - Builds user-friendly error message with extension name and ID

3. **Context Lifecycle Management**
   - Tracks `Runtime.executionContextCreated` events for extension contexts
   - Cleans up on `Runtime.executionContextDestroyed`
   - Clears all extension contexts on `Runtime.executionContextsCleared`

## Files Changed

### `/Users/elik/Documents/work/railsblueprint/chrome-mcp/extension/src/relayConnection.ts`
- Added `_extensionContexts` field to track extension execution contexts
- Modified `Runtime.executionContextCreated` handler to extract and track extension IDs
- Modified context destruction handlers to clean up extension context tracking
- Wrapped `forwardCDPCommand` in try-catch with extension detection
- Added `_getBlockingExtensionsInfo()` helper method to fetch extension names

### `/Users/elik/Documents/work/railsblueprint/chrome-mcp/extension/manifest.json`
- Bumped version from 1.0.0 to 1.0.1

### `/Users/elik/Documents/work/railsblueprint/chrome-mcp/package.json`
- Bumped version from 0.1.30 to 0.1.31

### `/Users/elik/Documents/work/railsblueprint/chrome-mcp/KNOWN_ISSUES.md`
- Added "Error Messages (v0.1.31+)" section documenting the new error format
- Updated version info to reflect v0.1.31 changes

## Benefits

1. **User Experience**
   - Users immediately understand what's blocking automation
   - Clear extension name and ID helps identify the problematic extension
   - Actionable instructions tell users exactly what to do

2. **Debugging**
   - Extension ID allows precise identification even if name lookup fails
   - Original error preserved for technical troubleshooting
   - Logs show which extensions are present on the page

3. **Support**
   - Reduces confusion when automation fails on certain pages
   - Provides context for support requests
   - Helps users self-diagnose extension conflicts

## Known Limitations

- The error only shows extensions that have created execution contexts
- If `chrome.management.get()` fails, only extension ID is shown
- Detection happens after the error occurs, not proactively

## Testing

To test the new error messages:
1. Enable iCloud Password Manager extension
2. Navigate to google.com
3. Try to take a snapshot or interact with the page
4. Observe the clear error message with extension name and ID

## Backward Compatibility

This change is fully backward compatible:
- Only affects error message format
- No changes to API or functionality
- No changes to successful automation flows

## Future Improvements

Potential enhancements for future versions:
1. Proactive detection: Warn before attempting commands on affected pages
2. Auto-disable: Option to temporarily disable blocking extensions
3. Compatibility check: Test page compatibility before automation
4. Extension whitelist: Allow users to mark known-safe extensions
