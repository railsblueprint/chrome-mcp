/**
 * Copyright (c) 404 Software Labs.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

(function() {
  // Parse URL parameters
  const params = new URLSearchParams(window.location.search);
  const accessToken = params.get('access');
  const refreshToken = params.get('refresh');

  if (accessToken && refreshToken) {
    // Store tokens in chrome.storage.local
    chrome.storage.local.set({
      accessToken: accessToken,
      refreshToken: refreshToken,
      isPro: true
    }, () => {
      console.log('Tokens saved successfully');

      // Close this tab after a short delay
      setTimeout(() => {
        window.close();
      }, 1000);
    });
  } else {
    // Missing tokens - show error
    document.querySelector('.container').innerHTML = `
      <h1 style="color: #f44336;">Login Failed</h1>
      <p>Missing authentication tokens. Please try again.</p>
    `;
    setTimeout(() => {
      window.close();
    }, 3000);
  }
})();
