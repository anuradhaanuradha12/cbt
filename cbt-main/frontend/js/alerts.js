// alerts.js - Shared SweetAlert2 theming: toasts + modal alert/confirm/prompt.
// Requires SweetAlert2 to be loaded first. Set `window.QFORGE_THEME = 'dark'`
// before this script on dark-surface pages (e.g. question-gen.html); every
// other page defaults to the light StepVista theme (css/style.css palette).
(function () {
  const isDark = window.QFORGE_THEME === 'dark';

  const palette = isDark
    ? {
        background: '#18181b',
        color: '#fafafa',
        border: '#27272a',
        confirmButtonColor: '#10b981',
        cancelButtonColor: '#3f3f46',
        denyButtonColor: '#ef4444',
      }
    : {
        background: '#ffffff',
        color: '#18181b',
        border: '#e4e4e7',
        confirmButtonColor: '#5846f6',
        cancelButtonColor: '#e4e4e7',
        denyButtonColor: '#ef4444',
      };

  const styleEl = document.createElement('style');
  styleEl.id = 'qforge-swal-theme';
  styleEl.textContent = `
    .qforge-swal-popup {
      font-family: 'Gabarito', 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
      border-radius: 20px !important;
      border: 1px solid ${palette.border};
    }
    .qforge-swal-title { font-weight: 700 !important; }
    .qforge-swal-confirm, .qforge-swal-deny, .qforge-swal-cancel {
      border-radius: 12px !important;
      font-weight: 600 !important;
      box-shadow: none !important;
    }
    .qforge-swal-cancel { color: ${isDark ? '#fafafa' : '#52525b'} !important; }
    .qforge-swal-toast {
      font-family: 'Gabarito', 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
      border-radius: 12px !important;
      border: 1px solid ${palette.border};
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06) !important;
    }
  `;
  document.head.appendChild(styleEl);

  const baseClass = {
    popup: 'qforge-swal-popup',
    title: 'qforge-swal-title',
    confirmButton: 'qforge-swal-confirm',
    cancelButton: 'qforge-swal-cancel',
    denyButton: 'qforge-swal-deny',
  };

  const base = {
    background: palette.background,
    color: palette.color,
    confirmButtonColor: palette.confirmButtonColor,
    cancelButtonColor: palette.cancelButtonColor,
    buttonsStyling: true,
    customClass: baseClass,
  };

  // Centered pop-up notification — the app's standard feedback style.
  // Auto-dismisses (timer + progress bar); errors and warnings also show an
  // OK button so they can be acknowledged immediately.
  const pop = (icon, message, title) => window.Swal.fire({
    ...base,
    icon,
    title: title || message,
    text: title ? message : undefined,
    toast: false,
    position: 'center',
    timer: (icon === 'error' || icon === 'warning') ? 5000 : 2600,
    timerProgressBar: true,
    showConfirmButton: icon === 'error' || icon === 'warning',
    confirmButtonText: 'OK',
  });

  window.notify = {
    // Centered pop-up message — use for success/info/error feedback.
    success: (message, title) => pop('success', message, title),
    error: (message, title) => pop('error', message, title),
    warning: (message, title) => pop('warning', message, title),
    info: (message, title) => pop('info', message, title),

    // Blocking modal — use where the old code used alert() to halt the user
    // (critical errors, a redirect about to happen, anti-cheat strikes).
    alert: (message, opts = {}) =>
      window.Swal.fire({
        ...base,
        icon: opts.icon || 'info',
        title: opts.title || '',
        text: message,
        confirmButtonText: opts.confirmButtonText || 'OK',
      }),

    // Replaces confirm() — resolves true/false.
    confirm: async (message, opts = {}) => {
      const res = await window.Swal.fire({
        ...base,
        icon: opts.icon || 'question',
        title: opts.title || 'Are you sure?',
        text: message,
        showCancelButton: true,
        confirmButtonText: opts.confirmText || 'Yes',
        cancelButtonText: opts.cancelText || 'Cancel',
        reverseButtons: true,
        confirmButtonColor: opts.danger ? palette.denyButtonColor : palette.confirmButtonColor,
      });
      return res.isConfirmed;
    },

    // Replaces prompt() — resolves the entered string, or null if cancelled.
    prompt: async (message, opts = {}) => {
      const res = await window.Swal.fire({
        ...base,
        title: opts.title || message,
        text: opts.title ? message : undefined,
        input: opts.input || 'text',
        inputPlaceholder: opts.placeholder || '',
        inputValue: opts.defaultValue || '',
        showCancelButton: true,
        confirmButtonText: opts.confirmText || 'OK',
        cancelButtonText: opts.cancelText || 'Cancel',
        reverseButtons: true,
        inputValidator: opts.required
          ? (value) => (!value ? (opts.requiredMessage || 'This field is required') : undefined)
          : undefined,
      });
      return res.isConfirmed ? (res.value ?? '') : null;
    },
  };
})();
