#!/bin/bash
# Sync test pages from shared-assets to both extensions

echo "Syncing test pages from shared-assets..."

# Copy to Chrome extension
cp shared-assets/test-interactions.html extension/dist/test-interactions.html
cp shared-assets/test-interactions.js extension/dist/test-interactions.js

# Copy to Firefox extension (renamed to test.html/test.js)
cp shared-assets/test-interactions.html firefox-extension/test.html
cp shared-assets/test-interactions.js firefox-extension/test.js

# Fix script reference in Firefox version
sed -i '' 's/test-interactions\.js/test.js/g' firefox-extension/test.html

echo "✅ Test pages synced successfully!"
echo "  - Chrome: extension/dist/test-interactions.html"
echo "  - Firefox: firefox-extension/test.html"
