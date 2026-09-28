// api.js - Central API configuration and utilities
const API_URL = (typeof window !== 'undefined' && window.location && window.location.origin) 
  ? window.location.origin 
  : 'http://127.0.0.1:8787';

const api = {
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

    getToken: function() {
        return localStorage.getItem('cbt_token');
    },
    
    setToken: function(token) {
        localStorage.setItem('cbt_token', token);
    },
    
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
            
            if (!response.ok) {
                if (response.status === 401 && api.getToken()) {
                    localStorage.removeItem('cbt_token');
                    localStorage.removeItem('cbt_user');
                    if (window.location.pathname !== '/') {
                        window.location.href = '/';
                    }
                    throw new Error('Session expired — please sign in again');
                }
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
