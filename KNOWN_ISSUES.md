# Known Issues

## iCloud Password Manager Compatibility

### Issue
When iCloud Password Manager (or similar password managers that inject chrome-extension:// iframes) is enabled, automation fails on specific websites with the error:

```
Cannot access a chrome-extension:// URL of different extension
```

### Root Cause
Password manager extensions inject `chrome-extension://` iframes into web pages. When Chrome DevTools Protocol (CDP) tries to execute commands like `Runtime.evaluate`, Chrome blocks the request because it detects the presence of another extension's iframe in the page.

### Affected Pages
Testing has confirmed the following pattern:

**FAILS:**
- ✗ google.com (search homepage) - Consistently fails with iCloud Password Manager enabled
- ✗ Likely other Google login/auth pages

**WORKS:**
- ✅ developer.chrome.com (Google developer documentation)
- ✅ example.com
- ✅ Most other websites

### Key Finding
The issue is **page-specific**, not domain-specific. Not all Google properties are affected - only pages where the password manager aggressively injects its UI (like google.com search page).

### Behavior
Once a tab navigates to an affected page (like google.com):
1. All CDP commands fail with the chrome-extension error
2. The tab becomes stuck - subsequent navigation commands also fail
3. The debugger must be disconnected and reconnected to recover
4. Even selecting the tab from an existing session triggers the error

### Workarounds

#### Option 1: Disable Password Manager (Recommended)
Temporarily disable iCloud Password Manager or similar extensions during automation sessions:
1. Open Chrome Extensions (chrome://extensions/)
2. Disable "iCloud Passwords"
3. Run automation
4. Re-enable when done

#### Option 2: Use Separate Chrome Profile
Create a dedicated Chrome profile for automation without password manager extensions:
```bash
chrome-mcp --user-data-dir=/path/to/automation/profile
```

#### Option 3: Avoid Affected Pages
If possible, avoid automating google.com and similar pages where password managers inject UI. Use alternative pages or APIs.

### Technical Details

**What We Tried (All Failed):**
1. ✗ Tracking execution contexts and targeting main page context with `contextId`
2. ✗ Waiting for page load before attaching debugger
3. ✗ Graceful debugger reattach after detach events
4. ✗ Retry loops to get valid execution context
5. ✗ Hardcoded context IDs (1, 3)
6. ✗ Connecting to existing tabs vs creating new tabs

**Chrome's Behavior:**
When a chrome-extension:// iframe is present in the page, Chrome rejects CDP commands regardless of:
- Which execution context you target
- When you attach the debugger (before or after page load)
- Whether you use a new or existing tab

This appears to be a security restriction in Chrome to prevent cross-extension interference.

### Future Improvements

Potential future solutions (not yet implemented):
1. Detect password manager iframes and warn user before attempting commands
2. Automatic detection of affected pages with helpful error messages
3. Integration with Chrome's extension management to temporarily disable conflicting extensions
4. Use Playwright's browser context isolation to avoid extension interference

### Error Messages (v0.1.31+)

Starting from v0.1.31, the extension now provides clear error messages when extension blocking is detected:

```
Browser extension blocking debugging: "iCloud Passwords" (ID: pejdijmoenmkgeppbflobdenhhabjlaj)

This page has extensions that inject iframes, preventing automation.
Please disable the blocking extension(s) and try again.

Original error: Cannot access a chrome-extension:// URL of different extension
```

The error message includes:
- **Extension name** - Human-readable name (e.g., "iCloud Passwords")
- **Extension ID** - Chrome extension identifier for precise identification
- **Clear instructions** - Tells you to disable the blocking extension
- **Original error** - Shows the underlying Chrome error

### Version Info
- First identified: v0.1.29
- Enhanced error messages: v0.1.31
- Last tested: v0.1.31
- Chrome version tested: Latest (October 2025)
- iCloud Password Manager version: Built-in macOS extension
