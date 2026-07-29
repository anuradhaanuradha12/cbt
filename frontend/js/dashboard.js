// dashboard.js - Fetches exams and populates the UI
document.addEventListener('DOMContentLoaded', async () => {
    // Auth Check
    const token = api.getToken();
    const userStr = localStorage.getItem('cbt_user');
    
    if (!token || !userStr) {
        window.location.href = 'index.html';
        return;
    }
    
    const user = JSON.parse(userStr);
    
    if (user.role === 'admin' || user.role === 'faculty') {
        window.location.href = 'admin.html';
        return;
    }
    
    // Set user info in UI
    document.getElementById('welcomeMessage').textContent = `Hello, ${user.email.split('@')[0]}`;
    document.getElementById('userAvatar').textContent = user.email.charAt(0).toUpperCase();
    
    const examGrid = document.getElementById('examGrid');
    
    try {
        // Fetch all exams
        const response = await api.request('/exams');
        const exams = Array.isArray(response) ? response : response.exams;
        
        if (exams.length === 0) {
            examGrid.innerHTML = '<p style="color: var(--text-muted)">No exams available at the moment.</p>';
            return;
        }
        
        const now = Math.floor(Date.now() / 1000);
        
        // Render exams
        examGrid.innerHTML = exams.map(exam => {
            const isUpcoming = exam.starts_at && exam.starts_at > now;
            const isEarlyAccess = exam.starts_at && (exam.starts_at - now) <= 300 && (exam.starts_at - now) > 0;
            const startsAtDate = exam.starts_at ? new Date(exam.starts_at * 1000).toLocaleString() : '';
            
            return `
            <div class="exam-card">
                <span class="badge">${exam.version > 1 ? `Version ${exam.version}` : (isUpcoming ? 'Scheduled' : 'Active')}</span>
                <h3 style="margin-bottom: 0.5rem; color: var(--text-primary);">${exam.title}</h3>
                <p style="color: var(--text-muted); font-size: 0.875rem; margin-bottom: 1.5rem;">
                    ${exam.description || 'No description provided.'}
                </p>
                <div style="display: flex; justify-content: space-between; font-size: 0.875rem; margin-bottom: 1.5rem; color: var(--text-secondary);">
                    <span>⏱ ${exam.config_snapshot?.duration_minutes || 180} mins</span>
                    <span>📝 ${exam.config_snapshot?.total_questions || '?'} Questions</span>
                </div>
                ${isUpcoming && !isEarlyAccess
                    ? `<div style="margin-bottom: 1rem; color: var(--warning); font-size: 0.875rem; font-weight: bold;">Starts: ${startsAtDate}</div>
                       <button id="btn-start-${exam.id}" class="btn-primary" disabled style="opacity: 0.5; cursor: not-allowed;">
                           Starts Soon
                       </button>`
                    : isEarlyAccess 
                    ? `<button class="btn-primary" style="background: var(--warning); border-color: var(--warning); color: #000;" onclick="window.location.href='exam.html?id=${exam.id}'">
                           Enter Waiting Room
                       </button>`
                    : `<button class="btn-primary" onclick="window.location.href='exam.html?id=${exam.id}'">
                           Start Exam
                       </button>`
                }
            </div>
            `;
        }).join('');
        
        // Setup timers to enable exams automatically
        exams.forEach(exam => {
            const isUpcoming = exam.starts_at && exam.starts_at > now;
            if (isUpcoming) {
                const msUntilEarlyAccess = (exam.starts_at - now - 300) * 1000;
                // Only set timeout if it reaches early access within next 24 hours to save memory
                if (msUntilEarlyAccess > 0 && msUntilEarlyAccess < 24 * 60 * 60 * 1000) {
                    setTimeout(() => {
                        const btn = document.getElementById(`btn-start-${exam.id}`);
                        if (btn) {
                            btn.disabled = false;
                            btn.style.opacity = '1';
                            btn.style.cursor = 'pointer';
                            btn.style.background = 'var(--warning)';
                            btn.style.borderColor = 'var(--warning)';
                            btn.style.color = '#000';
                            btn.textContent = 'Enter Waiting Room';
                            btn.onclick = () => window.location.href = `exam.html?id=${exam.id}`;
                            
                            // Remove the warning div
                            const warningDiv = btn.previousElementSibling;
                            if (warningDiv && warningDiv.textContent.includes('Starts:')) warningDiv.remove();
                        }
                    }, msUntilEarlyAccess);
                }
            }
        });
        
    } catch (error) {
        console.error(error);
        examGrid.innerHTML = `<p style="color: var(--danger)">Failed to load exams: ${error.message}</p>`;
    }

    // ==========================================
    // Tab Logic & Analytics
    // ==========================================
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');
    
    let analyticsLoaded = false;

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // Remove active from all
            tabBtns.forEach(b => b.classList.remove('active'));
            tabPanes.forEach(p => p.classList.remove('active'));
            
            // Add active to current
            btn.classList.add('active');
            const targetId = btn.getAttribute('data-tab');
            document.getElementById(`tab-${targetId}`).classList.add('active');
            
            // Load analytics if needed
            if (targetId === 'analytics' && !analyticsLoaded) {
                loadAnalytics(user.id);
            }
        });
    });

    async function loadAnalytics(studentId) {
        const loading = document.getElementById('analyticsLoading');
        const content = document.getElementById('analyticsContent');
        
        try {
            const res = await api.request(`/analytics/student/${studentId}`);
            
            // 1. Overall Stats
            const overall = res.overall || { total_exams: 0, average_score: 0, total_correct: 0, total_wrong: 0, total_unattempted: 0 };
            document.getElementById('overallStatsGrid').innerHTML = `
                <div class="stat-card">
                    <div class="stat-value">${overall.total_exams}</div>
                    <div class="stat-label">Exams Taken</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${Math.round(overall.average_score || 0)}</div>
                    <div class="stat-label">Avg. Score</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value text-indigo-600">${overall.total_correct}</div>
                    <div class="stat-label">Total Correct</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value text-red-400">${overall.total_wrong}</div>
                    <div class="stat-label">Total Wrong</div>
                </div>
            `;

            // 2. Subject Stats
            const subjectTbody = document.getElementById('subjectTableBody');
            if (res.subjects.length > 0) {
                subjectTbody.innerHTML = res.subjects.map(s => {
                    const acc = s.total_questions > 0 ? Math.round((s.total_correct / s.total_questions) * 100) : 0;
                    return `
                        <tr>
                            <td class="font-medium text-gray-900">${s.subject}</td>
                            <td>${s.total_questions}</td>
                            <td class="text-indigo-600">${s.total_correct}</td>
                            <td class="text-red-400">${s.total_wrong}</td>
                            <td>
                                <div style="display: flex; align-items: center; gap: 0.5rem;">
                                    <span>${acc}%</span>
                                    <div style="flex: 1; height: 6px; background: rgba(0,0,0,0.3); border-radius: 3px; overflow: hidden;">
                                        <div style="width: ${acc}%; height: 100%; background: ${acc > 70 ? 'var(--emerald)' : acc > 40 ? 'var(--warning)' : 'var(--danger)'};"></div>
                                    </div>
                                </div>
                            </td>
                        </tr>
                    `;
                }).join('');
            } else {
                subjectTbody.innerHTML = '<tr><td colspan="5" class="text-center text-gray-500 py-4">No data available yet</td></tr>';
            }

            // 3. Chapter Weaknesses
            const chapterTbody = document.getElementById('chapterTableBody');
            if (res.chapters.length > 0) {
                chapterTbody.innerHTML = res.chapters.map(c => {
                    const acc = c.total_questions > 0 ? Math.round((c.total_correct / c.total_questions) * 100) : 0;
                    return `
                        <tr>
                            <td class="font-medium text-gray-900">${c.chapter}</td>
                            <td class="text-gray-600 text-sm">${c.subject}</td>
                            <td>${c.total_questions}</td>
                            <td class="text-indigo-600">${c.total_correct}</td>
                            <td class="text-red-400">${c.total_wrong}</td>
                            <td>
                                <span style="color: ${acc < 50 ? 'var(--danger)' : acc < 75 ? 'var(--warning)' : 'var(--emerald)'}">${acc}%</span>
                            </td>
                        </tr>
                    `;
                }).join('');
            } else {
                chapterTbody.innerHTML = '<tr><td colspan="6" class="text-center text-gray-500 py-4">No data available yet</td></tr>';
            }

            loading.style.display = 'none';
            content.style.display = 'block';
            analyticsLoaded = true;

        } catch (error) {
            console.error(error);
            loading.innerHTML = `<span style="color: var(--danger)">Failed to load analytics: ${error.message}</span>`;
        }
    }
});
