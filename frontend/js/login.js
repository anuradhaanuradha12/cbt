// login.js - Handles authentication logic
document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('loginForm');
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const loginBtn = document.getElementById('loginBtn');
    const btnText = loginBtn.querySelector('.btn-text');
    const btnLoader = loginBtn.querySelector('.btn-loader');
    const errorBox = document.getElementById('errorBox');
    
    // If already logged in, redirect to dashboard
    if (api.getToken()) {
        window.location.href = 'dashboard.html';
    }
    
    const setLoading = (isLoading) => {
        if (isLoading) {
            btnText.classList.add('hidden');
            btnLoader.classList.remove('hidden');
            loginBtn.disabled = true;
        } else {
            btnText.classList.remove('hidden');
            btnLoader.classList.add('hidden');
            loginBtn.disabled = false;
        }
    };
    
    const showError = (message) => {
        errorBox.textContent = message;
        errorBox.classList.remove('hidden');
        
        // Hide after 5 seconds
        setTimeout(() => {
            errorBox.classList.add('hidden');
        }, 5000);
    };
    
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const email = emailInput.value.trim();
        const password = passwordInput.value;
        
        if (!email || !password) {
            showError('Please enter both email and password');
            return;
        }
        
        setLoading(true);
        errorBox.classList.add('hidden');
        
        try {
            const response = await api.request('/auth/login', 'POST', { email, password });
            
            // Save auth state
            api.setToken(response.token);
            localStorage.setItem('cbt_user', JSON.stringify(response.user));
            // Redirect based on role
            if (response.user.role === 'admin' || response.user.role === 'faculty') {
                window.location.href = 'admin.html';
            } else {
                window.location.href = 'dashboard.html';
            }
        } catch (error) {
            showError(error.message || 'Invalid credentials or server offline.');
        } finally {
            setLoading(false);
        }
    });
});
