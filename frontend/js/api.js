// api.js - Central API configuration and utilities
// Point at the local wrangler dev server when running on localhost, otherwise the deployed worker.
const API_URL = (() => {
    const host = location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return 'http://127.0.0.1:8787';
    return 'https://cbt-worker.shishira-932.workers.dev';
})();

const api = {
    // Base URL the app talks to (local dev server or the deployed worker)
    baseUrl: API_URL,
    
    // Get token from local storage
    getToken: () => localStorage.getItem('cbt_token'),
    
    // Set token to local storage
    setToken: (token) => localStorage.setItem('cbt_token', token),
    
    // Build a full URL for an R2-backed image so it works when the frontend is
    // served from a different origin than the API.
    imageUrl: (key) => `${API_URL}/images/${key}`,
    
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
            
            // An expired or revoked token leaves every page showing "failed to load"
            // with no way back. Send the user to the login screen instead.
            // Only when we actually sent a token — a wrong password on the login
            // form also returns 401 and must not loop.
            if (response.status === 401 && token) {
                api.logout();
            }
            
            if (!response.ok) {
                throw new Error(data.error || 'Something went wrong');
            }
            
            return data;
        } catch (error) {
            throw error;
        }
    }
};
