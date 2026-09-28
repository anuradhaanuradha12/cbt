// api.js - Central API configuration and utilities
// Environment-aware: local dev server when served from localhost, deployed worker otherwise
const API_URL = (() => {
  const h = window.location.hostname;
  if (h === 'localhost' || h === '127.0.0.1') return 'http://127.0.0.1:8787';
  return 'https://cbt-worker.shishira-932.workers.dev';
})();

const api = {
    // Base URL of the Worker API (used e.g. to build the Google OAuth start URL)
    API_URL,

    // Convert inline [IMG:/images/external/…] markers (rewritten from CDN
    // placeholders during ingest) into rendered <img> tags. Safe to call on
    // any question field; text without markers passes through unchanged.
    renderRichText: (text) => {
        if (text == null) return '';
        return String(text).replace(
            /\[IMG:\s*([^\]]+)\]/g,
            (m, src) => `<img src="${src.trim()}" class="inline-block max-h-40 rounded border border-gray-300 align-middle mx-1 my-1" alt="figure">`
        );
    },
    // Get token from local storage
    getToken: () => localStorage.getItem('cbt_token'),
    
    // Set token to local storage
    setToken: (token) => localStorage.setItem('cbt_token', token),
    
    // Clear auth
    logout: () => {
        localStorage.removeItem('cbt_token');
        localStorage.removeItem('cbt_user');
        window.location.href = '/';
    },
    
    // Generic request handler
    request: async (endpoint, method = 'GET', body = null) => {
        const headers = {
            'Content-Type': 'application/json'
        };
        
        const token = api.getToken();
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        
        const config = {
            method,
            headers
        };
        
        if (body) {
            config.body = JSON.stringify(body);
        }
        
        try {
            const response = await fetch(`${API_URL}${endpoint}`, config);
            const data = await response.json();
            
            if (!response.ok) {
                // An expired or invalid session used to surface as a banner over
                // empty panels, which looks like missing data. If we were holding
                // a token, the session is over — send the user back to sign in.
                if (response.status === 401 && api.getToken()) {
                    localStorage.removeItem('cbt_token');
                    localStorage.removeItem('cbt_user');
                    if (window.location.pathname !== '/') {
                        window.location.href = '/';
                    }
                    throw new Error('Session expired — please sign in again');
                }
                const err = new Error(data.error || 'Something went wrong');
                err.data = data; // structured payload (e.g. quota_gaps) for callers that need it
                throw err;
            }
            
            return data;
        } catch (error) {
            throw error;
        }
    }
};
