# Contributing to Blueprint MCP for Chrome

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment for everyone.

## How to Contribute

### Reporting Bugs

Before creating bug reports, please check existing issues to avoid duplicates. When creating a bug report, include:

- **Clear title and description**
- **Steps to reproduce** the issue
- **Expected vs actual behavior**
- **Environment details** (OS, Node version, Chrome version)
- **Screenshots or logs** if applicable

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, include:

- **Use case**: Why is this enhancement useful?
- **Proposed solution**: How should it work?
- **Alternatives considered**: What other approaches did you think about?

### Pull Requests

1. **Fork the repo** and create your branch from `main`
2. **Make your changes**:
   - Follow existing code style
   - Add tests if applicable
   - Update documentation as needed
3. **Test your changes**:
   ```bash
   npm test
   ```
4. **Commit your changes** with a clear commit message
5. **Push to your fork** and submit a pull request

#### Pull Request Guidelines

- **One feature per PR**: Keep PRs focused on a single change
- **Write clear commit messages**: Explain what and why, not how
- **Update documentation**: README, CLAUDE.md, etc. if needed
- **Add tests**: For new features or bug fixes
- **Keep it small**: Smaller PRs are easier to review

Example commit message:
```
Fix extension reconnection after browser restart

The extension was not properly handling the case where the browser
restarts while the MCP server is still running. This adds logic to
detect stale connections and trigger a fresh handshake.

Fixes #123
```

## Development Setup

### Prerequisites

- Node.js 18+
- Chrome or Edge browser
- npm or yarn

### Setup Steps

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/chrome-mcp.git
cd chrome-mcp

# Install dependencies
npm install

# Install extension dependencies
cd extension
npm install
cd ..
```

### Running the MCP Server

```bash
# Start in debug mode
node cli.js --debug
```

### Building the Extension

```bash
cd extension

# Build once
npm run build

# Watch mode for development
npm run dev
```

Then load the unpacked extension from `extension/dist/` in Chrome.

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npm test -- tests/statefulBackend.test.js
```

## Project Structure

```
chrome-mcp/
├── cli.js                      # MCP server entry point
├── src/
│   ├── statefulBackend.js      # Connection state management
│   ├── unifiedBackend.js       # MCP tool implementations
│   ├── extensionServer.js      # WebSocket server
│   ├── mcpConnection.js        # Proxy connection handling
│   ├── transport.js            # Transport abstraction
│   └── oauth.js                # OAuth2 client
├── extension/
│   └── src/
│       ├── background.ts       # Extension service worker
│       ├── relayConnection.ts  # WebSocket client
│       └── utils/              # Utilities
└── tests/                      # Test suites
```

## Coding Guidelines

### JavaScript/TypeScript Style

- **Server code**: JavaScript (ES6+)
- **Extension code**: TypeScript
- **Indentation**: 2 spaces
- **Semicolons**: Yes
- **Quotes**: Single quotes for strings
- **Naming**: camelCase for functions/variables, PascalCase for classes

### Commenting

- Write self-documenting code when possible
- Add comments for complex logic or non-obvious decisions
- Use JSDoc for public APIs

Example:
```javascript
/**
 * Connect to the browser extension via WebSocket
 * @param {string} clientId - Unique identifier for this client
 * @returns {Promise<void>}
 */
async function connectToExtension(clientId) {
  // Implementation...
}
```

### Error Handling

- Always handle errors explicitly
- Return user-friendly error messages
- Log errors for debugging (use `debugLog` helper)

Example:
```javascript
try {
  await this._connectToRelay(url);
} catch (error) {
  debugLog('[Error] Connection failed:', error);
  return {
    content: [{
      type: 'text',
      text: `Connection failed: ${error.message}\n\nPlease check your network and try again.`
    }],
    isError: true
  };
}
```

## Testing Guidelines

### What to Test

- **Critical paths**: Connection flow, tool execution
- **Error cases**: Network failures, invalid inputs
- **State transitions**: passive → active → connected
- **Edge cases**: Multiple simultaneous connections, reconnection logic

### Writing Tests

```javascript
describe('StatefulBackend', () => {
  it('starts in passive state', () => {
    const backend = new StatefulBackend({});
    expect(backend._state).toBe('passive');
  });

  it('transitions to active on enable', async () => {
    // Setup
    const backend = new StatefulBackend({});

    // Execute
    await backend.callTool('enable', { client_id: 'test' });

    // Assert
    expect(backend._state).toBe('active');
  });
});
```

## Documentation

### When to Update Documentation

Update documentation when you:
- Add new features or tools
- Change existing behavior
- Fix bugs that affect usage
- Add new configuration options

### Which Files to Update

- **README.md**: User-facing changes (installation, usage, features)
- **CLAUDE.md**: Architecture or development workflow changes
- **CONTRIBUTING.md**: Process or setup changes
- **Code comments**: Complex logic or non-obvious decisions

## Release Process

Releases are handled by maintainers. The process:

1. Update version in `package.json` and `CLAUDE.md`
2. Update `CHANGELOG.md` with changes
3. Create git tag: `git tag v1.0.0`
4. Push tag: `git push origin v1.0.0`
5. Publish to npm: `npm publish`
6. Create GitHub release with release notes

## Questions?

- **Issues**: [GitHub Issues](https://github.com/railsblueprint/chrome-mcp/issues)
- **Documentation**: [docs.railsblueprint.com](https://mcp-for-chrome.railsblueprint.com/docs)

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
