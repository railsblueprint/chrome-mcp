#!/bin/bash
set -e

# Release script for chrome-mcp
# Updates versions, rebuilds extension, commits, and publishes

echo "🚀 Chrome MCP Release Script"
echo ""

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
  echo "❌ Error: Must run from chrome-mcp root directory"
  exit 1
fi

# Get version type (patch, minor, major)
VERSION_TYPE=${1:-patch}
echo "📦 Bumping version ($VERSION_TYPE)..."

# Update root package.json
npm version $VERSION_TYPE --no-git-tag-version

# Get new version
NEW_VERSION=$(node -p "require('./package.json').version")
echo "✅ New version: $NEW_VERSION"

# Update extension package.json
echo "📦 Updating extension package.json..."
cd extension
npm version $VERSION_TYPE --no-git-tag-version
cd ..

# Update extension manifest.json
echo "📦 Updating extension manifest.json..."
node -e "
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
manifest.version = '$NEW_VERSION';
fs.writeFileSync('extension/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log('✅ Updated manifest.json to version $NEW_VERSION');
"

# Rebuild extension (for local testing - dist is gitignored)
echo "🔨 Building extension..."
cd extension
npm run build
cd ..
echo "✅ Extension built (note: dist/ is gitignored, users will build on install)"

# Show what changed
echo ""
echo "📝 Files updated:"
git status --short

# Commit
echo ""
read -p "📝 Enter commit message: " COMMIT_MSG
git add package.json package-lock.json extension/package.json extension/package-lock.json extension/manifest.json extension/dist src/
git commit -m "$COMMIT_MSG

Version bumped to $NEW_VERSION"

# Publish to npm
echo ""
read -p "🚀 Publish to npm? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  npm publish
  echo "✅ Published to npm"
else
  echo "⏭️  Skipped npm publish"
fi

# Push to GitHub
echo ""
read -p "🚀 Push to GitHub? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  git push origin main
  echo "✅ Pushed to GitHub"
else
  echo "⏭️  Skipped GitHub push"
fi

echo ""
echo "✨ Release complete! Version $NEW_VERSION"
