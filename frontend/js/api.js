// api.js - Central API configuration and utilities
const API_URL = 'https://cbt-worker.shishira-932.workers.dev';

const api = {
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
                throw new Error(data.error || 'Something went wrong');
            }
            
            return data;
        } catch (error) {
            throw error;
        }
    }
};
