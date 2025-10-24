# Firefox Extension Test Results

**Date:** 2025-10-24
**Version:** Firefox Extension MVP
**Test Focus:** Newly implemented features for Firefox parity
**Test Page:** http://localhost:8888/test.html

## Test Environment
- Firefox Extension: Unpacked extension from `firefox-extension/`
- Test Server: Running on localhost:8888
- Features Tested: Network requests, PDF save, Performance metrics, Content extraction, Dialog handling

---

## 1. Basic Connectivity ✓

### Test 1.1: Extension Load
**Procedure:**
1. Load unpacked extension from `firefox-extension/` in Firefox
2. Verify manifest loads without errors
3. Check background script initializes

**Expected:**
- Extension loads successfully
- No console errors
- Extension icon appears in toolbar

**Status:** READY TO TEST
**Notes:** Extension uses Manifest V2, Firefox-specific APIs

---

## 2. Network Request Tracking (NEW FEATURE)

### Test 2.1: Capture Page Load Requests
**Command:**
```json
// After navigating to test page
{
  "method": "getNetworkRequests"
}
```

**Expected Results:**
- Returns array of network requests
- Includes:
  - test.html (document, 200)
  - test.js (script, 200)
- Each request has:
  - requestId (string)
  - url, method, type
  - statusCode, statusText
  - requestHeaders, responseHeaders
  - timestamp

**What to Verify:**
- webRequest API correctly tracks all requests
- Request correlation works (onBeforeRequest → onCompleted → onBeforeSendHeaders)
- Headers captured for both request and response
- Stores last 500 requests (test with many requests)

### Test 2.2: Clear Network Tracking
**Command:**
```json
{
  "method": "clearTracking"
}
```

**Expected:**
- Network requests array cleared
- Returns success: true
- Subsequent getNetworkRequests returns empty array

**Status:** READY TO TEST
**Implementation:** firefox-extension/src/background.js:16-76 (listeners), 259-264 (handlers)

---

## 3. PDF Save (ERROR HANDLING)

### Test 3.1: Attempt PDF Save
**Command:**
```json
{
  "method": "Page.printToPDF",
  "params": {}
}
```

**Expected Result:**
- Returns helpful error message:
  ```
  "PDF generation not supported in Firefox extension - use browser's native print (Ctrl/Cmd+P) instead"
  ```
- Does not crash or hang
- Clearly explains limitation

**What to Verify:**
- Error message is user-friendly
- Suggests native print dialog as alternative
- Does not attempt unsupported operation

**Status:** READY TO TEST
**Implementation:** firefox-extension/src/background.js:566-569

---

## 4. Performance Metrics (NEW FEATURE)

