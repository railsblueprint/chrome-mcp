// Test script to demonstrate selector suggestions
// This simulates what would happen when using the MCP server

const testHTML = `
<!DOCTYPE html>
<html>
<body>
  <a href="#" class="btn primary">Submit Form</a>
  <div role="button" class="btn-submit action">Submit Now</div>
  <span class="link-submit">Submit Here</span>
  <button type="submit" style="display:none">Submit Hidden</button>
</body>
</html>
`;

console.log("Test HTML:\n", testHTML);
console.log("\n=== Test Case ===");
console.log("Selector: button:has-text('Submit')");
console.log("\nExpected behavior:");
console.log("- Element not found (no visible button with 'Submit')");
console.log("- Show 'Did you mean?' with alternatives:");
console.log("  1. a.btn.primary:has-text('Submit') ✓");
console.log("  2. div.btn-submit.action:has-text('Submit') ✓");
console.log("  3. span.link-submit:has-text('Submit') ✓");
console.log("  4. button[type=submit]:has-text('Submit') ✗ (hidden)");
console.log("\nThis helps users find the correct selector!");
