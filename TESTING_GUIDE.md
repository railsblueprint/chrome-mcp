# Chrome MCP Testing Guide

This document provides comprehensive testing procedures for all available MCP tools.

**Test Environment:**
- Use the extension's test page for consistent results: `chrome-extension://[extension-id]/test-interactions.html`
- To open test page: Click extension icon → "Open Test Page"
- Alternative: Use the MCP `browser_navigate` tool with `action: test_page`

## Table of Contents

1. [Setup & Connection](#1-setup--connection)
2. [Tab Management](#2-tab-management)
3. [Navigation](#3-navigation)
4. [Interactions](#4-interactions)
5. [DOM & Snapshot](#5-dom--snapshot)
6. [Visual Capture](#6-visual-capture)
7. [JavaScript Execution](#7-javascript-execution)
8. [Forms](#8-forms)
9. [Mouse Operations](#9-mouse-operations)
10. [Window Management](#10-window-management)
11. [Verification](#11-verification)
12. [Network Monitoring](#12-network-monitoring)
13. [PDF Export](#13-pdf-export)
14. [Dialog Handling](#14-dialog-handling)
15. [Extension Management](#15-extension-management)
16. [Performance Metrics](#16-performance-metrics)
17. [Content Extraction](#17-content-extraction)

---

## 1. Setup & Connection

### Prerequisites
- Chrome MCP extension installed and enabled
- MCP server running
- Chrome browser open

### Initial Connection Test

**Procedure:**
1. Click the Chrome MCP extension icon
2. Click "Connect" button
3. Verify connection status shows "Connected"
4. Check console for WebSocket connection confirmation

**Expected Result:**
- Extension popup shows green "Connected" indicator
- MCP client can now send commands
- WebSocket connection established on configured port

---

## 2. Tab Management

### Tool: `browser_tabs`

#### Test 2.1: List All Tabs

**Command:**
```json
{
  "action": "list"
}
```

**Expected Result:**
- Returns list of all open tabs grouped by window
- Each tab shows: index, title, URL, active status
- Chrome extension tabs marked as "NOT AUTOMATABLE"

#### Test 2.2: Create New Tab

**Command:**
```json
{
  "action": "new",
  "url": "https://example.com",
  "activate": true
}
```

**Expected Result:**
- New tab opens with example.com loaded
- Tab is activated (brought to foreground)
- Returns tab details including index

**Variations to Test:**
- `activate: false` - tab opens in background
- `stealth: true` - stealth mode enabled

#### Test 2.3: Attach to Existing Tab

**Command:**
```json
{
  "action": "attach",
  "index": 0
}
```

**Expected Result:**
- Specified tab becomes active for automation
- Tab brought to foreground
- Returns attached tab details
- Extension can now send commands to this tab

#### Test 2.4: Close Tab

**Command:**
```json
{
  "action": "close",
  "index": 1
}
```

**Expected Result:**
- Specified tab closes
- Remaining tabs re-indexed
- Returns success confirmation

---

## 3. Navigation

### Tool: `browser_navigate`

#### Test 3.1: Navigate to URL

**Command:**
```json
{
  "action": "url",
  "url": "https://example.com"
}
```

**Expected Result:**
- Current tab navigates to specified URL
- Page loads completely
- Returns navigation success

#### Test 3.2: Navigate Back

**Setup:** Navigate to example.com, then to another page

**Command:**
```json
{
  "action": "back"
}
```

**Expected Result:**
- Browser navigates to previous page
- History stack maintained

#### Test 3.3: Navigate Forward

**Setup:** Navigate back first

**Command:**
```json
{
  "action": "forward"
}
```

**Expected Result:**
- Browser navigates forward in history
- Returns to page before "back" command

#### Test 3.4: Reload Page

**Command:**
```json
{
  "action": "reload"
}
```

**Expected Result:**
- Current page reloads
- Fresh page load (not from cache)

#### Test 3.5: Open Test Page

**Command:**
```json
{
  "action": "test_page"
}
```

**Expected Result:**
- New window opens with test-interactions.html
- Test page fully loaded with all sections
- Window positioned and sized appropriately

---

## 4. Interactions

### Tool: `browser_interact`

**Setup:** Navigate to test page using `browser_navigate` with `action: test_page`

#### Test 4.1: Clear and Type Text

**Command:**
```json
{
  "actions": [
    {
      "type": "clear",
      "selector": "#username"
    },
    {
      "type": "type",
      "selector": "#username",
      "text": "testuser123"
    }
  ]
}
```

**Expected Result:**
- Field cleared first (if had previous value)
- Text "testuser123" appears in username field
- Field has focus
- Type action returns final field value: `(final value: "testuser123")`
- Event log shows clear and input events

**Note:** The `clear` action empties an input field by setting value to empty string and triggering change events. The `type` action now returns the final field value for verification.

#### Test 4.2: Press Key

**Command:**
```json
{
  "actions": [
    {
      "type": "type",
      "selector": "#username",
      "text": "test"
    },
    {
      "type": "press_key",
      "key": "Enter"
    }
  ]
}
```

**Expected Result:**
- Text typed in username field
- Enter key triggers form behavior
- Event log shows keypress event

**Keys to test:**
- `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`
- `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`

#### Test 4.3: Click Element

**Command:**
```json
{
  "actions": [
    {
      "type": "click",
      "selector": "#click-target-1"
    }
  ]
}
```

**Expected Result:**
- Click area changes appearance (scale effect)
- Event log shows click event on "Click Me #1"
- Click counter increments

**Click Variations:**
```json
{
  "type": "click",
  "selector": "#click-target-1",
  "button": "right",
  "clickCount": 2
}
```
- Test: left, right, middle buttons
- Test: single click, double click (clickCount: 2)

#### Test 4.4: Hover Element

**Command:**
```json
{
  "actions": [
    {
      "type": "hover",
      "selector": "#hover-target"
    }
  ]
}
```

**Expected Result:**
- Hover area changes color to blue
- Text color changes to white
- CSS hover state applied

#### Test 4.5: Wait

**Command:**
```json
{
  "actions": [
    {
      "type": "click",
      "selector": "#delayed-show"
    },
    {
      "type": "wait",
      "timeout": 2500
    }
  ]
}
```

**Expected Result:**
- Button clicked
- Wait pauses execution for 2.5 seconds
- Delayed element becomes visible after wait

#### Test 4.6: Mouse Move to Coordinates

**Command:**
```json
{
  "actions": [
    {
      "type": "mouse_move",
      "x": 100,
      "y": 150
    }
  ]
}
```

**Expected Result:**
- Mouse cursor moves to specified coordinates
- Coordinate display updates on test page
- Event log shows mouse position

#### Test 4.7: Mouse Click at Coordinates

**Command:**
```json
{
  "actions": [
    {
      "type": "mouse_click",
      "x": 250,
      "y": 200,
      "button": "left"
    }
  ]
}
```

**Expected Result:**
- Mouse clicks at exact coordinates
- Element at those coordinates receives click
- Event log shows click coordinates

#### Test 4.8: Scroll to Coordinates

**Command:**
```json
{
  "actions": [
    {
      "type": "scroll_to",
      "x": 0,
      "y": 500
    }
  ]
}
```

**Expected Result:**
- Page scrolls to Y position 500
- Scroll position updated

#### Test 4.9: Scroll by Offset

**Command:**
```json
{
  "actions": [
    {
      "type": "scroll_by",
      "x": 0,
      "y": 200
    }
  ]
}
```

**Expected Result:**
- Page scrolls down by 200 pixels from current position
- Relative scroll performed

#### Test 4.10: Scroll Element into View

**Command:**
```json
{
  "actions": [
    {
      "type": "scroll_into_view",
      "selector": "#event-log"
    }
  ]
}
```

**Expected Result:**
- Event log section scrolls into viewport
- Element fully visible

#### Test 4.11: Select Option

**Command:**
```json
{
  "actions": [
    {
      "type": "select_option",
      "selector": "#country",
      "value": "uk"
    }
  ]
}
```

**Expected Result:**
- Country dropdown shows "United Kingdom"
- Select element value is "uk"
- Event log shows selection change

#### Test 4.12: File Upload (Single File)

**Setup:** Create a test file at `/tmp/test-avatar.png`

**Command:**
```json
{
  "actions": [
    {
      "type": "file_upload",
      "selector": "#avatar",
      "files": ["/tmp/test-avatar.png"]
    }
  ]
}
```

**Expected Result:**
- File input shows selected file name
- File ready for upload
- Event log shows file selection

#### Test 4.13: File Upload (Multiple Files)

**Setup:** Create test files at `/tmp/doc1.pdf` and `/tmp/doc2.pdf`

**Command:**
```json
{
  "actions": [
    {
      "type": "file_upload",
      "selector": "#documents",
      "files": ["/tmp/doc1.pdf", "/tmp/doc2.pdf"]
    }
  ]
}
```

**Expected Result:**
- File input shows "2 files selected"
- Both files ready for upload
- Event log shows multiple file selection

#### Test 4.14: Complex Interaction Sequence

**Command:**
```json
{
  "actions": [
    {
      "type": "type",
      "selector": "#username",
      "text": "johndoe"
    },
    {
      "type": "type",
      "selector": "#email",
      "text": "john@example.com"
    },
    {
      "type": "type",
      "selector": "#password",
      "text": "SecurePass123"
    },
    {
      "type": "select_option",
      "selector": "#country",
      "value": "us"
    },
    {
      "type": "click",
      "selector": "#terms"
    },
    {
      "type": "click",
      "selector": "#sub-pro"
    }
  ]
}
```

**Expected Result:**
- All fields filled in sequence
- Country selected as "United States"
- Terms checkbox checked
- Pro subscription radio selected
- Form ready for submission

#### Test 4.15: Error Handling (Continue on Error)

**Command:**
```json
{
  "actions": [
    {
      "type": "click",
      "selector": "#nonexistent-element"
    },
    {
      "type": "type",
      "selector": "#username",
      "text": "test"
    }
  ],
  "onError": "ignore"
}
```

**Expected Result:**
- First action fails (element not found)
- Second action executes successfully
- Error logged but not thrown

#### Test 4.16: Error Handling (Stop on Error)

**Command:**
```json
{
  "actions": [
    {
      "type": "click",
      "selector": "#nonexistent-element"
    },
    {
      "type": "type",
      "selector": "#username",
      "text": "test"
    }
  ],
  "onError": "stop"
}
```

**Expected Result:**
- First action fails
- Execution stops immediately
- Second action never executes
- Error thrown to caller

---

## 5. DOM & Snapshot

### Tool: `browser_snapshot`

**Setup:** Navigate to test page

**Command:**
```json
{}
```

**Expected Result:**
- Returns accessible DOM tree in ARIA format
- Includes all interactive elements
- Shows element roles, labels, values
- Interactive form elements include CSS selector hints (e.g., `textbox: Enter query [input[placeholder="Enter query"]]`)
- Input fields show current values
- Tree structure with proper nesting
- Useful for AI to understand page structure

**What to Verify:**
- Form fields visible with current values
- Buttons and clickable elements listed
- Headings and semantic structure preserved
- Hidden elements excluded from snapshot
- Selector hints provided for textbox, combobox, searchbox, spinbutton elements
- Input values displayed inline with element descriptions

---

## 6. Visual Capture

### Tool: `browser_take_screenshot`

**Setup:** Navigate to test page

#### Test 6.1: Screenshot (Return Image Data)

**Command:**
```json
{
  "type": "jpeg",
  "quality": 80
}
```

**Expected Result:**
- Returns base64-encoded JPEG image
- Image shows current viewport
- Quality setting applied
- MimeType: `image/jpeg`

#### Test 6.2: Screenshot (Save to File)

**Command:**
```json
{
  "type": "png",
  "path": "/tmp/test-screenshot.png"
}
```

**Expected Result:**
- PNG file created at specified path
- File size reported in KB
- Returns success message with file path
- Image shows current viewport

#### Test 6.3: Full Page Screenshot

**Setup:** Navigate to test page (longer than viewport)

**Command:**
```json
{
  "fullPage": true,
  "type": "jpeg",
  "quality": 90,
  "path": "/tmp/full-page.jpg"
}
```

**Expected Result:**
- Page automatically scrolls to top first
- Screenshot captures entire page height
- Sticky elements positioned correctly (at top)
- 500ms wait for animations to complete
- File saved with full page content

#### Test 6.4: Screenshot Format Comparison

**Test both formats:**
```json
{"type": "png", "path": "/tmp/test.png"}
{"type": "jpeg", "quality": 100, "path": "/tmp/test.jpg"}
```

**Expected Result:**
- PNG: Lossless, larger file size
- JPEG: Smaller file size, quality parameter honored
- Both capture same content

---

## 7. JavaScript Execution

### Tool: `browser_evaluate`

**Setup:** Navigate to test page

#### Test 7.1: Execute Expression

**Command:**
```json
{
  "expression": "document.title"
}
```

**Expected Result:**
- Returns: "Browser Interaction Test Page"
- String value returned

#### Test 7.2: Execute Function

**Command:**
```json
{
  "function": "() => { return window.location.href; }"
}
```

**Expected Result:**
- Returns current page URL
- Function executed in page context

#### Test 7.3: Modify DOM

**Command:**
```json
{
  "expression": "document.getElementById('username').value = 'fromjs'; document.getElementById('username').value"
}
```

**Expected Result:**
- Username field value changes to "fromjs"
- Returns "fromjs"
- Change visible in UI

#### Test 7.4: Return Complex Object

**Command:**
```json
{
  "expression": "({title: document.title, url: location.href, fields: document.querySelectorAll('input').length})"
}
```

**Expected Result:**
- Returns object with title, url, and field count
- JSON serialization works correctly

#### Test 7.5: Console Logging Test

**Command:**
```json
{
  "expression": "console.log('Test message'); console.warn('Warning'); console.error('Error'); 'done'"
}
```

**Expected Result:**
- Returns "done"
- Console messages captured (verify with `browser_console_messages`)

---

## 8. Forms

### Tool: `browser_fill_form`

**Setup:** Navigate to test page

#### Test 8.1: Fill Multiple Fields

**Command:**
```json
{
  "fields": [
    {"selector": "#username", "value": "johndoe"},
    {"selector": "#email", "value": "john@example.com"},
    {"selector": "#password", "value": "SecurePass123"},
    {"selector": "#bio", "value": "Software developer from California"}
  ]
}
```

**Expected Result:**
- All four fields filled simultaneously
- Values visible in form
- Event log shows all input events
- Faster than individual type commands

#### Test 8.2: Fill Form with Validation

**Setup:** Some fields may have validation

**Command:**
```json
{
  "fields": [
    {"selector": "#email", "value": "invalid-email"},
    {"selector": "#username", "value": "ab"}
  ]
}
```

**Expected Result:**
- Fields filled regardless of client-side validation
- Validation errors may appear
- Values set as specified

---

## 9. Mouse Operations

### Tool: `browser_drag`

**Setup:** Need a page with draggable elements (not on test page currently)

**Alternative Test Setup:**
Navigate to: https://jqueryui.com/draggable/

**Command:**
```json
{
  "fromSelector": "#draggable",
  "toSelector": "#droppable"
}
```

**Expected Result:**
- Element dragged from source to target
- Drop event triggered
- Element position updated

**Note:** Test page doesn't currently have drag-drop elements. Consider adding in future.

---

## 10. Window Management

### Tool: `browser_window`

#### Test 10.1: Resize Window

**Command:**
```json
{
  "action": "resize",
  "width": 1024,
  "height": 768
}
```

**Expected Result:**
- Browser window resizes to 1024x768
- Content reflowed for new size
- Returns success confirmation

**Variations to test:**
- 1920x1080 (Full HD)
- 1366x768 (Laptop)
- 375x667 (Mobile simulation)

#### Test 10.2: Maximize Window

**Command:**
```json
{
  "action": "maximize"
}
```

**Expected Result:**
- Window maximizes to screen size
- Full screen (minus OS chrome)

#### Test 10.3: Minimize Window

**Command:**
```json
{
  "action": "minimize"
}
```

**Expected Result:**
- Window minimizes to dock/taskbar
- Window hidden but not closed

#### Test 10.4: Close Window

**Command:**
```json
{
  "action": "close"
}
```

**Expected Result:**
- Current window closes
- All tabs in window closed
- Connection may be lost if last window

**⚠️ Warning:** Use with caution - may close your only browser window!

---

## 11. Verification

### Tool: `browser_verify_text_visible`

**Setup:** Navigate to test page

#### Test 11.1: Verify Visible Text

**Command:**
```json
{
  "text": "Browser Interaction Test Page"
}
```

**Expected Result:**
- Returns: `true`
- Text found in page title

#### Test 11.2: Verify Hidden Text

**Command:**
```json
{
  "text": "You found the hidden element"
}
```

**Expected Result:**
- Returns: `false`
- Text exists but element is hidden (display: none)

#### Test 11.3: Verify Non-existent Text

**Command:**
```json
{
  "text": "This text does not exist anywhere"
}
```

**Expected Result:**
- Returns: `false`
- Text not found on page

### Tool: `browser_verify_element_visible`

#### Test 11.4: Verify Visible Element

**Command:**
```json
{
  "selector": "#username"
}
```

**Expected Result:**
- Returns: `true`
- Username field is visible

#### Test 11.5: Verify Hidden Element

**Command:**
```json
{
  "selector": "#hidden-msg"
}
```

**Expected Result:**
- Returns: `false`
- Element exists but has `display: none`

#### Test 11.6: Verify Non-existent Element

**Command:**
```json
{
  "selector": "#does-not-exist"
}
```

**Expected Result:**
- Returns: `false`
- Element not in DOM

---

## 12. Network Monitoring

### Tool: `browser_network_requests`

**Setup:** Navigate to a page that makes network requests

#### Test 12.1: Capture Network Requests

**Procedure:**
1. Enable network tracking
2. Navigate to test page
3. Call `browser_network_requests`

**Expected Result:**
- Returns list of network requests
- Each request includes:
  - URL
  - Method (GET, POST, etc.)
  - Status code
  - Response time
  - Request/response headers
- Includes page resources (HTML, CSS, JS, images)

**What to Verify:**
- Initial page load request
- CSS file requests
- JavaScript file requests
- Any XHR/Fetch requests

---

## 13. PDF Export

### Tool: `browser_pdf_save`

**Setup:** Navigate to test page

#### Test 13.1: Save Page as PDF

**Command:**
```json
{
  "path": "/tmp/test-page.pdf"
}
```

**Expected Result:**
- PDF file created at `/tmp/test-page.pdf`
- File size reported (e.g., 246KB)
- Returns success message with path and size
- PDF contains rendered page content

**What to Verify:**
- Open PDF and check content
- All text rendered
- Colors preserved
- Layout maintained
- Multi-page if content long

#### Test 13.2: PDF of Complex Page

**Setup:** Navigate to a page with images, forms, and complex layout

**Expected Result:**
- All elements rendered in PDF
- Forms visible (with current values)
- Images included
- Proper pagination

---

## 14. Dialog Handling

### Tool: `browser_handle_dialog`

**Setup:** Need to trigger a dialog first

#### Test 14.1: Handle Alert Dialog

**Setup:**
```json
{
  "expression": "alert('This is an alert!')"
}
```

**Command:**
```json
{
  "accept": true
}
```

**Expected Result:**
- Alert dialog dismissed
- Code execution continues

#### Test 14.2: Handle Confirm Dialog (Accept)

**Setup:**
```json
{
  "expression": "confirm('Are you sure?')"
}
```

**Command:**
```json
{
  "accept": true
}
```

**Expected Result:**
- Confirm dialog accepted
- Returns: `true` from confirm()

#### Test 14.3: Handle Confirm Dialog (Dismiss)

**Command:**
```json
{
  "accept": false
}
```

**Expected Result:**
- Confirm dialog dismissed
- Returns: `false` from confirm()

#### Test 14.4: Handle Prompt Dialog

**Setup:**
```json
{
  "expression": "prompt('Enter your name:')"
}
```

**Command:**
```json
{
  "accept": true,
  "text": "John Doe"
}
```

**Expected Result:**
- Prompt accepted with text
- Returns: "John Doe"

#### Test 14.5: Dismiss Prompt Dialog

**Command:**
```json
{
  "accept": false
}
```

**Expected Result:**
- Prompt dismissed
- Returns: `null`

---

## 15. Extension Management

### Tool: `browser_list_extensions`

#### Test 15.1: List All Extensions

**Command:**
```json
{}
```

**Expected Result:**
- Returns array of installed extensions
- Each extension includes:
  - Name
  - ID
  - Enabled status
  - Version
  - Description
- Includes Chrome MCP extension itself

### Tool: `browser_reload_extensions`

#### Test 15.2: Reload All Extensions

**Command:**
```json
{}
```

**Expected Result:**
- All extensions reloaded
- Extension contexts reset
- Connection may need re-establishment

#### Test 15.3: Reload Specific Extension

**Command:**
```json
{
  "extensionName": "Chrome MCP"
}
```

**Expected Result:**
- Only specified extension reloaded
- Returns success message
- Other extensions unaffected

**⚠️ Note:** Reloading Chrome MCP extension will close the connection!

---

## 16. Performance Metrics

### Tool: `browser_performance_metrics`

**Setup:** Navigate to test page

#### Test 16.1: Collect Web Vitals

**Command:**
```json
{}
```

**Expected Result:**
- Returns performance metrics object with:
  - **FCP** (First Contentful Paint) - Time to first content render
  - **LCP** (Largest Contentful Paint) - Time to largest content render
  - **CLS** (Cumulative Layout Shift) - Layout stability score
  - **TTFB** (Time to First Byte) - Server response time
  - **Load Time** - Total page load time
  - **DOM Content Loaded** - DOM ready time
  - **Navigation Type** (navigate, reload, back_forward)

**What to Verify:**
- All metrics present
- Values reasonable (FCP < 2s good, LCP < 2.5s good)
- CLS < 0.1 (good layout stability)
- Metrics match Chrome DevTools Performance tab

#### Test 16.2: Compare Performance Across Pages

**Procedure:**
1. Navigate to test page, collect metrics
2. Navigate to complex page (e.g., news site), collect metrics
3. Compare values

**Expected Result:**
- Complex pages have higher load times
- Simple pages have better Web Vitals scores
- Metrics reflect page complexity

---

## Testing Checklist

Use this checklist to verify all tools have been tested:

- [ ] **Tab Management** (browser_tabs)
  - [ ] List tabs
  - [ ] Create tab
  - [ ] Attach to tab
  - [ ] Close tab
  - [ ] Stealth mode

- [ ] **Navigation** (browser_navigate)
  - [ ] Navigate to URL
  - [ ] Back
  - [ ] Forward
  - [ ] Reload
  - [ ] Open test page

- [ ] **Interactions** (browser_interact)
  - [ ] Clear field
  - [ ] Type text
  - [ ] Press key
  - [ ] Click (left/right/middle)
  - [ ] Hover
  - [ ] Wait
  - [ ] Mouse move
  - [ ] Mouse click (coordinates)
  - [ ] Scroll to position
  - [ ] Scroll by offset
  - [ ] Scroll element into view
  - [ ] Select option
  - [ ] File upload (single)
  - [ ] File upload (multiple)
  - [ ] Error handling (stop/ignore)

- [ ] **Snapshot** (browser_snapshot)
  - [ ] Get DOM tree

- [ ] **Screenshots** (browser_take_screenshot)
  - [ ] Viewport JPEG
  - [ ] Viewport PNG
  - [ ] Full page
  - [ ] Save to file
  - [ ] Return base64

- [ ] **JavaScript** (browser_evaluate)
  - [ ] Execute expression
  - [ ] Execute function
  - [ ] Modify DOM
  - [ ] Return values

- [ ] **Console** (browser_console_messages)
  - [ ] Capture logs

- [ ] **Forms** (browser_fill_form)
  - [ ] Fill multiple fields

- [ ] **Drag & Drop** (browser_drag)
  - [ ] Drag element

- [ ] **Window** (browser_window)
  - [ ] Resize
  - [ ] Maximize
  - [ ] Minimize
  - [ ] Close

- [ ] **Verification** (browser_verify_text_visible, browser_verify_element_visible)
  - [ ] Verify visible text
  - [ ] Verify hidden text
  - [ ] Verify visible element
  - [ ] Verify hidden element

- [ ] **Network** (browser_network_requests)
  - [ ] Capture requests

- [ ] **PDF** (browser_pdf_save)
  - [ ] Save as PDF

- [ ] **Dialogs** (browser_handle_dialog)
  - [ ] Alert
  - [ ] Confirm (accept/dismiss)
  - [ ] Prompt (with text/dismiss)

- [ ] **Extensions** (browser_list_extensions, browser_reload_extensions)
  - [ ] List extensions
  - [ ] Reload all
  - [ ] Reload specific

- [ ] **Performance** (browser_performance_metrics)
  - [ ] Collect Web Vitals

- [ ] **Content Extraction** (browser_extract_content)
  - [ ] Auto-detect mode
  - [ ] Full page mode
  - [ ] Specific selector
  - [ ] Pagination (first chunk)
  - [ ] Pagination (continue)
  - [ ] Complex formatting

---

## 17. Content Extraction

### Tool: `browser_extract_content`

**Setup:** Navigate to any content-rich page (e.g., article, blog post, Wikipedia page)

#### Test 17.1: Auto-detect Main Content

**Command:**
```json
{
  "mode": "auto"
}
```

**Expected Result:**
- Automatically detects main content area (article, main, etc.)
- Returns clean markdown format
- Shows detected element (e.g., "main.mw-body")
- Includes total line count
- Content limited to 500 lines by default

**What to Verify:**
- Main content extracted, navigation/sidebars excluded
- Headings converted to markdown (# ## ###)
- Links preserved with full URLs
- Images shown as markdown: `![alt](url)`
- Lists formatted correctly (- or 1.)
- Code blocks preserved in ` ``` ` format

#### Test 17.2: Extract Full Page

**Command:**
```json
{
  "mode": "full"
}
```

**Expected Result:**
- Extracts entire body content
- Includes navigation, headers, footers
- More content than auto mode
- Same markdown formatting

#### Test 17.3: Extract Specific Selector

**Command:**
```json
{
  "mode": "selector",
  "selector": "#main-content"
}
```

**Expected Result:**
- Extracts only content from specified CSS selector
- Error if selector not found
- Markdown formatting applied

#### Test 17.4: Pagination - First Chunk

**Setup:** Navigate to long article (e.g., Wikipedia)

**Command:**
```json
{
  "max_lines": 200
}
```

**Expected Result:**
- Shows lines 1-200
- Total line count displayed (e.g., "Total lines: 1592")
- Truncation warning: "Use offset=200 to get next chunk"
- Content clean and readable

#### Test 17.5: Pagination - Continue Reading

**Command:**
```json
{
  "max_lines": 200,
  "offset": 200
}
```

**Expected Result:**
- Shows lines 201-400
- Continues from previous chunk
- No overlap or gaps
- Same formatting quality

#### Test 17.6: Pagination - Get Remaining Content

**Command:**
```json
{
  "offset": 1400
}
```

**Expected Result:**
- Shows lines 1401 to end
- No truncation warning if this is last chunk
- Final content delivered

#### Test 17.7: Extract from Complex Page

**Setup:** Navigate to page with:
- Multiple heading levels
- Bold and italic text
- Code blocks
- Nested lists
- Blockquotes
- Images

**Expected Result:**
- All formatting elements preserved:
  - `**bold**`, `*italic*`
  - Nested lists with proper indentation
  - Code blocks with ` ``` ` fencing
  - Blockquotes with `>` prefix
  - Horizontal rules as `---`
  - Tables noted as `[Table content omitted]`

**What to Verify:**
- No HTML tags in output
- Clean, readable markdown
- Proper spacing and line breaks
- Links are clickable URLs

---

## Common Issues & Troubleshooting

### Issue: "No connection to browser extension"
**Solution:** Click extension icon and click "Connect"

### Issue: "Cannot automate chrome-extension:// tab"
**Solution:** Select a regular web page tab, not an extension page

### Issue: "Extension blocking debugging"
**Symptoms:** iCloud Password Manager or similar shown in error
**Solution:** Disable the blocking extension or use a different browser profile

### Issue: Element not found
**Solution:**
- Verify selector is correct (must be CSS selector, not accessibility role)
- Use selector hints from browser_snapshot (e.g., `[input[placeholder="..."]]`)
- Check if element is in shadow DOM (may need different approach)
- Wait for page to fully load

### Issue: Invalid selector error (accessibility role used)
**Symptoms:** Error message like "Invalid selector 'textbox'. This is an accessibility role, not a CSS selector"
**Solution:**
- Don't use accessibility role names (textbox, button, link, etc.) as selectors
- Use CSS selectors instead: `input[type="text"]`, `#id`, `.class`, `button`
- Check browser_snapshot output for selector hints in square brackets

### Issue: Screenshot shows sticky navbar in middle
**Solution:** Already fixed in v0.1.31+ - auto-scrolls to top for full-page screenshots

### Issue: File upload not working
**Solution:**
- Verify file paths are absolute
- Check file exists and is readable
- Ensure selector targets file input element

---

## Test Report Template

After testing, document results using this template:

```
# Chrome MCP Test Report

**Date:** [Date]
**Version:** [Chrome MCP version]
**Tester:** [Name]
**Environment:** [OS, Chrome version]

## Test Results Summary
- Total Tests: [number]
- Passed: [number]
- Failed: [number]
- Skipped: [number]

## Failed Tests
[List any failed tests with details]

## Issues Found
[Document any bugs or unexpected behavior]

## Performance Notes
[Any performance concerns or metrics]

## Recommendations
[Suggested improvements]
```

---

## Automated Testing Script

For regression testing, consider creating an automated test script that:
1. Connects to extension
2. Opens test page
3. Runs all test commands in sequence
4. Validates responses
5. Generates report

This can be implemented using the MCP SDK and a test framework like Jest or Mocha.
