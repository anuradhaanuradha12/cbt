// login.js - Handles authentication logic
document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('loginForm');
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const loginBtn = document.getElementById('loginBtn');
    const btnText = loginBtn.querySelector('.btn-text');
    const btnLoader = loginBtn.querySelector('.btn-loader');
    const errorBox = document.getElementById('errorBox');

    // "Continue with Google" — hand off to the Worker's OAuth start route.
    // The Worker redirects to Google, then back to /oauth-callback.html,
    // which completes sign-in exactly like a password login.
    const googleBtn = document.getElementById('googleSignInBtn');
    if (googleBtn) {
        googleBtn.href = `${api.API_URL}/auth/google`;
    }

    // Surface OAuth failures redirected back to this page (?oauth_error=...)
    const oauthError = new URLSearchParams(window.location.search).get('oauth_error');
    if (oauthError) {
        const messages = {
            not_configured: 'Google sign-in is not configured on this deployment yet. Ask your admin to set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.',
            missing_code: 'Google sign-in was cancelled or is missing required parameters.',
            invalid_state: 'Google sign-in session expired. Please try again.',
            token_exchange_failed: 'Could not complete Google sign-in (token exchange failed). Please try again.',
            no_access_token: 'Could not complete Google sign-in. Please try again.',
            profile_fetch_failed: 'Could not read your Google profile. Please try again.',
            email_not_verified: 'Your Google email is not verified — cannot use it to sign in.',
            account_disabled: 'This account has been disabled. Contact your admin.',
        };
        showError(messages[oauthError] || 'Google sign-in failed. Please try again.');
        // Clean the URL so a refresh doesn't re-show the error
        window.history.replaceState({}, '', '/');
    }

    // If already logged in, redirect to dashboard
    if (api.getToken()) {
        window.location.href = '/dashboard';
    } else {
        // Clear fields in case the browser cached them from a previous session
        emailInput.value = '';
        passwordInput.value = '';
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
        // Trim surrounding whitespace: autofill and paste commonly add a leading or
        // trailing space, which silently fails the server-side hash comparison.
        const password = passwordInput.value.trim();
        
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
            if (response.user.role === 'admin' || response.user.role === 'faculty' || response.user.role === 'principal') {
                window.location.href = '/admin';
            } else {
                window.location.href = '/dashboard';
            }
        } catch (error) {
            showError(error.message || 'Invalid credentials or server offline.');
        } finally {
            setLoading(false);
        }
    });
});
