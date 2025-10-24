/**
 * Test Interactions Page JavaScript
 */

// Event logger - make it global so inline onclick handlers can access it
window.logEvent = function(message) {
  const log = document.getElementById('event-log');
  const timestamp = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.textContent = `[${timestamp}] ${message}`;
  entry.style.marginBottom = '5px';
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
};

// Wait for DOM to be ready
document.addEventListener('DOMContentLoaded', () => {

  // Form event listeners
  document.getElementById('test-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const formData = new FormData(e.target);
    const data = {};
    const files = {};

    // Collect form data and file info
    for (const [key, value] of formData.entries()) {
      if (value instanceof File) {
        if (value.size > 0) {
          files[key] = files[key] || [];
          files[key].push({
            name: value.name,
            size: value.size,
            type: value.type
          });
        }
      } else {
        data[key] = value;
      }
    }

    logEvent(`Form submitting: ${Object.keys(data).length} fields, ${Object.keys(files).length} file inputs`);

    // Store in sessionStorage
    sessionStorage.setItem('formSubmission', JSON.stringify({ data, files }));

    // Navigate to result page
    window.location.href = 'form-result.html';
  });

  document.getElementById('username').addEventListener('input', (e) => {
    logEvent(`Username changed: "${e.target.value}"`);
  });

  document.getElementById('email').addEventListener('input', (e) => {
    logEvent(`Email changed: "${e.target.value}"`);
  });

  document.getElementById('country').addEventListener('change', (e) => {
    logEvent(`Country selected: "${e.target.value}"`);
  });

  // Click testing
  ['click-target-1', 'click-target-2', 'click-target-3'].forEach(id => {
    document.getElementById(id).addEventListener('click', (e) => {
      logEvent(`Clicked: ${e.target.textContent}`);
      e.target.style.transform = 'scale(0.95)';
      setTimeout(() => e.target.style.transform = '', 100);
    });
  });

  document.getElementById('show-hidden').addEventListener('click', () => {
    const hidden = document.getElementById('hidden-msg');
    hidden.classList.add('visible');
    logEvent('Hidden element shown');
  });

  // Hover testing
  document.getElementById('hover-target').addEventListener('mouseenter', () => {
    logEvent('Hover: Mouse entered hover target');
  });

  document.getElementById('hover-target').addEventListener('mouseleave', () => {
    logEvent('Hover: Mouse left hover target');
  });

  // Mouse coordinates
  const coordArea = document.getElementById('coord-area');
  const coordDisplay = document.getElementById('coord-display');
  const targetDot = document.getElementById('target-dot');

  coordArea.addEventListener('mousemove', (e) => {
    const rect = coordArea.getBoundingClientRect();
    const x = Math.round(e.clientX - rect.left);
    const y = Math.round(e.clientY - rect.top);
    coordDisplay.textContent = `X: ${x}, Y: ${y}`;
  });

  coordArea.addEventListener('click', (e) => {
    const rect = coordArea.getBoundingClientRect();
    const x = Math.round(e.clientX - rect.left);
    const y = Math.round(e.clientY - rect.top);
    logEvent(`Mouse clicked at (${x}, ${y})`);
  });

  targetDot.addEventListener('click', () => {
    logEvent('🎯 Bull\'s eye! Target dot clicked!');
    targetDot.style.backgroundColor = '#00ff00';
    setTimeout(() => targetDot.style.backgroundColor = '#ff4444', 500);
  });

  // Wait testing
  document.getElementById('delayed-show').addEventListener('click', () => {
    logEvent('Delayed element will appear in 2 seconds...');
    setTimeout(() => {
      document.getElementById('delayed-element').classList.add('visible');
      logEvent('Delayed element is now visible!');
    }, 2000);
  });

  // Clear log
  document.getElementById('clear-log').addEventListener('click', () => {
    document.getElementById('event-log').innerHTML = '<div>Event log cleared...</div>';
  });

  // Initial log
  logEvent('Test page loaded and ready');
});