### Test 4.1: Collect Web Vitals
**Setup:** Navigate to test page (http://localhost:8888/test.html)

**Command:**
```json
{
  "method": "Performance.getMetrics",
  "params": {}
}
```

**Expected Result:**
- Returns: `{ metrics: [] }`
- Empty array is correct (actual data comes from Runtime.evaluate)

**Verification:**
- Check that unifiedBackend.js calls Runtime.evaluate separately
- Verify JavaScript returns timing data from Navigation Timing API
- Confirm metrics include:
  - domContentLoaded
  - loadComplete
  - domInteractive
  - fcp (First Contentful Paint)
  - lcp (Largest Contentful Paint)
  - cls (Cumulative Layout Shift)
  - ttfb (Time to First Byte)

**Status:** READY TO TEST
**Implementation:** firefox-extension/src/background.js:667-671

---

## 5. Content Extraction (VERIFICATION)

### Test 5.1: Extract Test Page Content
**Command:**
```json
{
  "method": "Runtime.evaluate",
  "params": {
    "expression": "document.title"
  }
}
```

**Expected Result:**
- Returns: "Browser Interaction Test Page"
- Uses existing Runtime.evaluate implementation

### Test 5.2: Auto-detect Mode
**Expected:**
- browser_extract_content uses Runtime.evaluate
- Extracts main content as markdown
- No Firefox-specific changes needed

**What to Verify:**
- Runtime.evaluate works correctly (already implemented)
- Content extraction script runs without errors
- Markdown formatting correct

**Status:** VERIFIED
**Implementation:** Uses existing Runtime.evaluate at background.js:583-604

---

## 6. Dialog Auto-Handling (CRITICAL)

### Test 6.1: Alert Auto-Handling
**Setup:** Tab attached with dialog overrides installed

**Command (via content script):**
```javascript
alert('Test alert message');
```

**Expected Behavior:**
1. Alert auto-handled (doesn't block)
2. Logged to window.__blueprintDialogEvents
3. Console shows: "[Blueprint MCP] Auto-handled alert: Test alert message"

### Test 6.2: Confirm Auto-Handling
**Command:**
```javascript
const result = confirm('Are you sure?');
console.log('Confirm returned:', result);
```

**Expected:**
- Returns true (accept=true by default)
- Event logged with response
- No browser dialog shown

### Test 6.3: Prompt Auto-Handling
**Command:**
```javascript
const result = prompt('Enter name:');
console.log('Prompt returned:', result);
```

**Expected:**
- Returns empty string (accept=true, promptText='')
- Event logged with response
- No browser dialog shown

### Test 6.4: Dialog Events Retrieval
**Command:**
```json
{
  "method": "Runtime.getDialogEvents",
  "params": {}
}
```

**Expected:**
- Returns array of dialog events
- Each event has: type, message, response, timestamp
- Events cleared after retrieval

### Test 6.5: Dialog Override Persistence
**Procedure:**
1. Attach to tab (dialog overrides installed)
2. Trigger alert - auto-handled ✓
3. Navigate to different page
4. Trigger alert again

**Expected:**
- Second alert also auto-handled
- Dialog overrides re-injected on navigation
- webNavigation.onCompleted listener fired

**What to Verify:**
- setupDialogOverrides() called on tab attach
- setupDialogOverrides() called on navigation (onCompleted listener)
- Overrides persist across page loads
- window.__blueprintDialogResponse always set

**Status:** READY TO TEST
**Implementation:**
- Setup function: background.js:78-165
- Tab attach: background.js:343, 384
- Navigation listener: background.js:891-899

---

## 7. Core Interactions (SANITY CHECK)

### Test 7.1: Type Text
**Command:**
```json
{
  "method": "Input.insertText",
  "params": {
    "text": "test input"
  }
}
```

**Expected:**
- Text appears in focused field
- Input events fired
- Value updated

### Test 7.2: Click Element
**Command:**
```json
{
  "method": "Input.dispatchMouseEvent",
  "params": {
    "type": "mousePressed",
    "x": 100,
    "y": 100,
    "button": "left",
    "clickCount": 1
  }
}
```

**Expected:**
- Click event fired at coordinates
- Element at location receives click

### Test 7.3: Select Option
**Command:**
```json
{
  "method": "selectOption",
  "params": {
    "selector": "#country",
    "value": "uk"
  }
}
```

**Expected:**
- Dropdown value changes to "uk"
- Change event fired

**Status:** READY TO TEST
**Implementation:** Existing CDP command handlers

---

## 8. Visual Capture (SANITY CHECK)

### Test 8.1: Take Screenshot
**Command:**
```json
{
  "method": "Page.captureScreenshot",
  "params": {
    "format": "jpeg",
    "quality": 80
  }
}
```

**Expected:**
- Returns base64 image data
- JPEG format, quality 80
- Captures current viewport

### Test 8.2: Get DOM Snapshot
**Command:**
```json
{
  "method": "Accessibility.getFullAXTree",
  "params": {}
}
```

**Expected:**
- Returns formatted accessibility tree
- Includes all visible elements
- Shows roles, labels, values
- Selector hints for inputs

**Status:** READY TO TEST
**Implementation:** Existing implementations

---

## Test Execution Checklist

### Firefox New Features
- [ ] Test 2.1: Network requests capture
- [ ] Test 2.2: Clear network tracking
- [ ] Test 3.1: PDF save error handling
- [ ] Test 4.1: Performance metrics
- [ ] Test 5.1: Content extraction (Runtime.evaluate)
- [ ] Test 6.1: Alert auto-handling
- [ ] Test 6.2: Confirm auto-handling
- [ ] Test 6.3: Prompt auto-handling
- [ ] Test 6.4: Dialog events retrieval
- [ ] Test 6.5: Dialog persistence across navigation

### Firefox Existing Features (Sanity)
- [ ] Test 7.1: Type text
- [ ] Test 7.2: Click element
- [ ] Test 7.3: Select option
- [ ] Test 8.1: Screenshot
- [ ] Test 8.2: DOM snapshot

---

## Chrome Dialog Auto-Handling

### Test 9.1: Chrome Dialog Override Installation
**Setup:** Load Chrome extension, attach to tab

**What to Verify:**
1. _setupDialogOverrides() called after debugger attach
2. Dialog overrides injected via Runtime.evaluate
3. window.__blueprintDialogResponse set

### Test 9.2: Chrome Dialog Persistence
**Procedure:**
1. Attach to tab
2. Trigger alert - should auto-handle
3. Navigate to new page
4. Trigger alert again

**Expected:**
- Both alerts auto-handled
- Page.frameNavigated event triggers re-injection
- Overrides persist across navigation

**Status:** READY TO TEST
**Implementation:** extension/src/relayConnection.ts:222-314 (method), 1428, 1525 (attach), 461-465 (navigation)

---

## Known Limitations

### Firefox
1. **PDF Generation:** Not supported by Firefox WebExtensions API
   - Workaround: Direct users to native print dialog (Ctrl/Cmd+P)

2. **Performance.getMetrics:** No direct CDP equivalent
   - Implementation: Returns empty array, data comes from Runtime.evaluate

3. **Manifest V2:** Firefox uses older manifest version
   - Chrome uses Manifest V3
   - Different permission model

### Both Extensions
1. **Dialog Handling:** Requires JavaScript injection
   - Cannot handle browser-level dialogs (HTTP auth, beforeunload)
   - Only handles JavaScript alert/confirm/prompt

---

## Test Report Summary

**Status:** READY FOR MANUAL TESTING

### Implementation Complete
✅ Firefox network request tracking (webRequest API)
✅ Firefox PDF save error handling
✅ Firefox performance metrics (empty return + Runtime.evaluate)
✅ Firefox content extraction (verified uses Runtime.evaluate)
✅ Firefox dialog auto-handling with persistence
✅ Chrome dialog auto-handling with persistence

### Next Steps
1. Load Firefox extension in browser
2. Connect to MCP server
3. Execute test commands manually
4. Document actual results
5. Compare with expected results
6. Report any discrepancies

### Test Execution Script
A manual test script is needed to:
1. Start MCP server: `node cli.js --debug`
2. Load Firefox extension
3. Connect extension to MCP
4. Navigate to test page: http://localhost:8888/test.html
5. Run test commands through MCP client
6. Verify responses match expected results
7. Document any failures or unexpected behavior

---

## Automated Test Script (Future Enhancement)

```javascript
// Example automated test structure
const testSuite = {
  async testNetworkRequests() {
    // Navigate to test page
    await browser_navigate({ action: 'url', url: 'http://localhost:8888/test.html' });

    // Get network requests
    const result = await transport.sendCommand('getNetworkRequests', {});

    // Verify
    assert(result.length > 0, 'Should capture at least 1 request');
    assert(result.some(r => r.url.includes('test.html')), 'Should include test.html');
  },

  async testDialogHandling() {
    // Setup dialog override
    await transport.sendCommand('forwardCDPCommand', {
      method: 'Runtime.evaluate',
      params: { expression: 'alert("test")' }
    });

    // Get dialog events
    const events = await transport.sendCommand('forwardCDPCommand', {
      method: 'Runtime.getDialogEvents',
      params: {}
    });

    // Verify
    assert(events.length === 1, 'Should have 1 dialog event');
    assert(events[0].type === 'alert', 'Should be alert type');
  }
};
```

---

## Manual Testing Instructions

### Prerequisites
1. Firefox browser installed
2. MCP server code available
3. Test server running on port 8888

### Step-by-Step Testing

**Step 1: Load Firefox Extension**
1. Open Firefox
2. Navigate to `about:debugging#/runtime/this-firefox`
3. Click "Load Temporary Add-on"
4. Select `firefox-extension/manifest.json`
5. Verify extension loaded without errors

**Step 2: Start MCP Server**
```bash
cd /Users/elik/Documents/work/railsblueprint/chrome-mcp
node cli.js --debug
```

**Step 3: Open Test Page**
1. In Firefox, navigate to: http://localhost:8888/test.html
2. Verify page loads correctly
3. Check browser console for any errors

**Step 4: Connect to MCP**
1. Use MCP client to send connection request
2. Verify WebSocket connection established
3. Check server logs for connection confirmation

**Step 5: Execute Test Commands**
Run each test command from this document and verify results match expected output.

**Step 6: Document Results**
For each test:
- ✅ PASS - Works as expected
- ❌ FAIL - Does not work, document error
- ⚠️ PARTIAL - Works with limitations, document
- ⏭️ SKIP - Could not test, document reason
