// downloads.js - Downloads & Export hub: auth guard, CSV template download, API status.
document.addEventListener('DOMContentLoaded', async () => {
    // Auth Check — this page only makes sense once signed in.
    const token = api.getToken();
    if (!token) {
        window.location.href = '/';
        return;
    }

    let user = null;
    try {
        user = JSON.parse(localStorage.getItem('cbt_user') || 'null');
    } catch {
        user = null;
    }
    if (user?.name) document.getElementById('userName').textContent = user.name;

    document.getElementById('btnLogout').addEventListener('click', () => api.logout());

    // ── One-click CSV template download ──────────────────────────────────────
    // Same payload the admin panel offers, so users never have to navigate there
    // just to grab the template.
    const btnCsv = document.getElementById('btnDownloadCsv');
    btnCsv.addEventListener('click', () => {
        const csv = 'name,email,password\nJohn Doe,john.doe@example.com,TempPass123!\nJane Smith,jane.smith@example.com,TempPass456!';
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'student_template.csv';
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    });

    // ── API availability ─────────────────────────────────────────────────────
    // Tells the user up front whether exports will actually work, instead of
    // letting them click through to a failed request.
    const strip = document.getElementById('statusStrip');
    const text = document.getElementById('statusText');
    try {
        const res = await fetch(`${api.baseUrl}/health`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
            text.textContent = 'Connected — exports are ready to use.';
        } else {
            throw new Error(String(res.status));
        }
    } catch {
        strip.classList.add('offline');
        text.textContent = 'Cannot reach the API right now — exports may fail until it is back.';
    }
});