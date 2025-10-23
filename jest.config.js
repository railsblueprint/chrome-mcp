module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/tests/.*\\.spec\\.ts$', // Ignore old Playwright tests
    '/tests/fixtures\\.ts$',
    '/tests/testserver/',
  ],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/tests/',
  ],
};
