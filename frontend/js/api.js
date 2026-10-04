// api.js - Central API configuration and utilities
// Talk to whatever origin served this page, which is the wrangler dev server in
// local development and the deployed worker in production.
const API_URL = (typeof window !== 'undefined' && window.location && window.location.origin)
  ? window.location.origin
  : 'http://127.0.0.1:8787';

const api = {
    // Base URL the app talks to. Exposed under both names: `baseUrl` is the
    // preferred spelling, `API_URL` is kept for existing call sites.
    baseUrl: API_URL,
    API_URL: API_URL,

    renderRichText: function(text) {
        if (text == null) return '';
        return String(text).replace(
            /\[IMG:\s*([^\]]+)\]/g,
            function(m, src) {
                return '<img src="' + src.trim() + '" class="inline-block max-h-40 rounded border border-gray-300 align-middle mx-1 my-1" alt="figure">';
            }
        );
    },

    // Build a full URL for an R2-backed image so it works when the frontend is
    // served from a different origin than the API.
    imageUrl: function(key) {
        return API_URL + '/images/' + key;
    },

    getToken: function() {
        return localStorage.getItem('cbt_token');
    },

    setToken: function(token) {
        localStorage.setItem('cbt_token', token);
    },

    // Clear auth
    logout: function() {
        localStorage.removeItem('cbt_token');
        localStorage.removeItem('cbt_user');
        window.location.href = '/';
    },
    
    request: async function(endpoint, method, body) {
        if (method === undefined) method = 'GET';
        if (body === undefined) body = null;

        const headers = {
            'Content-Type': 'application/json'
        };
        
        const token = api.getToken();
        if (token) {
            headers['Authorization'] = 'Bearer ' + token;
        }
        
        const config = {
            method: method,
            headers: headers
        };
        
        if (body) {
            config.body = JSON.stringify(body);
        }
        
        try {
            const response = await fetch(API_URL + endpoint, config);
            const data = await response.json();
            
            // An expired or revoked token leaves every page showing "failed to load"
            // with no way back. Send the user to the login screen instead.
            // Only when we actually sent a token — a wrong password on the login
            // form also returns 401 and must not loop.
            if (response.status === 401 && token) {
                api.logout();
            }

            if (!response.ok) {
                const err = new Error(data.error || 'Something went wrong');
                err.data = data;
                throw err;
            }
            
            return data;
        } catch (error) {
            throw error;
        }
    }
};
