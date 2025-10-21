/**
 * Form Result Page JavaScript
 */

document.addEventListener('DOMContentLoaded', () => {
  const formDataDiv = document.getElementById('form-data');
  const submissionData = sessionStorage.getItem('formSubmission');

  if (submissionData) {
    const { data, files } = JSON.parse(submissionData);

    // Display form fields
    Object.entries(data).forEach(([key, value]) => {
      const item = document.createElement('div');
      item.className = 'data-item';

      const label = document.createElement('span');
      label.className = 'data-label';
      label.textContent = formatLabel(key) + ':';

      const valueSpan = document.createElement('span');
      valueSpan.className = 'data-value';
      valueSpan.textContent = value || '(empty)';

      item.appendChild(label);
      item.appendChild(valueSpan);
      formDataDiv.appendChild(item);
    });

    // Display file uploads
    if (Object.keys(files).length > 0) {
      Object.entries(files).forEach(([key, fileList]) => {
        const item = document.createElement('div');
        item.className = 'data-item';

        const label = document.createElement('span');
        label.className = 'data-label';
        label.textContent = formatLabel(key) + ':';

        const valueSpan = document.createElement('span');
        valueSpan.className = 'data-value';

        if (fileList.length > 0) {
          const fileInfo = fileList.map(f =>
            `${f.name} (${formatFileSize(f.size)}, ${f.type || 'unknown type'})`
          ).join(', ');
          valueSpan.textContent = fileInfo;
        } else {
          valueSpan.textContent = '(no files selected)';
        }

        item.appendChild(label);
        item.appendChild(valueSpan);
        formDataDiv.appendChild(item);
      });
    }

    // Clear sessionStorage after displaying
    sessionStorage.removeItem('formSubmission');
  } else {
    formDataDiv.innerHTML = '<p style="color: #a0aec0;">No form data received. This page should be accessed by submitting the test form.</p>';
  }
});

function formatLabel(key) {
  // Convert form field names to readable labels
  const labels = {
    'username': 'Username',
    'email': 'Email',
    'password': 'Password',
    'country': 'Country',
    'bio': 'Bio',
    'terms': 'Terms Accepted',
    'subscription': 'Subscription Plan',
    'avatar': 'Avatar',
    'documents': 'Documents'
  };

  return labels[key] || key.charAt(0).toUpperCase() + key.slice(1);
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}
