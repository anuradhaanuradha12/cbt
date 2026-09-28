// admin.js - Admin Panel logic for creating exams & user management
document.addEventListener('DOMContentLoaded', async () => {
    // Auth Check
    const token = api.getToken();
    const userStr = localStorage.getItem('cbt_user');
    
    if (!token || !userStr) {
        window.location.href = '/';
        return;
    }
    
    const user = JSON.parse(userStr);
    if (user.role !== 'admin' && user.role !== 'faculty' && user.role !== 'principal') {
        await notify.alert("Admins, Faculty, or Principals only.", { icon: 'error', title: 'Access Denied' });
        window.location.href = '/dashboard';
        return;
    }

    // Role-based UI updates
    document.getElementById('userName').textContent = user.name;

    // Exam Approvals is visible to everyone who reaches this panel — admin and
    // faculty can submit/review at the faculty stage, principal reviews the final stage.
    const navApprovals = document.getElementById('navApprovals');
    if (navApprovals) {
        navApprovals.classList.remove('hidden');
        navApprovals.classList.add('flex');
    }

    // Notifications are for every staff role: principals receive quota alerts
    // raised when faculty submit an exam, and faculty receive the reminders the
    // principal sends back.
    const navNotifications = document.getElementById('navNotifications');
    if (navNotifications) {
        navNotifications.classList.remove('hidden');
        navNotifications.classList.add('flex');
    }

    if (user.role === 'principal') {
        // Principals create exam blueprints, review exams, and manage student passwords.
        document.querySelector('[data-tab="questions"]').classList.add('hidden');

        document.getElementById('navUsers').classList.remove('hidden');
        document.getElementById('navUsers').classList.add('flex');
        
        document.getElementById('navCreateExam').classList.remove('hidden');
        document.getElementById('navCreateExam').classList.add('flex');

        // Principals get Analytics too — the whole college ranked by marks, with
        // every subject visible, plus the topper board.
        const navAnalyticsP = document.getElementById('navAnalytics');
        if (navAnalyticsP) {
            navAnalyticsP.classList.remove('hidden');
            navAnalyticsP.classList.add('flex');
        }

        setTimeout(() => navApprovals.click(), 10);
    } else {
        // Analytics is visible to admin and faculty.
        const navAnalytics = document.getElementById('navAnalytics');
        if (navAnalytics) {
            navAnalytics.classList.remove('hidden');
            navAnalytics.classList.add('flex');
        }

        if (user.role === 'admin') {
            document.getElementById('navUsers').classList.remove('hidden');
            document.getElementById('navUsers').classList.add('flex');
            
            document.getElementById('navCreateExam').classList.remove('hidden');
            document.getElementById('navCreateExam').classList.add('flex');

            // Admins no longer fill exams — faculty are the sole question selectors.
            // Question Bank stays browsable (read-only), but the Exam Draft
            // panel is faculty-only, so hide it here.
            const questionsGrid = document.querySelector('#tab-questions .grid');
            if (questionsGrid) {
                questionsGrid.classList.remove('lg:grid-cols-[1fr_400px]');
                questionsGrid.classList.add('grid-cols-1');
                questionsGrid.children[1].style.display = 'none';
            }
        } else if (user.subject) {
            const subjectBadge = document.getElementById('userSubject');
            subjectBadge.textContent = `(${user.subject})`;
            subjectBadge.classList.remove('hidden');

            // Faculty can still use Pending Tasks (auto-fill quotas) alongside
            // full exam creation below — both stay available, neither is forced.
            const navTasks = document.getElementById('navTasks');
            navTasks.classList.remove('hidden');
            navTasks.classList.add('flex');

            // Faculty are locked to their own subject — the backend enforces it
            // (403 on anything else), so lock the filter to match.
            const filterSubject = document.getElementById('filterSubject');
            if (filterSubject) {
                filterSubject.value = user.subject.toLowerCase();
                filterSubject.disabled = true;
                filterSubject.title = 'Your account is locked to this subject';
                filterSubject.classList.add('opacity-70', 'cursor-not-allowed');
                setTimeout(() => filterSubject.dispatchEvent(new Event('change')), 0);
            }

            // Default to Pending Tasks tab for Faculty
            setTimeout(() => {
                const navTasks = document.querySelector('[data-tab="tasks"]');
                if (navTasks) navTasks.click();
            }, 10);
        }
    }

    // Tab Switching Logic
    const navLinks = document.querySelectorAll('.nav-link');
    const tabPanes = document.querySelectorAll('.tab-pane');

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            
            // Handle Link Styles
            navLinks.forEach(l => {
                l.classList.remove('bg-indigo-500/10', 'text-indigo-400');
                l.classList.add('text-gray-600', 'hover:text-gray-900', 'hover:bg-white/50');
            });
            const clickedLink = e.currentTarget;
            clickedLink.classList.remove('text-gray-600', 'hover:text-gray-900', 'hover:bg-white/50');
            clickedLink.classList.add('bg-indigo-500/10', 'text-indigo-400');
            
            // Handle Panes
            tabPanes.forEach(p => p.classList.remove('active'));
            const tabId = clickedLink.getAttribute('data-tab');
            document.getElementById(`tab-${tabId}`).classList.add('active');
            
            if (tabId === 'tasks') {
                loadTasks(user);
            }
            if (tabId === 'approvals') {
                loadApprovals();
            }
            if (tabId === 'notifications') {
                loadNotifications();
            }
            if (tabId === 'analytics') {
                // Faculty have no User Management tab, so the roster is the only
                // way into analytics for them. Principals get the class-wide view.
                showAnalyticsHome();
            }
        });
    });

    // ── Sweet quota messages (shared) ─────────────────────────
    // One styled popup used at every quota touchpoint. Subject-scoped:
    // faculty see ONLY their own subject's rows — never other subjects'
    // data. Admins/principals see the full blueprint board.
    //   showQuotaSweet({ complete, rows })  rows: [{label, have, need}]
    function showQuotaSweet({ complete, rows, afterSave = false }) {
        // Scope to the faculty's own subject when applicable.
        const mySub = (user.subject || '').toLowerCase().trim();
        const isFaculty = user.role === 'faculty' && !!mySub;
        let scoped = rows;
        let scopedComplete = complete;
        let waitingOnOthers = false;
        if (isFaculty) {
            const mine = rows.filter(r => (r.label || '').toLowerCase().trim() === mySub);
            if (mine.length) {
                scoped = mine;
                scopedComplete = mine.every(r => r.have >= r.need);
                waitingOnOthers = scopedComplete && !complete;
            } else {
                // Gap lists only include UNMET subjects — if the faculty's own
                // subject isn't listed, their part is already done.
                scoped = [];
                scopedComplete = true;
                waitingOnOthers = !complete;
            }
        }
        const rowsHtml = scoped.map(r => {
            const done = r.have >= r.need;
            return `<tr>
                <td style="padding:6px 14px;text-align:left;font-weight:600;color:#374151;">${r.label}</td>
                <td style="padding:6px 14px;text-align:center;font-weight:800;color:${done ? '#059669' : '#b45309'};white-space:nowrap;">${r.have}/${r.need}</td>
                <td style="padding:6px 14px;text-align:center;">${done ? '✅' : '⏳'}</td>
            </tr>`;
        }).join('');
        return window.Swal.fire({
            icon: scopedComplete ? 'success' : 'warning',
            title: scopedComplete
                ? (waitingOnOthers ? '✅ Your Subject is Complete!'
                    : (afterSave ? '🎉 Task Complete — All Quotas Filled!' : '✅ All Subjects Complete!'))
                : (afterSave ? '💾 Progress Saved — Task Incomplete' : '⏳ Task Incomplete'),
            html: `
                <table style="margin:8px auto 4px;border-collapse:collapse;min-width:280px;">
                    <thead><tr>
                        <th style="padding:4px 14px;font-size:.8em;color:#6b7280;text-transform:uppercase;">Subject / Chapter</th>
                        <th style="padding:4px 14px;font-size:.8em;color:#6b7280;text-transform:uppercase;">Filled</th>
                        <th style="padding:4px 14px;font-size:.8em;color:#6b7280;text-transform:uppercase;">Status</th>
                    </tr></thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
                <p style="margin-top:6px;font-size:.9em;color:#6b7280;">${
                    scopedComplete
                        ? (waitingOnOthers
                            ? 'Your part is done. The exam can be submitted to the principal once every subject\u2019s quota is filled.'
                            : (afterSave ? 'Everything is saved. You can submit this exam to the principal.' : 'Ready to submit to the principal for review.'))
                        : 'Your subject\u2019s quota must be filled before this exam can be submitted.'
                }</p>`,
            confirmButtonText: scopedComplete ? 'Great!' : 'Continue Filling',
            confirmButtonColor: scopedComplete ? '#059669' : '#4f46e5',
            // Auto-dismiss: a sweet message informs, it never traps the user.
            timer: 5000,
            timerProgressBar: true,
        });
    }

    // Live quota board for the active blueprint across ALL subjects, fetched
    // from the server so numbers always match what the principal will see.
    async function fetchQuotaBoard(examId) {
        try {
            const status = await api.request(`/exams/${examId}/quota-status`);
            return {
                complete: !!status.complete,
                rows: (status.subjects || []).map(s => ({ label: s.subject, have: s.selected, need: s.required })),
            };
        } catch {
            return null; // endpoint hiccup → fall back to local-only rows
        }
    }

    window.selectBlueprint = async function(examId, title, quotaStr, difficulty) {
        window.activeBlueprintId = examId;
        window.activeBlueprintSubject = user.subject ? user.subject.toLowerCase() : '';
        window.activeBlueprintDifficulty = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : 'medium';
        document.getElementById('facultyDraftTitle').textContent = `${title} (${window.activeBlueprintDifficulty})`;
        
        let allowedChapters = [];
        window.activeBlueprintQuotas = null;
        try {
            const quotas = JSON.parse(quotaStr);
            const myQuotas = quotas[user.subject.toLowerCase()] || {};
            window.activeBlueprintQuotas = myQuotas;
            for (const chapter of Object.keys(myQuotas)) {
                allowedChapters.push(chapter);
            }
        } catch (e) {
            console.error('Failed to parse quotas', e);
        }
        
        renderTargetQuota();
        
        const btnSave = document.getElementById('btnSaveQuestions');
        if (btnSave) btnSave.classList.remove('hidden');

        // Auto Generate is only meaningful once a blueprint is active — it needs
        // the per-chapter quotas to know how many questions to pull.
        const autoBox = document.getElementById('autoGenerateBox');
        if (autoBox) autoBox.classList.remove('hidden');

        // Lock filters to only show what is assigned
        const filterSubject = document.getElementById('filterSubject');
        const filterChapter = document.getElementById('filterChapter');
        const filterDifficulty = document.getElementById('filterDifficulty');
        
        if (filterSubject) {
            filterSubject.value = user.subject.toLowerCase();
            filterSubject.disabled = true;
        }
        
        if (filterDifficulty) {
            filterDifficulty.value = '';
            filterDifficulty.disabled = true;
        }
        
        if (filterChapter) {
            console.log("RESTRICTING CHAPTERS TO:", allowedChapters);
            filterChapter.innerHTML = '<option value="">Assigned Chapters</option>';
            allowedChapters.forEach(chap => {
                const opt = document.createElement('option');
                opt.value = chap;
                opt.textContent = chap;
                filterChapter.appendChild(opt);
            });
        }
        
        selectedQuestions = [];
        renderDraftList();
        
        // Switch to questions tab and load restricted questions
        document.querySelector('[data-tab="questions"]').click();
        setTimeout(loadQuestions, 100);

        // Reflect what this exam already has for my subject. Without this the
        // panel opens at "0 Qs" even when the quota is already filled, so the
        // faculty fills it a second time and saving trips the quota guard.
        try {
            const payload = await api.request(`/exams/${examId}`);
            const mine = (payload.questions || []).filter(
                q => (q.subject || '').toLowerCase() === user.subject.toLowerCase()
            );
            if (mine.length) {
                selectedQuestions = mine.map(q => ({
                    id: q.id,
                    subject: q.subject,
                    chapter: q.chapter,
                    question_text: q.question_text,
                    _saved: true,
                }));
                renderDraftList();
                // Sweet status board on open: ALL subjects' completion state.
                // Fire-and-forget — it auto-dismisses and never blocks the panel.
                fetchQuotaBoard(examId).then(board => {
                    if (board && board.rows.length) showQuotaSweet({ complete: board.complete, rows: board.rows });
                });
                await loadQuestions();
            }
        } catch (e) {
            console.error('Could not load the exam\u2019s existing questions:', e);
        }
    };

    async function loadTasks(user) {
        const tasksList = document.getElementById('tasksList');
        tasksList.innerHTML = '<div class="text-gray-600 text-center animate-pulse py-8">Loading tasks...</div>';
        
        try {
            const res = await api.request('/exams');
            const exams = res
                .map(e => {
                    let quotas = {};
                    try { quotas = JSON.parse(e.chapter_quotas); } catch (err) {}
                    return { ...e, quotas };
                })
                .filter(e => {
                    if (e.status === 'published' || e.status === 'ongoing' || e.status === 'completed') return false;
                    if (!e.quotas) return false;
                    const mySubject = user.subject ? user.subject.toLowerCase() : null;
                    return mySubject && e.quotas[mySubject];
                });

            if (exams.length === 0) {
                tasksList.innerHTML = '<p class="text-gray-500 text-sm text-center py-8 italic bg-gray-50/30 rounded-lg border border-dashed border-gray-200">No pending tasks found for your subject.</p>';
                return;
            }            // How much of each task's subject quota this faculty has already saved.
            const done = await window.quotaDoneByExam();

            tasksList.innerHTML = exams.map(exam => {
                const mySubject = user.subject.toLowerCase();
                const myQuotas = exam.quotas[mySubject];
                let quotaDetails = '';
                let requiredTotal = 0;
                let savedTotal = (done[exam.id] || 0);
                for (const [chapter, count] of Object.entries(myQuotas)) {
                    quotaDetails += `<span class="px-2 py-1 bg-gray-100 rounded text-xs text-gray-700">${chapter}: ${count}</span> `;
                    requiredTotal += count;
                }
                const completed = requiredTotal > 0 && savedTotal >= requiredTotal;
                const progressChip = `
                    <span class="text-xs font-semibold px-2.5 py-1 rounded-full border ${completed
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-amber-50 text-amber-700 border-amber-200'}">${completed ? '✓ Task completed' : `${savedTotal}/${requiredTotal} filled`}</span>`;

                // Once submitted, the task is with the principal — offering the
                // button again would let the same exam be resubmitted (re-sending
                // the audit notifications) and misrepresent it as still pending.
                const awaitingPrincipal = exam.status === 'pending_principal_review';
                const submitBtn = completed && !awaitingPrincipal
                    ? `<button onclick="submitTaskToPrincipal('${exam.id}', '${exam.title.replace(/'/g, "\\'").replace(/"/g, '&quot;')}')" class="bg-emerald-600 hover:bg-emerald-700 text-white font-medium rounded-lg text-sm px-4 py-2 transition-colors flex items-center gap-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path></svg>
                            Submit to Principal
                        </button>`
                    : '';

                return `

                <div class="p-5 bg-white/50 rounded-xl border ${completed ? 'border-emerald-300' : 'border-gray-300 hover:border-amber-500/50'} transition-colors">
                    <div class="mb-2 flex justify-between items-start">
                        <div>
                            <h3 class="text-lg font-semibold text-gray-900">${exam.title}</h3>
                            <p class="text-sm text-gray-600 mt-1">${exam.description || 'No description'}</p>
                        </div>
                        <div class="flex flex-col items-end gap-2">
                            ${progressChip}
                            ${awaitingPrincipal ? `<span class="text-xs font-semibold px-2.5 py-1 rounded-full border bg-blue-50 text-blue-700 border-blue-200">Submitted — awaiting principal review</span>` : ''}
                            <div class="flex gap-2">
                                <button onclick="selectBlueprint('${exam.id}', '${exam.title.replace(/'/g, "\\'").replace(/"/g, '&quot;')}', '${exam.chapter_quotas.replace(/'/g, "\\'").replace(/"/g, '&quot;')}', '${(exam.difficulty || 'medium')}')" class="bg-amber-600 hover:bg-amber-700 text-white font-medium rounded-lg text-sm px-4 py-2 transition-colors flex items-center gap-2">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"></path></svg>
                                    Fulfill Quota
                                </button>
                                ${submitBtn}
                            </div>
                        </div>
                    </div>
                    <div class="mt-3 pt-3 border-t border-gray-200 flex flex-wrap gap-2">
                        <span class="px-2 py-1 bg-indigo-50 rounded text-xs text-indigo-700 font-semibold capitalize">Difficulty: ${exam.difficulty || 'medium'}</span>
                        ${quotaDetails}
                    </div>
                </div>
                `;
            }).join('');

        } catch (error) {
            tasksList.innerHTML = `<p class="text-red-400 text-sm">Failed to load tasks: ${error.message}</p>`;
        }
    }

    // ==========================================
    // Exam Approvals: submit-for-review, principal-review
    // Flow: faculty completes the task -> submits -> PRINCIPAL gives the final
    // approval, which publishes immediately. Students then see the exam.
    // ('pending_final_confirmation' rows are legacy and admin-cleanable only.)
    // ==========================================

    const STATUS_BADGE = {
        draft: { label: 'Draft', cls: 'bg-gray-200 text-gray-700 border-gray-300' },
        pending_principal_review: { label: 'Awaiting Principal Review', cls: 'bg-blue-500/20 text-blue-600 border-blue-500/30' },
        pending_final_confirmation: { label: 'Awaiting Final Publish Confirmation', cls: 'bg-amber-500/20 text-amber-600 border-amber-500/30' },
        rejected: { label: 'Rejected', cls: 'bg-red-500/20 text-red-600 border-red-500/30' },
        published: { label: 'Published', cls: 'bg-emerald-500/20 text-emerald-600 border-emerald-500/30' },
    };

    const REJECTION_STAGE_LABEL = { principal: 'principal review', faculty_final: 'final publish confirmation' };

    function badge(status) {
        const b = STATUS_BADGE[status] || { label: status, cls: 'bg-gray-200 text-gray-700 border-gray-300' };
        return `<span class="px-3 py-1 text-xs font-bold rounded-full border ${b.cls}">${b.label}</span>`;
    }

    window.loadApprovals = async function () {
        const list = document.getElementById('approvalsList');
        list.innerHTML = '<div class="text-gray-600 text-center animate-pulse py-8">Loading...</div>';

        try {
            const exams = await api.request('/exams');            const relevant = exams.filter(e => {
                const isMine = e.created_by === user.id;
                // The final-publish gate belongs to the faculty who SUBMITTED the
                // exam (or its creator for legacy rows) — not to every faculty in
                // the college. A chemistry faculty must never be asked to confirm
                // a physics exam.
                const submitter = e.faculty_reviewed_by || e.created_by;
                const iCanPrincipalReview = (user.role === 'principal' || user.role === 'admin') && e.status === 'pending_principal_review';
                // Legacy only: pre-restructure rows stuck at final confirmation are
                // an admin cleanup item — the new flow never produces this state.
                const iCanFinalConfirm = user.role === 'admin' && e.status === 'pending_final_confirmation';
                const iCanSubmit = isMine && (e.status === 'draft' || e.status === 'rejected');
                const isMineAndPending = isMine && e.status === 'pending_principal_review';
                return iCanPrincipalReview || iCanFinalConfirm || iCanSubmit || isMineAndPending;
            });

            if (relevant.length === 0) {
                list.innerHTML = '<p class="text-gray-500 text-sm text-center py-8 italic bg-gray-50/30 rounded-lg border border-dashed border-gray-200">Nothing needs your attention right now.</p>';
                return;
            }

            list.innerHTML = relevant.map(exam => {
                const isMine = exam.created_by === user.id;
                let actions = '';

                if (isMine && (exam.status === 'draft' || exam.status === 'rejected')) {
                    actions = `
                        <button onclick="submitForReview('${exam.id}')" class="bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg text-sm px-4 py-2 transition-colors">
                            Submit Exam
                        </button>`;
                } else if ((user.role === 'principal' || user.role === 'admin') && exam.status === 'pending_principal_review') {
                    actions = `
                        <button onclick="reviewExam('${exam.id}', 'principal', 'approve')" class="bg-emerald-600 hover:bg-emerald-700 text-white font-medium rounded-lg text-sm px-4 py-2 transition-colors">Approve &amp; Publish</button>
                        <button onclick="reviewExam('${exam.id}', 'principal', 'reject')" class="bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg text-sm px-4 py-2 transition-colors">Reject</button>`;
                } else if (user.role === 'admin' && exam.status === 'pending_final_confirmation') {
                    // Legacy rows only — kept so an admin can still clear them.
                    actions = `
                        <button onclick="reviewExam('${exam.id}', 'final', 'submit')" class="bg-emerald-600 hover:bg-emerald-700 text-white font-medium rounded-lg text-sm px-4 py-2 transition-colors">Submit &amp; Publish (legacy)</button>
                        <button onclick="reviewExam('${exam.id}', 'final', 'reject')" class="bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg text-sm px-4 py-2 transition-colors">Reject</button>`;
                }

                const rejectionNote = exam.status === 'rejected' && exam.rejection_reason
                    ? `<p class="text-xs text-red-600 mt-2">Rejected at ${REJECTION_STAGE_LABEL[exam.rejection_stage] || '?'}: ${exam.rejection_reason}</p>`
                    : (exam.status === 'rejected' ? `<p class="text-xs text-red-600 mt-2">Rejected at ${REJECTION_STAGE_LABEL[exam.rejection_stage] || '?'} (no reason given).</p>` : '');

                return `
                <div class="p-5 bg-white/50 rounded-xl border border-gray-300 hover:border-emerald-500/50 transition-colors">
                    <div class="flex justify-between items-start mb-3 gap-4">
                        <div>
                            <h3 class="text-lg font-semibold text-gray-900">${exam.title}</h3>
                            <p class="text-sm text-gray-600 mt-1">${exam.description || 'No description'}</p>
                            ${rejectionNote}
                        </div>
                        ${badge(exam.status)}
                    </div>
                    <div class="mt-4 flex gap-3">
                        ${actions || '<span class="text-sm text-gray-500 italic">Waiting on someone else — no action for you here.</span>'}
                    </div>
                </div>
                `;
            }).join('');

        } catch (error) {
            list.innerHTML = `<p class="text-red-400 text-sm">Failed to load: ${error.message}</p>`;
        }
    };

    window.submitForReview = async function (examId) {
        const confirmed = await notify.confirm('Submit this exam?', { confirmText: 'Submit' });
        if (!confirmed) return;
        try {
            await api.request(`/exams/${examId}/submit-for-review`, 'POST');
            notify.success('Exam submitted.');
            loadApprovals();
        } catch (error) {
            if (error && error.quota_gaps) {
                window.Swal.fire({
                    icon: 'warning',
                    title: 'Task incomplete',
                    html: `Every subject's quota must be filled before submitting:<br><b>` +
                        error.quota_gaps.map(g => `${g.subject}: ${g.selected}/${g.required}`).join('<br>') + `</b>`,
                    confirmButtonText: 'Got it',
                    confirmButtonColor: '#4f46e5',
                });
            } else {
                notify.error('Failed to submit: ' + error.message);
            }
        }
    };

    // stage: 'principal' -> PUT /exams/:id/principal-review, decision 'approve'|'reject'
    // stage: 'final'     -> PUT /exams/:id/final-review, decision 'submit'|'reject'
    window.reviewExam = async function (examId, stage, decision) {
        const endpoint = `/exams/${examId}/${stage}-review`;

        if (decision === 'reject') {
            const reason = await notify.prompt('Reason for rejection (optional):', { title: 'Reject Exam' });
            if (reason === null) return; // cancelled
            try {
                await api.request(endpoint, 'PUT', { decision: 'reject', reason });
                notify.success('Exam rejected.');
                loadApprovals();
            } catch (error) {
                notify.error('Failed to reject: ' + error.message);
            }
            return;
        }

        if (stage === 'principal') {
            const confirmed = await notify.confirm('Approve and PUBLISH this exam? Students will see it immediately — the principal\u2019s approval is the final step.', { title: 'Final Approval', confirmText: 'Approve & Publish' });
            if (!confirmed) return;
            try {
                await api.request(endpoint, 'PUT', { decision: 'approve' });
                notify.success('Final approval given — the exam is now live for students.');
                loadApprovals();
            } catch (error) {
                notify.error('Failed to approve: ' + error.message);
            }
            return;
        }

        // Final confirmation (faculty) — this is what actually publishes it, so it needs a start time.
        const defaultStart = new Date(Date.now() + 5 * 60 * 1000);
        defaultStart.setSeconds(0, 0);
        const defaultStartLocal = new Date(defaultStart.getTime() - defaultStart.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

        const startsAtLocal = await notify.prompt('When should this exam start?', {
            title: 'Submit & Publish',
            input: 'datetime-local',
            defaultValue: defaultStartLocal,
        });
        if (startsAtLocal === null) return; // cancelled
        const startsAt = startsAtLocal ? Math.floor(new Date(startsAtLocal).getTime() / 1000) : undefined;

        try {
            await api.request(endpoint, 'PUT', { decision: 'submit', starts_at: startsAt });
            notify.success('Exam published — students can now see it.');
            loadApprovals();
        } catch (error) {
            notify.error('Failed to publish: ' + error.message);
        }
    };

    // Make startAutoSelect available globally for the inline onclick handler
    window.startAutoSelect = async (examId, subject, count) => {
        if (!subject) {
            notify.warning('Admin users must select a subject first (not implemented in this prototype).');
            return;
        }

        // Ask for chapters
        const chaptersStr = await notify.prompt(`Enter chapters for ${subject} (comma separated) to auto-select ${count} questions:`, { title: 'Auto-Select Questions' });
        if (!chaptersStr) return;
        const chapters = chaptersStr.split(',').map(s => s.trim()).filter(Boolean);
        if (chapters.length === 0) return;

        try {
            const previewRes = await api.request(`/exams/${examId}/auto-select-preview`, 'POST', {
                subject, chapters, count
            });

            if (previewRes.length === 0) {
                notify.warning('No questions found for the given criteria.');
                return;
            }

            const confirmed = await notify.confirm(`Found ${previewRes.length} questions (some might be previously used). Do you want to add them to this exam?`, { confirmText: 'Add Them' });
            if (confirmed) {
                await api.request(`/exams/${examId}/questions`, 'PUT', {
                    question_ids: previewRes.map(q => ({ id: q.id, marks: 4, negative_marks: 1 }))
                });
                notify.success('Successfully filled your quota for this exam!');
                loadTasks(user);
            }
        } catch (error) {
            notify.error('Failed auto-select: ' + error.message);
        }
    };

    // State Variables
    let currentPage = 1;
    const limit = 20;
    let selectedQuestions = []; // Array of question objects

    // DOM Elements
    const questionsContainer = document.getElementById('questionsContainer');
    const loadingIndicator = document.getElementById('loadingIndicator');
    const pageInfo = document.getElementById('pageInfo');
    const draftList = document.getElementById('draftList');
    const draftCount = document.getElementById('draftCount');
    
    // Filters
    const filterSubject = document.getElementById('filterSubject');
    const filterChapter = document.getElementById('filterChapter');
    const filterDifficulty = document.getElementById('filterDifficulty');
    const btnSearch = document.getElementById('btnSearch');

    // Show real counts on the difficulty filter so it's obvious upfront that
    // 'easy' barely exists and 'hard' is thin — the bank is ~99% 'medium'.
    if (user.role !== 'principal') {
        (async () => {
            try {
                const [easy, medium, hard] = await Promise.all([
                    api.request('/questions?difficulty=easy&limit=1'),
                    api.request('/questions?difficulty=medium&limit=1'),
                    api.request('/questions?difficulty=hard&limit=1'),
                ]);
                const fmt = n => n.toLocaleString();
                document.getElementById('optDifficultyEasy').textContent = `Easy (${fmt(easy.total)})`;
                document.getElementById('optDifficultyMedium').textContent = `Medium (${fmt(medium.total)})`;
                document.getElementById('optDifficultyHard').textContent = `Hard (${fmt(hard.total)})`;
            } catch (e) {
                console.error('Failed to load difficulty counts:', e);
            }
        })();
    }
    
    // Pagination
    const btnPrevPage = document.getElementById('btnPrevPage');
    const btnNextPage = document.getElementById('btnNextPage');

    // Create Exam
    const btnCreateExam = document.getElementById('btnCreateExam');

    // CSV Upload
    const csvFileInput = document.getElementById('csvFileInput');
    const csvFileName = document.getElementById('csvFileName');
    const btnUploadCsv = document.getElementById('btnUploadCsv');
    const csvUploadStatus = document.getElementById('csvUploadStatus');

    // ==========================================
    // CSV File Selection
    // ==========================================
    csvFileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            csvFileName.textContent = e.target.files[0].name;
            csvFileName.classList.add('text-indigo-600');
        } else {
            csvFileName.textContent = 'or drag and drop';
            csvFileName.classList.remove('text-indigo-600');
        }
    });

    // ==========================================
    // Fetch and Render Questions
    // ==========================================

    // Guard against stale loads: a slow UNRESTRICTED boot-time question fetch
    // can resolve AFTER selectBlueprint's restricted load and overwrite the
    // panel with chapters the faculty was never assigned — the add handler
    // then rejects every click. Each load claims a token; only the newest
    // render may touch the DOM.
    let questionLoadToken = 0;

    async function loadQuestions() {
        const myToken = ++questionLoadToken;
        loadingIndicator.classList.remove('hidden');
        loadingIndicator.classList.add('flex');
        questionsContainer.innerHTML = '';
        
        const subject = filterSubject.value;
        const chapter = filterChapter.value;
        const difficulty = filterDifficulty.value;
        
        let query = `/questions?page=${currentPage}&limit=${limit}`;
        if (subject) query += `&subject=${subject}`;
        
        let targetChapter = chapter;
        if (!targetChapter) {
            if (window.activeBlueprintQuotas) {
                targetChapter = Object.keys(window.activeBlueprintQuotas).join(',');
            } else if (window.globalAssignedChapters && window.globalAssignedChapters.length > 0) {
                targetChapter = window.globalAssignedChapters.join(',');
            }
        }
        if (targetChapter) query += `&chapter=${encodeURIComponent(targetChapter)}`;
        if (difficulty) query += `&difficulty=${difficulty}`;

        try {
            const response = await api.request(query);
            if (myToken !== questionLoadToken) return; // a newer load superseded this one
            loadingIndicator.classList.add('hidden');
            loadingIndicator.classList.remove('flex');
            
            if (response.data.length === 0) {
                // The question bank is overwhelmingly 'medium' difficulty (~99%) —
                // 'easy' barely exists and 'hard' is thin and unevenly spread across
                // chapters, so a specific chapter + non-medium difficulty combo
                // often has zero matches. Say so instead of just "not found".
                const hint = difficulty && difficulty !== 'medium'
                    ? ` Note: this question bank is almost entirely "medium" difficulty — try that instead, or clear the difficulty filter.`
                    : '';
                questionsContainer.innerHTML = `<p class="text-gray-500 text-sm text-center py-8 italic bg-gray-50/30 rounded-lg border border-dashed border-gray-200">No questions found for this combination.${hint}</p>`;
                return;
            }
            
            pageInfo.textContent = `Page ${currentPage} of ${Math.ceil(response.total / limit) || 1}`;
            btnPrevPage.disabled = currentPage === 1;
            btnNextPage.disabled = currentPage >= Math.ceil(response.total / limit);
            
            response.data.forEach(q => {
                const isSelected = selectedQuestions.some(sq => sq.id === q.id);
                
                // Usage badge — "already selected" signal: flags questions that
                // have already appeared in a published exam, with the exam title
                // and date so faculty can avoid accidental repeats.
                let usageHtml = '';
                const pu = q.previously_used;
                if (pu && pu.used) {
                    const usedDate = pu.last_used_at ? new Date(pu.last_used_at * 1000).toLocaleDateString() : '';
                    usageHtml = `<span class="text-xs font-semibold px-2 py-1 rounded bg-amber-100 text-amber-700 border border-amber-300" title="Used ${pu.times_used} time(s) before${pu.last_exam_title ? ` — last in '${pu.last_exam_title}'` : ''}">↻ Repeated${usedDate ? ` · ${usedDate}` : ''}</span>`;
                }
                
                const card = document.createElement('div');
                card.dataset.qid = q.id;   // lets the blueprint panel jump to this card
                card.className = `p-4 rounded-xl border transition-colors relative ${isSelected ? 'bg-indigo-500/10 border-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.1)]' : 'bg-gray-50 border-gray-200 hover:border-gray-300'}`;
                
                // Format options
                let optionsHtml = '';
                if (q.option_a && q.option_b) {
                    optionsHtml = `
                        <div class="grid grid-cols-2 gap-2 mt-3 text-sm text-gray-600">
                            <div class="bg-white/50 p-2 rounded border border-gray-300"><strong class="text-gray-700">A)</strong> ${api.renderRichText(q.option_a)}</div>
                            <div class="bg-white/50 p-2 rounded border border-gray-300"><strong class="text-gray-700">B)</strong> ${api.renderRichText(q.option_b)}</div>
                            ${q.option_c ? `<div class="bg-white/50 p-2 rounded border border-gray-300"><strong class="text-gray-700">C)</strong> ${api.renderRichText(q.option_c)}</div>` : ''}
                            ${q.option_d ? `<div class="bg-white/50 p-2 rounded border border-gray-300"><strong class="text-gray-700">D)</strong> ${api.renderRichText(q.option_d)}</div>` : ''}
                        </div>
                    `;
                }

                // Solution block (hidden by default)
                let solutionHtml = '';
                if (q.correct_answer || q.explanation) {
                    // Light theme: readable slate body on a soft indigo tint,
                    // emerald accents for the answer line.
                    solutionHtml = `
                        <div class="solution-block hidden mt-4 p-4 bg-indigo-50 border border-indigo-100 rounded-lg text-sm">
                            <div class="font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1 inline-block mb-2">Correct Answer: ${q.correct_answer ? q.correct_answer.toUpperCase() : '—'}</div>
                            ${q.explanation ? `<div class="text-gray-800 leading-relaxed mt-2 whitespace-pre-wrap">${api.renderRichText(q.explanation)}</div>` : ''}
                            ${q.explanation_image_r2_key ? `<img src="/images/${q.explanation_image_r2_key}?v=${q.updated_at ?? ''}" class="mt-3 max-h-48 rounded border border-gray-200 bg-white" alt="Solution Image" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'[image unavailable — hard-refresh: Ctrl+Shift+R]',className:'text-xs text-gray-400'}))">` : ''}
                        </div>
                    `;
                }
                
                card.innerHTML = `
                    <div class="flex gap-2 flex-wrap mb-3 pr-24">
                        <span class="text-xs font-semibold px-2 py-1 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">${q.subject}</span>
                        <span class="text-xs font-semibold px-2 py-1 rounded bg-white text-gray-700 border border-gray-300">${q.difficulty}</span>
                        <span class="text-xs font-semibold px-2 py-1 rounded bg-white text-gray-700 border border-gray-300">${q.type}</span>
                        ${usageHtml}
                    </div>
                    
                    ${(user.role === 'admin' || (user.role === 'faculty' && window.activeBlueprintId)) ? `
                    <button class="add-btn absolute top-4 right-4 text-xs font-semibold px-4 py-2 rounded-lg transition-all border shadow-md ${isSelected ? 'bg-indigo-600/20 text-indigo-400 border-indigo-500/30 hover:bg-indigo-600/30' : 'bg-white text-gray-700 border-gray-300 hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-300'}">
                        ${isSelected ? '✓ Added' : '+ Add'}
                    </button>
                    ` : (user.role === 'faculty' ? `<span class="absolute top-4 right-4 text-xs font-semibold px-4 py-2 rounded-lg bg-gray-100 text-gray-500 border border-gray-200 cursor-not-allowed" title="Select a blueprint from Pending Tasks first">Select Blueprint First</span>` : '')}

                    <div class="text-sm text-gray-900 mt-2 font-medium leading-relaxed">${api.renderRichText(q.question_text)}</div>
                    ${q.image_r2_key ? `<img src="/images/${q.image_r2_key}?v=${q.updated_at ?? ''}" class="mt-3 max-h-48 rounded border border-gray-300" alt="Question Image" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'[image unavailable — hard-refresh: Ctrl+Shift+R]',className:'text-xs text-gray-400'}))">` : ''}
                    
                    ${optionsHtml}
                    
                    ${solutionHtml ? `
                        <div class="mt-3 flex justify-between items-center border-t border-gray-200 pt-3">
                            <button class="toggle-solution text-xs font-medium text-indigo-600 hover:text-emerald-300 transition-colors flex items-center gap-1">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                                <span>Show Solution</span>
                            </button>
                        </div>
                        ${solutionHtml}
                    ` : ''}
                `;
                
                const addBtn = card.querySelector('.add-btn');
                if (addBtn) addBtn.onclick = () => toggleQuestion(q, card, addBtn);
                
                const toggleBtn = card.querySelector('.toggle-solution');
                if (toggleBtn) {
                    toggleBtn.onclick = () => {
                        const block = card.querySelector('.solution-block');
                        const span = toggleBtn.querySelector('span');
                        if (block.classList.contains('hidden')) {
                            block.classList.remove('hidden');
                            span.textContent = 'Hide Solution';
                        } else {
                            block.classList.add('hidden');
                            span.textContent = 'Show Solution';
                        }
                    };
                }
                
                questionsContainer.appendChild(card);
            });
            
            if (window.renderMathInElement) {
                renderMathInElement(document.body, {
                    delimiters: [
                        {left: '$$', right: '$$', display: true},
                        {left: '$', right: '$', display: false},
                        {left: '\\(', right: '\\)', display: false},
                        {left: '\\[', right: '\\]', display: true}
                    ],
                    throwOnError: false
                });
            }
            
        } catch (error) {
            loadingIndicator.classList.add('hidden');
            loadingIndicator.classList.remove('flex');
            questionsContainer.innerHTML = `<p class="text-red-400 text-center text-sm bg-red-500/10 p-4 rounded-lg border border-red-500/20">Error: ${error.message}</p>`;
        }
    }

    // ==========================================
    // Draft Management
    // ==========================================

    function toggleQuestion(question, cardElement, btnElement) {
        const existingIndex = selectedQuestions.findIndex(sq => sq.id === question.id);
        
        if (existingIndex >= 0) {
            selectedQuestions.splice(existingIndex, 1);
            cardElement.className = 'p-4 rounded-xl border transition-colors relative bg-gray-50 border-gray-200 hover:border-gray-300';
            btnElement.className = 'add-btn absolute top-4 right-4 text-xs font-semibold px-4 py-2 rounded-lg transition-all border shadow-md bg-white text-gray-700 border-gray-300 hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-300';
            btnElement.textContent = '+ Add';
        } else {
            // Check quota if we are fulfilling an active blueprint
            if (window.activeBlueprintId && window.activeBlueprintQuotas) {
                // Calculate total quota for the subject
                let totalSubjectQuota = 0;
                for (const count of Object.values(window.activeBlueprintQuotas)) {
                    totalSubjectQuota += count;
                }
                
                if (selectedQuestions.length >= totalSubjectQuota) {
                    notify.warning(`You have already reached the total required questions (${totalSubjectQuota}) for this subject. You cannot add more.`);
                    return;
                }

                const chapterQuota = window.activeBlueprintQuotas[question.chapter];
                if (chapterQuota !== undefined) {
                    const currentCount = selectedQuestions.filter(sq => sq.chapter === question.chapter).length;
                    if (currentCount >= chapterQuota) {
                        notify.warning(`You have already selected the maximum required questions (${chapterQuota}) for chapter "${question.chapter}".`);
                        return;
                    }
                } else {
                    notify.warning(`Chapter "${question.chapter}" is not assigned to you in this blueprint.`);
                    return;
                }
            }

            selectedQuestions.push(question);
            cardElement.className = 'p-4 rounded-xl border transition-colors relative bg-indigo-500/10 border-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.1)]';
            btnElement.className = 'add-btn absolute top-4 right-4 text-xs font-semibold px-4 py-2 rounded-lg transition-all border shadow-md bg-indigo-600/20 text-indigo-400 border-indigo-500/30 hover:bg-indigo-600/30';
            btnElement.textContent = '✓ Added';
        }
        
        renderDraftList();
    }

    // ==========================================
    // Locate a selected question in the question bank
    // ==========================================
    // Widens the filters so the question is reachable, asks the server which
    // page holds it (same ordering as the list), then scrolls to and flashes it.
    async function locateInBank(q) {
        if (!q || !q.id) return;

        const tab = document.querySelector('[data-tab="questions"]');
        if (tab) tab.click();

        if (filterSubject && !filterSubject.disabled && q.subject) {
            filterSubject.value = q.subject;
        }
        if (filterChapter && q.chapter) {
            if (![...filterChapter.options].some(o => o.value === q.chapter)) {
                const opt = document.createElement('option');
                opt.value = q.chapter;
                opt.textContent = q.chapter;
                filterChapter.appendChild(opt);
            }
            filterChapter.value = q.chapter;
        }

        try {
            const loc = await api.request(
                `/questions/locate?id=${encodeURIComponent(q.id)}&per_page=${limit}`
            );
            currentPage = loc.page || 1;
        } catch (e) {
            console.error(e);
            currentPage = 1;
        }

        await loadQuestions();
        flashQuestion(q.id);
    }

    function flashQuestion(id) {
        const el = questionsContainer.querySelector(`[data-qid="${id}"]`);
        if (!el) {
            notify.info('Loaded that question\'s chapter, but it is not on this page — click Search to refresh.');
            return;
        }
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('ring-2', 'ring-indigo-500', 'ring-offset-2');
        setTimeout(() => el.classList.remove('ring-2', 'ring-indigo-500', 'ring-offset-2'), 2500);
    }

    // Shows the quota as progress: how many of each chapter are staged in this
    // panel or already saved in the exam, against the required count.
    function renderTargetQuota() {
        const el = document.getElementById('facultyTargetQuota');
        if (!el) return;
        const quotas = window.activeBlueprintQuotas;
        if (!quotas || Object.keys(quotas).length === 0) {
            el.textContent = 'None selected';
            return;
        }
        const escQ = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        el.innerHTML = Object.entries(quotas).map(([chapter, want]) => {
            const have = selectedQuestions.filter(sq => sq.chapter === chapter).length;
            const done = have >= want;
            return `<div class="${done ? 'text-emerald-700' : ''}">${escQ(chapter)}: <strong>${have}/${want}</strong>${done ? ' ✓' : ''}</div>`;
        }).join('');
    }

    function renderDraftList() {
        draftCount.textContent = `${selectedQuestions.length} Qs`;
        renderTargetQuota();
        
        if (selectedQuestions.length === 0) {
            draftList.innerHTML = '<p class="text-gray-500 text-sm text-center py-8 italic bg-gray-50/30 rounded-lg border border-dashed border-gray-200">No questions added yet.</p>';
            return;
        }
        
        const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

        draftList.innerHTML = '';
        selectedQuestions.forEach((q, index) => {
            const item = document.createElement('div');
            item.className = 'flex justify-between items-center gap-1 p-3 border-b border-gray-200 text-sm cursor-pointer rounded hover:bg-indigo-50 transition-colors group';
            item.title = 'Click to show this question in the question bank';
            
            let preview = String(q.question_text || '').substring(0, 40).replace(/<[^>]+>/g, '');
            if (preview.length === 40) preview += '...';

            // Preloaded questions are already persisted. Show them as "saved"
            // rather than offering a remove the API can't honour — it only appends.
            const isSaved = q._saved === true;

            item.innerHTML = `
                <span class="text-gray-700 flex-1 truncate"><strong class="text-gray-900">Q${index + 1}.</strong> ${esc(preview)}</span>
                ${isSaved ? '<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-200 whitespace-nowrap" title="Already saved in this exam">saved</span>' : ''}
                <button class="locate-btn text-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity p-1" title="Show in question bank">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                </button>
                ${isSaved ? '' : `<button class="remove-btn text-red-400 hover:text-red-300 transition-colors p-1" title="Remove">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>`}
            `;
            
            const removeBtn = item.querySelector('.remove-btn');
            if (removeBtn) removeBtn.onclick = (e) => {
                e.stopPropagation();
                selectedQuestions.splice(index, 1);
                renderDraftList();
                loadQuestions();
            };
            item.querySelector('.locate-btn').onclick = (e) => {
                e.stopPropagation();
                locateInBank(q);
            };
            item.onclick = () => locateInBank(q);
            
            draftList.appendChild(item);
        });
    }

    const STANDARD_CHAPTERS = {
        physics: [
            "Units and Measurements", "Motion in a Straight Line", "Motion in a Plane", "Laws of Motion", 
            "Work, Energy and Power", "System of Particles and Rotational Motion", "Gravitation", 
            "Mechanical Properties of Solids", "Mechanical Properties of Fluids", "Thermal Properties of Matter", 
            "Thermodynamics", "Kinetic Theory", "Oscillations", "Waves", "Electric Charges and Fields", 
            "Electrostatic Potential and Capacitance", "Current Electricity", "Moving Charges and Magnetism", 
            "Magnetism and Matter", "Electromagnetic Induction", "Alternating Current", "Electromagnetic Waves", 
            "Ray Optics and Optical Instruments", "Wave Optics", "Dual Nature of Radiation and Matter", 
            "Atoms", "Nuclei", "Semiconductor Electronics"
        ],
        chemistry: [
            "Some Basic Concepts of Chemistry", "Structure of Atom", "Classification of Elements and Periodicity in Properties", 
            "Chemical Bonding and Molecular Structure", "States of Matter", "Thermodynamics", "Equilibrium", "Redox Reactions", 
            "Hydrogen", "The s-Block Elements", "The p-Block Elements", "Organic Chemistry - Some Basic Principles and Techniques", 
            "Hydrocarbons", "Environmental Chemistry", "The Solid State", "Solutions", "Electrochemistry", "Chemical Kinetics", 
            "Surface Chemistry", "General Principles and Processes of Isolation of Elements", "The d-and f-Block Elements", 
            "Coordination Compounds", "Haloalkanes and Haloarenes", "Alcohols, Phenols and Ethers", "Aldehydes, Ketones and Carboxylic Acids", 
            "Amines", "Biomolecules", "Polymers", "Chemistry in Everyday Life"
        ],
        maths: [
            "Sets", "Relations and Functions", "Trigonometric Functions", "Principle of Mathematical Induction", 
            "Complex Numbers and Quadratic Equations", "Linear Inequalities", "Permutations and Combinations", 
            "Binomial Theorem", "Sequence and Series", "Straight Lines", "Conic Sections", "Introduction to Three Dimensional Geometry", 
            "Limits and Derivatives", "Mathematical Reasoning", "Statistics", "Probability", "Inverse Trigonometric Functions", 
            "Matrices", "Determinants", "Continuity and Differentiability", "Application of Derivatives", "Integrals", 
            "Application of Integrals", "Differential Equations", "Vector Algebra", "Three Dimensional Geometry", "Linear Programming"
        ],
        biology: [
            "The Living World", "Biological Classification", "Plant Kingdom", "Animal Kingdom", "Morphology of Flowering Plants", 
            "Anatomy of Flowering Plants", "Structural Organisation in Animals", "Cell: The Unit of Life", "Biomolecules", 
            "Cell Cycle and Cell Division", "Transport in Plants", "Mineral Nutrition", "Photosynthesis in Higher Plants", 
            "Respiration in Plants", "Plant Growth and Development", "Digestion and Absorption", "Breathing and Exchange of Gases", 
            "Body Fluids and Circulation", "Excretory Products and their Elimination", "Locomotion and Movement", 
            "Neural Control and Coordination", "Chemical Coordination and Integration", "Reproduction in Organisms", 
            "Sexual Reproduction in Flowering Plants", "Human Reproduction", "Reproductive Health", "Principles of Inheritance and Variation", 
            "Molecular Basis of Inheritance", "Evolution", "Human Health and Disease", "Strategies for Enhancement in Food Production", 
            "Microbes in Human Welfare", "Biotechnology: Principles and Processes", "Biotechnology and its Applications", 
            "Organisms and Populations", "Ecosystem", "Biodiversity and Conservation", "Environmental Issues"
        ]
    };

    const chaptersCache = {};

    async function fetchChapters(subject) {
        if (chaptersCache[subject]) return chaptersCache[subject];
        let dbChapters = [];
        try {
            const res = await api.request(`/questions/chapters?subject=${subject}`);
            dbChapters = (res.chapters || []).filter(Boolean);
        } catch (e) {
            console.error(e);
        }

        // The question bank is authoritative: a blueprint chapter can only be
        // filled if that exact chapter has questions. Merging the syllabus list
        // in created chapters with zero matching questions (e.g. "Alcohols,
        // Phenols and Ethers" vs the bank's "Alcohols Phenols and Ethers"),
        // which the principal could select but no faculty could ever fill.
        // Fall back to the syllabus list only when the bank has no chapters yet.
        const merged = dbChapters.length
            ? Array.from(new Set(dbChapters)).sort()
            : (STANDARD_CHAPTERS[subject.toLowerCase()] || []).slice().sort();

        chaptersCache[subject] = merged;
        return merged;
    }

    async function renderChapterQuotasUI() {
        const type = examTypeSelect ? examTypeSelect.value : 'custom';
        const container = document.getElementById('dynamicChapterQuotas');
        if (!container) return;

        container.innerHTML = '<div class="text-center py-4 text-gray-400 text-sm animate-pulse">Loading chapters...</div>';

        let activeSubjects = [];
        if (type === 'jee') activeSubjects = ['physics', 'chemistry', 'maths'];
        else if (type === 'neet') activeSubjects = ['physics', 'chemistry', 'biology'];
        else if (type === 'kcet') activeSubjects = ['physics', 'chemistry', 'maths', 'biology'];
        else activeSubjects = ['physics', 'chemistry', 'maths', 'biology'];

        let html = '';
        for (const sub of activeSubjects) {
            const chapters = await fetchChapters(sub);
            if (chapters.length === 0) continue;
            
            let chaptersHtml = '';
            for (const ch of chapters) {
                chaptersHtml += `
                    <div class="flex justify-between items-center py-1">
                        <span class="text-xs text-gray-700 truncate pr-2 flex-1" title="${ch}">${ch}</span>
                        <input type="number" min="0" step="1" value="0" data-subject="${sub}" data-chapter="${ch.replace(/"/g, '&quot;')}" class="chapter-quota-input w-16 text-xs bg-white border border-gray-300 rounded px-2 py-1 text-center focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500">
                    </div>
                `;
            }

            html += `
                <div class="mb-4">
                    <h5 class="text-sm font-semibold text-gray-900 capitalize mb-2 bg-gray-100 px-2 py-1 rounded">${sub}</h5>
                    <div class="space-y-1 pl-2 border-l-2 border-gray-100">
                        ${chaptersHtml}
                    </div>
                </div>
            `;
        }

        container.innerHTML = html || '<div class="text-sm text-gray-500 italic">No chapters found.</div>';

        document.querySelectorAll('.chapter-quota-input').forEach(input => {
            input.addEventListener('input', (e) => {
                // Actively block non-digit characters
                e.target.value = e.target.value.replace(/[^0-9]/g, '');
                updateTotalQs();
            });
        });
        updateTotalQs();
    }

    function updateTotalQs() {
        let total = 0;
        document.querySelectorAll('.chapter-quota-input').forEach(input => {
            total += parseInt(input.value) || 0;
        });
        const label = document.getElementById('quotaTotalLabel');
        if (label) label.textContent = `Total: ${total} Qs`;
    }

    const examTypeSelect = document.getElementById('examType');
    const examDurationInput = document.getElementById('examDuration');
    const examStartsAtInput = document.getElementById('examStartsAt');
    const examEndsAtInput = document.getElementById('examEndsAt');

    // ── End Time fills itself ─────────────────────
    // No switches: once Start Time and Duration are both set, End Time simply
    // appears as Start + Duration. Edit the End Time by hand and your value
    // sticks; change Start or Duration again and End Time follows them once
    // more. (Server derives ends_at the same way when the field is left empty.)
    const MAX_DURATION_MINUTES = 200; // hard cap — matches NEET's 200
    let endsAtTouched = false; // user typed a custom end
    function fmtLocal(dt) {
        return new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
    function autoEndPreview() {
        const previewEl = document.getElementById('examEndsAtPreview');
        if (!previewEl) return;
        const s = examStartsAtInput && examStartsAtInput.value ? new Date(examStartsAtInput.value) : null;
        const d = examDurationInput ? parseInt(examDurationInput.value, 10) : NaN;
        if (s && Number.isInteger(d) && d > 0) {
            const end = new Date(s.getTime() + d * 60000);
            previewEl.textContent = `Ends ${end.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
        } else {
            previewEl.textContent = 'Pick a start time and duration to see the end time.';
        }
    }
    function applyAutoEnd() {
        if (!examEndsAtInput) return;
        // Recompute only when the user hasn't hand-tuned the end time.
        if (!endsAtTouched) {
            const s = examStartsAtInput && examStartsAtInput.value ? new Date(examStartsAtInput.value) : null;
            const d = examDurationInput ? parseInt(examDurationInput.value, 10) : NaN;
            if (s && Number.isInteger(d) && d > 0) {
                examEndsAtInput.value = fmtLocal(new Date(s.getTime() + d * 60000));
            }
        }
        syncHiddenToDropdowns('examEnd'); // End dropdowns always mirror the computed value
        autoEndPreview();
    }
    if (examStartsAtInput) {
        examStartsAtInput.addEventListener('input', () => {
            endsAtTouched = false; // start moved → end follows it again
            applyAutoEnd();
        });
        examStartsAtInput.addEventListener('change', () => {
            endsAtTouched = false; // start moved → end follows it again
            applyAutoEnd();
        });
    }
    if (examDurationInput) {
        examDurationInput.addEventListener('input', () => {
            endsAtTouched = false; // duration moved → end follows it again
            applyAutoEnd();
        });
    }

    // ── 12-hour time pickers (Hour 1–12, Minute 00–59, AM/PM) ──
    // The native datetime-local control renders 24-hour spinners in most
    // locales and cannot be forced to AM/PM, so the time part is driven by
    // explicit dropdowns. The hidden datetime-local inputs stay the single
    // source of truth: all existing rules (fresh min, past-snap, auto-End,
    // create-handler validation, payload) keep working unchanged.
    function populateTimeDropdowns(prefix) {
        const hourSel = document.getElementById(`${prefix}Hour`);
        const minSel = document.getElementById(`${prefix}Minute`);
        const ampmSel = document.getElementById(`${prefix}Ampm`);
        if (!hourSel || !minSel || !ampmSel) return;
        if (hourSel.options.length === 0) {
            // Blank placeholder — no "H" text (the calendar sits beside it).
            let h = '<option value="">&nbsp;</option>';
            for (let i = 1; i <= 12; i++) h += `<option value="${i}">${i}</option>`;
            hourSel.innerHTML = h;
        }
        if (minSel.options.length === 0) {
            let m = '<option value="0">00</option>';
            for (let i = 1; i <= 59; i++) m += `<option value="${i}">${String(i).padStart(2, '0')}</option>`;
            minSel.innerHTML = m;
        }
        if (ampmSel.options.length === 0) {
            ampmSel.innerHTML = '<option value="AM">AM</option><option value="PM">PM</option>';
        }
    }
    populateTimeDropdowns('examStart');
    populateTimeDropdowns('examEnd');

    // dropdowns → hidden datetime-local
    function syncDropdownsToHidden(prefix) {
        const dateInput = document.getElementById(`${prefix}Date`);
        const hourSel = document.getElementById(`${prefix}Hour`);
        const minSel = document.getElementById(`${prefix}Minute`);
        const ampmSel = document.getElementById(`${prefix}Ampm`);
        const hidden = prefix === 'examStart' ? examStartsAtInput : examEndsAtInput;
        if (!dateInput || !hourSel || !minSel || !ampmSel || !hidden) return;
        if (!dateInput.value || hourSel.value === '' || minSel.value === '' || ampmSel.value === '') {
            if (!dateInput.value && hourSel.value === '' && minSel.value === '' && ampmSel.value === '') {
                hidden.value = ''; // fully cleared
            }
            return; // incomplete time — wait for the rest
        }
        let hour24 = parseInt(hourSel.value, 10) % 12; // 12 → 0
        if (ampmSel.value === 'PM') hour24 += 12;
        const mm = String(parseInt(minSel.value, 10)).padStart(2, '0');
        hidden.value = `${dateInput.value}T${String(hour24).padStart(2, '0')}:${mm}`;
        hidden.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // hidden datetime-local → dropdowns (auto-End writes here)
    function syncHiddenToDropdowns(prefix) {
        const dateInput = document.getElementById(`${prefix}Date`);
        const hourSel = document.getElementById(`${prefix}Hour`);
        const minSel = document.getElementById(`${prefix}Minute`);
        const ampmSel = document.getElementById(`${prefix}Ampm`);
        const hidden = prefix === 'examStart' ? examStartsAtInput : examEndsAtInput;
        if (!dateInput || !hourSel || !minSel || !ampmSel || !hidden) return;
        if (!hidden.value) {
            dateInput.value = '';
            hourSel.value = '';
            minSel.value = '';
            ampmSel.value = '';
            return;
        }
        const [d, t] = hidden.value.split('T');
        const [h24, m] = t.split(':').map(Number);
        const ampm = h24 >= 12 ? 'PM' : 'AM';
        let h12 = h24 % 12;
        if (h12 === 0) h12 = 12;
        // A computed/snappped time can land on :00 (e.g. 2:59 + 61 min =
        // 4:00). The pickable list is 1–59, so add a "00" option on demand
        // rather than showing a stale value.
        if (m === 0 && !minSel.querySelector('option[value="0"]')) {
            const opt = document.createElement('option');
            opt.value = '0';
            opt.textContent = '00';
            minSel.insertBefore(opt, minSel.options[1]);
        }
        dateInput.value = d;
        hourSel.value = String(h12);
        minSel.value = String(m);
        ampmSel.value = ampm;
    }

    for (const prefix of ['examStart', 'examEnd']) {
        const dateInput = document.getElementById(`${prefix}Date`);
        if (dateInput) {
            dateInput.addEventListener('change', (e) => {
                const minDate = currentLocalMinuteISO().split('T')[0];
                if (e.target.value && e.target.value < minDate) {
                    e.target.value = minDate;
                    notify.info('Date was in the past — snapped to today.', 'Date corrected');
                }
            });
        }
        ['Date', 'Hour', 'Minute', 'Ampm'].forEach(part => {
            const el = document.getElementById(`${prefix}${part}`);
            if (!el) return;
            el.addEventListener('change', () => syncDropdownsToHidden(prefix));
            el.addEventListener('input', () => syncDropdownsToHidden(prefix));
        });
    }

    // ── Difficulty picker (Easy / Medium / Hard) ───────────────
    // Segmented buttons; default 'medium' (matches the bank, which is
    // overwhelmingly medium difficulty).
    let selectedDifficulty = 'medium';
    const difficultyPicker = document.getElementById('examDifficultyPicker');
    if (difficultyPicker) {
        const syncDifficultyButtons = () => {
            difficultyPicker.querySelectorAll('.difficulty-btn').forEach(btn => {
                const active = btn.dataset.difficulty === selectedDifficulty;
                btn.classList.toggle('bg-indigo-600', active);
                btn.classList.toggle('text-white', active);
                btn.classList.toggle('text-gray-600', !active);
                btn.classList.toggle('hover:bg-gray-100', !active);
            });
        };
        difficultyPicker.querySelectorAll('.difficulty-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                selectedDifficulty = btn.dataset.difficulty;
                syncDifficultyButtons();
            });
        });
        syncDifficultyButtons();
    }

    // ── Fresh "min" for the datetime pickers ───────────────────
    // A min computed once at page load goes stale when the form sits open —
    // the browser would happily offer yesterday. Recompute in local time
    // whenever the field is focused/changed and on a 1-minute timer, and
    // snap any already-picked value forward if it fell into the past.
    function currentLocalMinuteISO() {
        const n = new Date();
        return new Date(n.getTime() - n.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
    function refreshDatetimeMins() {
        const minVal = currentLocalMinuteISO();
        const dateOnly = minVal.split('T')[0];
        const startDateInput = document.getElementById('examStartDate');
        if (startDateInput) startDateInput.min = dateOnly;
        const endDateInput = document.getElementById('examEndDate');
        if (endDateInput) endDateInput.min = dateOnly;
        
        for (const input of [examStartsAtInput, examEndsAtInput]) {
            if (!input) continue;
            input.min = minVal;
            if (input.value && input.value < minVal) {
                input.value = minVal;
                notify.info('Start/End time was in the past — snapped to the current minute.', 'Time corrected');
            }
        }
        syncHiddenToDropdowns('examStart');
        syncHiddenToDropdowns('examEnd');
        applyAutoEnd();
    }
    if (examStartsAtInput) {
        examStartsAtInput.addEventListener('focus', refreshDatetimeMins);
        examStartsAtInput.addEventListener('change', (e) => {
            refreshDatetimeMins();
            if (examEndsAtInput && !examEndsAtInput.value && e.target.value) {
                examEndsAtInput.min = e.target.value; // End can't precede Start
            }
        });
    }
    if (examEndsAtInput) {
        examEndsAtInput.addEventListener('focus', refreshDatetimeMins);
        examEndsAtInput.addEventListener('change', (e) => {
            // Mark the end as hand-tuned BEFORE refreshing — otherwise the
            // refresh's applyAutoEnd recomputes Start+Duration and clobbers
            // the value the user just picked.
            if (e.target.value) endsAtTouched = true;
            refreshDatetimeMins();
        });
    }
    refreshDatetimeMins();
    applyAutoEnd();
    setInterval(refreshDatetimeMins, 60000);

    // ── Duration: block everything but positive integers ───────
    // Strips '-', '+', 'e', '.', spaces and leading zeros as they are typed;
    // the create handler re-validates (belt and braces).
    if (examDurationInput) {
        examDurationInput.addEventListener('input', (e) => {
            // Digits only; strip ALL leading zeros so neither "0" nor "090"
            // can sit in the field — a negative or zero duration can't be typed.
            e.target.value = e.target.value.replace(/[^0-9]/g, '').replace(/^0+/, '');
            // Hard cap: anything above the maximum is trimmed to it.
            const n = parseInt(e.target.value, 10);
            if (Number.isInteger(n) && n > MAX_DURATION_MINUTES) {
                e.target.value = MAX_DURATION_MINUTES;
                window.Swal.fire({
                    icon: 'info',
                    title: 'Maximum duration is 200 minutes',
                    text: 'An exam cannot run longer than 200 minutes. Duration has been set to 200.',
                    timer: 3200,
                    timerProgressBar: true,
                    confirmButtonColor: '#4f46e5',
                });
            }
            applyAutoEnd();
        });
        examDurationInput.addEventListener('blur', (e) => {
            const n = parseInt(e.target.value, 10);
            if (!Number.isInteger(n) || n <= 0) {
                e.target.value = 180; // sane default for the exam presets
            }
        });
    }

    if (examTypeSelect) {
        examTypeSelect.addEventListener('change', () => {
            const type = examTypeSelect.value;
            if (type === 'jee') examDurationInput.value = 180;
            if (type === 'neet') examDurationInput.value = 200;
            if (type === 'kcet') examDurationInput.value = 80;
            renderChapterQuotasUI();
        });
        // Initial load
        setTimeout(renderChapterQuotasUI, 100);
    }
    btnCreateExam.addEventListener('click', async () => {
        const title = document.getElementById('examTitle').value.trim();
        const descriptionEl = document.getElementById('examDescription');
        const description = descriptionEl ? descriptionEl.value.trim() : '';
        const duration = parseInt(document.getElementById('examDuration').value);
        const examType = document.getElementById('examType').value;
        const targetBatchEl = document.getElementById('targetBatch');
        const targetBatchVal = targetBatchEl ? targetBatchEl.value.trim() : '';
        const startsAtVal = document.getElementById('examStartsAt').value;
        const startsAtEpoch = startsAtVal ? Math.floor(new Date(startsAtVal).getTime() / 1000) : undefined;
        const difficulty = (typeof selectedDifficulty === 'string' && ['easy', 'medium', 'hard'].includes(selectedDifficulty))
            ? selectedDifficulty
            : 'medium';
        const endsAtVal = document.getElementById('examEndsAt') ? document.getElementById('examEndsAt').value : '';
        const endsAtEpoch = endsAtVal ? Math.floor(new Date(endsAtVal).getTime() / 1000) : undefined;
        let chapterQuotas = {};
        let invalidQuota = false;
        document.querySelectorAll('.chapter-quota-input').forEach(input => {
            const rawVal = input.value;
            if (rawVal) {
                const val = Number(rawVal);
                if (!Number.isInteger(val) || val < 0) {
                    invalidQuota = true;
                } else if (val > 0) {
                    const sub = input.dataset.subject;
                    const ch = input.dataset.chapter;
                    if (!chapterQuotas[sub]) chapterQuotas[sub] = {};
                    chapterQuotas[sub][ch] = val;
                }
            }
        });
        
        if (invalidQuota) {
            notify.warning('Chapter quotas must be non-negative integers.');
            return;
        }

        const rawDuration = document.getElementById('examDuration').value;
        const durationNum = Number(rawDuration);
        if (!rawDuration || !Number.isInteger(durationNum) || durationNum <= 0) {
            notify.warning('Duration must be a positive integer.');
            return;
        }

        if (!title) {
            notify.warning('Title is required.');
            return;
        }
        
        const nowEpoch = Math.floor(Date.now() / 1000);
        // Allow a small grace period for current time matching
        if (startsAtEpoch && startsAtEpoch < nowEpoch - 60) {
            notify.warning('Start time cannot be in the past.');
            return;
        }
        if (endsAtEpoch && endsAtEpoch < nowEpoch - 60) {
            notify.warning('End time cannot be in the past.');
            return;
        }
        if (startsAtEpoch && endsAtEpoch && startsAtEpoch >= endsAtEpoch) {
            notify.warning('End time must be after start time.');
            return;
        }
        if (endsAtEpoch && startsAtEpoch && durationNum > 0 && (endsAtEpoch - startsAtEpoch) < durationNum * 60) {
            notify.warning(`End time leaves less than the ${durationNum}-minute exam window. Move End Time later.`);
            return;
        }
        if (!endsAtEpoch && startsAtEpoch && durationNum > 0) {
            notify.warning('End time could not be derived — set Start Time and a positive Duration.');
            return;
        }

        if (Object.keys(chapterQuotas).length === 0) {
            notify.warning('Please specify at least one question quota.');
            return;
        }
        
        // Calculate total marks from all quotas assuming 4 marks per question
        let totalMarks = 0;
        for (const sub in chapterQuotas) {
            for (const ch in chapterQuotas[sub]) {
                totalMarks += chapterQuotas[sub][ch] * 4;
            }
        }
        
        btnCreateExam.disabled = true;
        btnCreateExam.innerHTML = `<div class="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div> Creating Blueprint...`;
        
        try {
            const payload = {
                title,
                description,
                exam_type: examType,
                duration_minutes: duration,
                total_marks: totalMarks,
                difficulty,
                target_batch: targetBatchVal ? targetBatchVal : undefined,
                starts_at: startsAtEpoch,
                ends_at: endsAtEpoch,
                chapter_quotas: chapterQuotas
            };
            
            await api.request('/exams', 'POST', payload);
            notify.success('Blueprint successfully created as a draft!');
            
            document.getElementById('examTitle').value = '';
            if (descriptionEl) descriptionEl.value = '';
            document.getElementById('examStartsAt').value = '';
            document.getElementById('examEndsAt').value = '';
            syncHiddenToDropdowns('examStart');
            syncHiddenToDropdowns('examEnd');
            endsAtTouched = false;
            selectedDifficulty = 'medium';
            if (difficultyPicker) {
                difficultyPicker.querySelectorAll('.difficulty-btn').forEach(btn => {
                    const active = btn.dataset.difficulty === 'medium';
                    btn.classList.toggle('bg-indigo-600', active);
                    btn.classList.toggle('text-white', active);
                    btn.classList.toggle('text-gray-600', !active);
                    btn.classList.toggle('hover:bg-gray-100', !active);
                });
            }
            renderChapterQuotasUI();
            applyAutoEnd();
            
            if (user.role === 'principal') {
                loadApprovals();
            } else {
                loadTasks(user);
            }
        } catch (error) {
            notify.error('Failed to create blueprint: ' + error.message);
        } finally {
            btnCreateExam.disabled = false;
            btnCreateExam.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path></svg> Create Blueprint`;
        }
    });

    // Quota guard for the active blueprint: returns a short list of
    // "chapter 8/10" strings that are still short, or [] when complete.
    // Per-chapter (not just the subject total) so faculty can't overfill one
    // chapter to paper over a hole in another.
    function quotaShortfalls() {
        const perChapter = {};
        for (const q of selectedQuestions) {
            if (!q.chapter) continue;
            const ch = perChapter[q.chapter] || { saved: 0, picked: 0 };
            if (q._saved) ch.saved++; else ch.picked++;
            perChapter[q.chapter] = ch;
        }
        const short = [];
        for (const [chapter, need] of Object.entries(window.activeBlueprintQuotas || {})) {
            const ch = perChapter[chapter] || { saved: 0, picked: 0 };
            const have = ch.saved + ch.picked;
            if (have < need) short.push(`${chapter}: ${have}/${need}`);
        }
        return short;
    }

    const btnSaveQuestions = document.getElementById('btnSaveQuestions');
    if (btnSaveQuestions) {
        btnSaveQuestions.addEventListener('click', async () => {
            if (!window.activeBlueprintId) {
                notify.warning('No blueprint selected.');
                return;
            }
            if (selectedQuestions.length === 0) {
                notify.warning('No questions selected to save.');
                return;
            }
            // Task-completion guard: the assigned quota must be fully met.
            const short = quotaShortfalls();
            if (short.length > 0) {
                const board = await fetchQuotaBoard(window.activeBlueprintId);
                const rows = (board && board.rows.length)
                    ? board.rows
                    : short.map(s => { const [label, have, need] = s.split(/[:/]/).map(x => x.trim()); return { label, have: Number(have), need: Number(need) }; });
                await showQuotaSweet({ complete: false, rows });
                return;
            }
            
            btnSaveQuestions.disabled = true;
            btnSaveQuestions.textContent = 'Saving...';
            
            try {
                const payload = {
                    question_ids: selectedQuestions.map(q => ({ id: q.id, marks: 4, negative_marks: 1 }))
                };
                const saveRes = await api.request(`/exams/${window.activeBlueprintId}/questions`, 'PUT', payload);
                // Sweet completion board after every save — shows ALL subjects.
                const savedExamId = window.activeBlueprintId;
                const board = await fetchQuotaBoard(savedExamId);
                if (board && board.rows.length) {
                    await showQuotaSweet({ complete: board.complete, rows: board.rows, afterSave: true });
                } else {
                    notify.success(saveRes && saveRes.added === 0
                        ? 'Nothing new to save — those questions are already in this exam.'
                        : 'Questions saved to blueprint!');
                }
                selectedQuestions = [];
                renderDraftList();
                window.activeBlueprintId = null;
                window.activeBlueprintQuotas = null;
                window.activeBlueprintDifficulty = null;
                document.getElementById('facultyDraftTitle').textContent = 'Active Blueprint';
                document.getElementById('facultyTargetQuota').textContent = 'None selected';
                btnSaveQuestions.classList.add('hidden');
                const autoBox = document.getElementById('autoGenerateBox');
                if (autoBox) autoBox.classList.add('hidden');
                
                // Unlock filters
                const filterSubject = document.getElementById('filterSubject');
                const filterDifficulty = document.getElementById('filterDifficulty');
                if (filterSubject) {
                    filterSubject.disabled = false;
                    filterSubject.dispatchEvent(new Event('change'));
                }
                if (filterDifficulty) filterDifficulty.disabled = false;

                loadTasks(user);
            } catch (error) {
                notify.error('Failed to save questions: ' + error.message);
            } finally {
                btnSaveQuestions.disabled = false;
                btnSaveQuestions.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg> Save Questions to Exam`;
            }
        });
    }

    // How many of THIS faculty's subject questions each draft exam already has
    // saved — keyed by exam id. Powers the per-task completion chip and the
    // "Submit to Principal" button on Pending Tasks.
    window.quotaDoneByExam = async function () {
        const subject = (user.subject || '').toLowerCase();
        const done = {};
        try {
            // Every exam the tasks board can show — NOT just drafts. Counting only
            // drafts made a task's progress collapse to "0/n filled" the instant it
            // was submitted, since it leaves 'draft' for 'pending_principal_review'.
            const res = await api.request('/exams');
            for (const e of res || []) {
                if (['published', 'ongoing', 'completed', 'archived'].includes(e.status)) continue;
                let quotas = {};
                try { quotas = JSON.parse(e.chapter_quotas || '{}'); } catch {}
                const required = Object.values(quotas[subject] || {}).reduce((a, b) => a + (Number(b) || 0), 0);
                if (!required) continue;
                try {
                    const payload = await api.request(`/exams/${e.id}`);
                    done[e.id] = (payload.questions || []).filter(
                        q => (q.subject || '').toLowerCase() === subject
                    ).length;
                } catch (err) {
                    console.error('Could not count saved questions for', e.id, err);
                }
            }
        } catch (err) {
            console.error('Could not load drafts for quota progress:', err);
        }
        return done;
    };

    // Submit a completed task straight from Pending Tasks.
    window.submitTaskToPrincipal = async function (examId, title) {
        // Subject-scoped pre-check: block only if THIS faculty's subject is
        // still short. Other subjects' progress is the principal's concern —
        // the server gate enforces the full blueprint at submit time.
        try {
            const board = await fetchQuotaBoard(examId);
            if (board && board.rows.length) {
                const mySub = (user.subject || '').toLowerCase().trim();
                const mine = (user.role === 'faculty' && mySub)
                    ? board.rows.filter(r => (r.label || '').toLowerCase().trim() === mySub)
                    : board.rows;
                if (mine.length && !mine.every(r => r.have >= r.need)) {
                    await showQuotaSweet({ complete: false, rows: board.rows });
                    return;
                }
            }
        } catch (e) {
            console.error('Quota pre-check failed; falling back to server gate:', e);
        }
        const confirmed = await notify.confirm(`Submit "${title}" to the principal for review?`, { confirmText: 'Submit' });
        if (!confirmed) return;
        try {
            await api.request(`/exams/${examId}/submit-for-review`, 'POST');
            notify.success(`"${title}" submitted to the principal.`);
            loadTasks(user);
        } catch (error) {
            const gaps = error && error.data && error.data.quota_gaps;
            if (gaps) {
                await showQuotaSweet({
                    complete: false,
                    rows: gaps.map(g => ({ label: g.subject, have: g.selected, need: g.required })),
                });
            } else {
                notify.error('Failed to submit: ' + error.message);
            }
        }
    };

    // ==========================================
    // Auto Generate — fill the blueprint quota from chapter(s)
    // ==========================================
    // Pulls questions straight from the question bank via the auto-select
    // endpoint and drops them into the Selected Questions list. The faculty can
    // still remove any of them or add more by hand before saving.
    const btnAutoGenerate = document.getElementById('btnAutoGenerate');
    if (btnAutoGenerate) {
        btnAutoGenerate.addEventListener('click', async () => {
            if (!window.activeBlueprintId || !window.activeBlueprintQuotas) {
                notify.warning('Select a blueprint from Pending Tasks first.');
                return;
            }

            const quotas = window.activeBlueprintQuotas;
            const subject = window.activeBlueprintSubject || (user.subject ? user.subject.toLowerCase() : '');
            if (!subject) {
                notify.warning('Could not determine the subject for this blueprint.');
                return;
            }

            // A specific chapter chosen in the filter fills just that chapter;
            // the default "Assigned Chapters" placeholder fills every chapter.
            const chosen = filterChapter ? filterChapter.value : '';
            const targets = chosen ? [chosen] : Object.keys(quotas);
            if (targets.length === 0) {
                notify.warning('This blueprint assigns you no chapters.');
                return;
            }

            const originalHtml = btnAutoGenerate.innerHTML;
            btnAutoGenerate.disabled = true;
            btnAutoGenerate.textContent = 'Generating...';

            let added = 0;
            const notes = [];

            try {
                for (const chapter of targets) {
                    const quota = quotas[chapter];
                    if (quota === undefined) {
                        notes.push(`"${chapter}" is not assigned to you`);
                        continue;
                    }

                    const have = selectedQuestions.filter(sq => sq.chapter === chapter).length;
                    const remaining = quota - have;
                    if (remaining <= 0) {
                        notes.push(`${chapter}: already filled (${have}/${quota})`);
                        continue;
                    }

                    const preview = await api.request(
                        `/exams/${window.activeBlueprintId}/auto-select-preview`,
                        'POST',
                        { subject, chapters: [chapter], count: remaining, difficulty: window.activeBlueprintDifficulty || 'medium' }
                    );

                    const fresh = (preview || []).filter(q => !selectedQuestions.some(sq => sq.id === q.id));
                    const take = fresh.slice(0, remaining);
                    selectedQuestions.push(...take);
                    added += take.length;

                    notes.push(take.length < remaining
                        ? `${chapter}: only ${take.length} of ${remaining} available`
                        : `${chapter}: ${take.length} selected`);
                }

                renderDraftList();
                await loadQuestions();  // refresh so new picks show as "✓ Added"

                if (added === 0) {
                    notify.warning(`No questions added — ${notes.join('; ')}.`);
                } else {
                    notify.success(`Auto-generated ${added} question${added === 1 ? '' : 's'} — ${notes.join('; ')}. Review them, then "Save Questions to Exam".`);
                }
            } catch (error) {
                notify.error('Auto-generate failed: ' + error.message);
            } finally {
                btnAutoGenerate.disabled = false;
                btnAutoGenerate.innerHTML = originalHtml;
            }
        });
    }

    // ==========================================
    // Bulk CSV Upload
    // ==========================================
    // CSV Download Template
    const btnDownloadTemplate = document.getElementById('btnDownloadTemplate');
    if (btnDownloadTemplate) {
        btnDownloadTemplate.addEventListener('click', () => {
            const csvContent = "name,email,password,section\nJohn Doe,john.doe@example.com,TempPass123!,Section A\nJane Smith,jane.smith@example.com,TempPass456!,Section B";
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.setAttribute("href", url);
            link.setAttribute("download", "student_template.csv");
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        });
    }

    btnUploadCsv.addEventListener('click', async () => {
        const file = csvFileInput.files[0];
        if (!file) {
            csvUploadStatus.className = 'mt-6 p-4 rounded-lg text-sm bg-red-500/10 text-red-400 border border-red-500/20';
            csvUploadStatus.textContent = 'Please select a CSV file first.';
            csvUploadStatus.classList.remove('hidden');
            return;
        }

        btnUploadCsv.disabled = true;
        btnUploadCsv.textContent = 'Processing...';
        csvUploadStatus.classList.add('hidden');

        try {
            const text = await file.text();
            
            // Basic CSV parsing
            const lines = text.split('\n').filter(l => l.trim() !== '');
            if (lines.length < 2) throw new Error('CSV must contain a header row and at least one user.');

            const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
            
            const nameIdx = headers.indexOf('name');
            const emailIdx = headers.indexOf('email');
            const passIdx = headers.indexOf('password');
            // Accept either header name — "section" is the user-facing term,
            // "batch" is the legacy column name.
            const batchIdx = headers.indexOf('section') !== -1 ? headers.indexOf('section') : headers.indexOf('batch');

            if (nameIdx === -1 || emailIdx === -1 || passIdx === -1) {
                throw new Error('CSV must contain name, email, and password columns.');
            }

            // CSV cells that mean "no section" — must never reach the DB as a
            // literal string (that once created a fake 'null' section).
            const NO_SECTION = new Set(['', 'null', 'none', 'n/a', 'na', '-', '--']);

            const users = [];
            for (let i = 1; i < lines.length; i++) {
                const cols = lines[i].split(',').map(c => c.trim());
                if (cols.length >= 3) {
                    const rawBatch = batchIdx !== -1 ? cols[batchIdx] : '';
                    users.push({
                        name: cols[nameIdx],
                        email: cols[emailIdx],
                        password: cols[passIdx],
                        batch_name: NO_SECTION.has(rawBatch.toLowerCase()) ? null : rawBatch
                    });
                }
            }

            // POST to bulk endpoint
            const res = await api.request('/users/bulk', 'POST', users);
            
            csvUploadStatus.className = 'mt-6 p-4 rounded-lg text-sm bg-indigo-600/10 text-indigo-600 border border-emerald-500/20';
            csvUploadStatus.innerHTML = `<strong>Success!</strong> Created ${res.inserted} users. <br> Skipped ${res.skipped} existing users.`;
            csvUploadStatus.classList.remove('hidden');
            
            // Reset input
            csvFileInput.value = '';
            csvFileName.textContent = 'or drag and drop';
            csvFileName.classList.remove('text-indigo-600');

        } catch (error) {
            csvUploadStatus.className = 'mt-6 p-4 rounded-lg text-sm bg-red-500/10 text-red-400 border border-red-500/20';
            csvUploadStatus.textContent = `Error: ${error.message}`;
            csvUploadStatus.classList.remove('hidden');
        } finally {
            btnUploadCsv.disabled = false;
            btnUploadCsv.textContent = 'Upload Students';
        }
    });

    // ==========================================
    // Event Listeners
    // ==========================================

    filterSubject.addEventListener('change', async () => {
        if (window.activeBlueprintId) return; // Do not override if we are fulfilling a blueprint
        const subject = filterSubject.value;
        filterChapter.innerHTML = '<option value="">All Chapters</option>';
        if (!subject) return;

        try {
            // For faculty, we MUST ONLY show chapters that have been assigned to them
            // in pending exam blueprints. They are not allowed to browse all chapters.
            const userStr = localStorage.getItem('cbt_user');
            const currentUser = userStr ? JSON.parse(userStr) : null;
            
            if (currentUser && currentUser.role === 'faculty') {
                const res = await api.request('/exams?status=draft');
                const allowedChapters = new Set();
                
                res.forEach(e => {
                    if (e.chapter_quotas) {
                        try {
                            const quotas = JSON.parse(e.chapter_quotas);
                            const mySubject = currentUser.subject ? currentUser.subject.toLowerCase() : null;
                            if (mySubject && quotas[mySubject]) {
                                Object.keys(quotas[mySubject]).forEach(chap => allowedChapters.add(chap));
                            }
                        } catch (err) {}
                    }
                });
                // Only offer chapters that actually exist in the bank. A legacy
                // blueprint may still carry a name that matches no questions
                // (e.g. "Alcohols, Phenols and Ethers" vs the bank's "Alcohols
                // Phenols and Ethers"); showing it would give an option that
                // always returns an empty result.
                let realChapters = [];
                try {
                    const chRes = await api.request(`/questions/chapters?subject=${currentUser.subject || subject}`);
                    realChapters = (chRes.chapters || []).filter(Boolean);
                } catch (err) { console.error(err); }

                const realSet = new Set(realChapters);
                const ordered = Array.from(allowedChapters).sort();
                window.globalAssignedChapters = realChapters.length
                    ? ordered.filter(chap => realSet.has(chap))
                    : ordered;

                filterChapter.innerHTML = '<option value="">Assigned Chapters</option>';
                window.globalAssignedChapters.forEach(chap => {
                    const opt = document.createElement('option');
                    opt.value = chap;
                    opt.textContent = chap;
                    filterChapter.appendChild(opt);
                });
            } else {
                // For admin/principal, they can see all chapters in the question bank.
                const res = await api.request(`/questions/chapters?subject=${subject}`);
                res.chapters.forEach(chap => {
                    const opt = document.createElement('option');
                    opt.value = chap;
                    opt.textContent = chap;
                    filterChapter.appendChild(opt);
                });
            }
        } catch (e) {
            console.error(e);
        }
    });

    btnSearch.addEventListener('click', () => {
        currentPage = 1;
        loadQuestions();
    });
    btnPrevPage.addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage--;
            loadQuestions();
        }
    });
    btnNextPage.addEventListener('click', () => {
        currentPage++;
        loadQuestions();
    });

    // Init
    loadQuestions();

    // ==========================================
    // User Management & Analytics
    // ==========================================

    window.loadUsersList = async () => {
        const usersList = document.getElementById('usersList');
        const usersLoading = document.getElementById('usersLoading');
        
        if (!usersList) return;
        
        usersList.innerHTML = '';
        usersLoading.classList.remove('hidden');
        
        try {
            const users = await api.request('/users', 'GET');
            usersLoading.classList.add('hidden');
            
            if (users.length === 0) {
                usersList.innerHTML = '<tr><td colspan="5" class="text-center py-8 text-gray-500 italic text-sm">No students found.</td></tr>';
                return;
            }
            
            // Principals and admins can reset a forgotten student password.
            const canResetPassword = user.role === 'principal' || user.role === 'admin';
            // Every role that reaches this panel can open a student's analytics.
            // Faculty are subject-scoped by the API; principal/admin see all.
            const canViewAnalytics = true;
            // Only principals (and admins) can bulk-move students between sections
            const canMoveSections = user.role === 'principal' || user.role === 'admin';
            
            usersList.innerHTML = users.map(u => {
                const avgPct = (u.avg_score === null || u.avg_score === undefined)
                    ? '<span class="text-gray-400 text-xs italic">No tests</span>'
                    : `<span class="font-semibold ${u.avg_score >= 75 ? 'text-emerald-600' : u.avg_score >= 40 ? 'text-amber-600' : 'text-red-500'}">${u.avg_score.toFixed(1)}%</span>`;

                return `
                <tr class="hover:bg-gray-50 transition-colors">
                    <td class="py-3 px-6 text-gray-900 font-medium">${u.name}</td>
                    <td class="py-3 px-6 text-gray-600">${u.email}</td>
                    <td class="py-3 px-6">
                        ${u.batch_name 
                            ? `<span class="px-2.5 py-1 bg-indigo-50 text-indigo-600 rounded-full text-xs font-semibold border border-indigo-200">${u.batch_name}</span>` 
                            : `<span class="text-gray-400 text-xs italic">Unassigned</span>`}
                        ${canMoveSections ? `
                        <button onclick="moveStudentSection('${u.id}', '${u.name.replace(/'/g, "\\'")}', '${(u.batch_name || '').replace(/'/g, "\\'")}')" class="ml-1 text-purple-600 hover:text-purple-800 transition-colors" title="Move this student to another section">
                            <svg class="w-3.5 h-3.5 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"></path></svg>
                        </button>` : ''}
                    </td>
                    <td class="py-3 px-6 text-right">${avgPct}</td>
                    <td class="py-3 px-6 text-right">
                        <div class="flex gap-2 justify-end">
                            ${canResetPassword ? `
                            <button onclick="resetStudentPassword('${u.id}', '${u.email}')" class="text-xs bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded shadow-sm transition-colors flex items-center gap-1.5" title="Set a new password when the student forgets theirs">
                                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 2a8 8 0 11-16 0 8 8 0 0116 0zm-6 4a2 2 0 11-4 0 2 2 0 014 0zm-2-4v4"></path></svg>
                                Reset Password
                            </button>` : ''}
                            ${canViewAnalytics ? `
                            <button data-student-id="${u.id}" data-student-name="${String(u.name ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))}" onclick="openAnalyticsRow(this)" class="text-xs bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded shadow-sm transition-colors flex items-center gap-1.5">
                                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path></svg>
                            View Analytics
                            </button>` : ''}
                        </div>
                    </td>
                </tr>
            `;
            }).join('');
            
        } catch (error) {
            usersLoading.classList.add('hidden');
            usersList.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-red-500 text-sm">Error: ${error.message}</td></tr>`;
        }
    };

    // Principal/admin resets a student's forgotten password.
    // The backend also logs the student out of any active session.
    window.resetStudentPassword = async (userId, email) => {
        const newPassword = await notify.prompt(`Enter a new password for ${email}:`, {
            title: 'Reset Student Password',
            input: 'password',
            placeholder: 'Minimum 8 characters',
            required: true,
            requiredMessage: 'Password is required',
            confirmText: 'Reset Password',
        });
        if (newPassword === null) return; // cancelled
        if (newPassword.length < 8) {
            notify.error('Password must be at least 8 characters.');
            return;
        }

        const confirmed = await notify.confirm(
            `Set this as the new password for ${email}? The student will be logged out of any active session.`,
            { confirmText: 'Yes, reset it', danger: true }
        );
        if (!confirmed) return;

        try {
            await api.request(`/users/${userId}/password`, 'PUT', { new_password: newPassword });
            notify.success(`Password reset for ${email}. Share it with the student securely.`);
        } catch (error) {
            notify.error('Failed to reset password: ' + error.message);
        }
    };

    // ==========================================
    // Sections: bulk move students by test marks (principal/admin)
    // "Section" = the student's batch_name, which decides which
    // targeted exams they see. Preview is a dry run; apply re-runs
    // the exact same selection server-side and updates it.
    // ==========================================

    const btnSectionPreview = document.getElementById('btnSectionPreview');
    const btnSectionApply = document.getElementById('btnSectionApply');
    const sectionApplyLabel = document.getElementById('sectionApplyLabel');
    const sectionPreviewResults = document.getElementById('sectionPreviewResults');
    const sectionPreviewStatus = document.getElementById('sectionPreviewStatus');

    function sectionMoveCriteria() {
        const num = (el) => {
            const v = el.value.trim();
            if (v === '') return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        };
        return {
            current_section: document.getElementById('secMoveCurrent').value.trim(),
            target_section: document.getElementById('secMoveTarget').value.trim(),
            min_score: num(document.getElementById('secMoveMinScore')),
            max_score: num(document.getElementById('secMoveMaxScore')),
            min_exams: num(document.getElementById('secMoveMinExams')),
        };
    }

    function showSectionStatus(kind, message) {
        sectionPreviewStatus.classList.remove('hidden');
        sectionPreviewStatus.className = `mt-4 p-4 rounded-lg text-sm ${
            kind === 'error' ? 'bg-red-50 text-red-700 border border-red-200'
            : kind === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
            : 'bg-gray-50 text-gray-700 border border-gray-200'
        }`;
        sectionPreviewStatus.textContent = message;
    }

    function renderSectionPreview(data) {
        if (data.count === 0) {
            sectionPreviewResults.classList.add('hidden');
            btnSectionApply.classList.add('hidden');
            showSectionStatus('info', 'No students match these criteria. Try widening the score range or lowering the minimum exams.');
            return;
        }

        const c = data.criteria;
        const parts = [];
        parts.push(c.current_section ? `from "${c.current_section}"` : 'from any section');
        if (c.min_score !== null) parts.push(`avg ≥ ${c.min_score}%`);
        if (c.max_score !== null) parts.push(`avg ≤ ${c.max_score}%`);
        if (c.min_exams !== null) parts.push(`≥ ${c.min_exams} exam${c.min_exams === 1 ? '' : 's'}`);
        document.getElementById('sectionPreviewHeading').textContent = `Students moving to "${data.target_section}" — ${parts.join(', ')}`;
        document.getElementById('sectionPreviewCount').textContent = `${data.count} student${data.count === 1 ? '' : 's'}`;

        document.getElementById('sectionPreviewList').innerHTML = data.students.map(s => `
            <tr class="hover:bg-gray-50/50">
                <td class="py-2 px-4 text-gray-900">${s.name}<span class="block text-xs text-gray-400">${s.email}</span></td>
                <td class="py-2 px-4">
                    ${s.batch_name
                        ? `<span class="px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded-full text-xs font-semibold border border-indigo-200">${s.batch_name}</span>`
                        : '<span class="text-gray-400 text-xs italic">Unassigned</span>'}
                </td>
                <td class="py-2 px-4 text-right text-gray-600">${s.exams_taken}</td>
                <td class="py-2 px-4 text-right font-semibold ${s.avg_score >= 75 ? 'text-emerald-600' : s.avg_score >= 40 ? 'text-amber-600' : 'text-red-500'}">${s.avg_score.toFixed(1)}%</td>
            </tr>
        `).join('');

        sectionPreviewResults.classList.remove('hidden');
        sectionPreviewStatus.classList.add('hidden');
        sectionApplyLabel.textContent = `Move ${data.count} student${data.count === 1 ? '' : 's'} to "${data.target_section}"`;
        btnSectionApply.classList.remove('hidden');
    }

    btnSectionPreview.addEventListener('click', async () => {
        const criteria = sectionMoveCriteria();
        if (!criteria.target_section) {
            showSectionStatus('error', 'Enter the section to move students into.');
            return;
        }
        btnSectionPreview.disabled = true;
        sectionPreviewResults.classList.add('hidden');
        sectionPreviewStatus.classList.add('hidden');
        try {
            const data = await api.request('/users/sections/preview', 'POST', criteria);
            renderSectionPreview(data);
        } catch (error) {
            showSectionStatus('error', error.message);
        } finally {
            btnSectionPreview.disabled = false;
        }
    });

    btnSectionApply.addEventListener('click', async () => {
        const criteria = sectionMoveCriteria();
        if (!criteria.target_section) return; // preview already validated

        const confirmed = await notify.confirm(
            `Move all listed students to "${criteria.target_section}"? Their section change takes effect immediately — they'll see the new section's exams on their next dashboard refresh.`,
            { confirmText: 'Yes, move them', danger: true }
        );
        if (!confirmed) return;

        btnSectionApply.disabled = true;
        try {
            const res = await api.request('/users/sections/apply', 'POST', criteria);
            notify.success(res.message);
            showSectionStatus('success', res.message);
            btnSectionApply.classList.add('hidden');
            sectionPreviewResults.classList.add('hidden');
            loadUsersList();
        } catch (error) {
            showSectionStatus('error', 'Move failed: ' + error.message);
        } finally {
            btnSectionApply.disabled = false;
        }
    });

    // Single-student section move (pencil icon next to a student's section chip)
    window.moveStudentSection = async (userId, studentName, currentSection) => {
        const newSection = await notify.prompt(
            `Move ${studentName} from "${currentSection || 'Unassigned'}" to which section?`,
            {
                title: 'Move Student',
                input: 'text',
                inputPlaceholder: 'e.g. Section B',
                required: true,
                requiredMessage: 'Section name is required (max 60 characters)',
                confirmText: 'Move',
            }
        );
        if (newSection === null) return; // cancelled
        const target = newSection.trim();
        if (target && target === (currentSection || '').trim()) {
            notify.warning('That is already their current section.');
            return;
        }

        try {
            // Dedicated endpoint — changes exactly one student, nothing else.
            await api.request(`/users/${userId}/section`, 'PUT', { section: target });
            notify.success(`${studentName} moved to "${target}".`);
            loadUsersList();
        } catch (error) {
            notify.error('Failed to move student: ' + error.message);
        }
    };

    // ── Analytics: subject roster ────────────────────────────────────────
    // Every student's marks in the viewer's OWN subject. The scoping is enforced
    // in SQL by the server (see GET /analytics/subject) — faculty cannot ask for
    // another subject, so nothing from one can reach this table.
    const escStat = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));

    // Which analytics home screen this role lands on.
    window.showAnalyticsHome = function () {
        return user.role === 'principal' ? showClassOverview() : showSubjectRoster();
    };

    // ── Principal/admin: the whole college, ranked ──────────────────────
    window.showClassOverview = function () {
        document.getElementById('analyticsRoster').classList.add('hidden');
        document.getElementById('analyticsContent').classList.add('hidden');
        document.getElementById('analyticsOverview').classList.remove('hidden');

        document.getElementById('analyticsStudentName').textContent = 'Student Analytics';
        document.getElementById('analyticsSubtitle').textContent = 'Whole-college performance with every subject';
        document.getElementById('btnBackToStudents').classList.add('hidden');
        // Both admin and principal have a User Management tab to go back to.
        const backUsers = document.getElementById('btnBackToUsers');
        if (backUsers) backUsers.classList.toggle('hidden', user.role === 'faculty');

        loadClassOverview();
    };

    async function loadClassOverview() {
        const toppersGrid = document.getElementById('toppersGrid');
        const headRow = document.getElementById('classRankHeadRow');
        const body = document.getElementById('classRankBody');
        const status = document.getElementById('classRankStatus');

        toppersGrid.innerHTML = '<p class="col-span-full text-sm text-gray-500 animate-pulse py-6 text-center">Loading…</p>';
        body.innerHTML = '<tr><td colspan="4" class="py-6 text-center text-gray-500 animate-pulse">Loading…</td></tr>';
        status.classList.add('hidden');

        try {
            const data = await api.request('/analytics/overview', 'GET');
            const subjects = data.subjects || [];
            const students = data.students || [];
            const toppers = data.toppers || [];

            document.getElementById('classRankSubtitle').textContent =
                `${data.graded_count || 0} of ${data.count || 0} students have been graded · highest marks first`;
            document.getElementById('classRankCount').textContent =
                `${students.length} student${students.length === 1 ? '' : 's'}`;
            document.getElementById('toppersSubtitle').textContent =
                toppers.length ? 'Ranked by total marks across every subject' : 'No student has been graded yet';
            document.getElementById('toppersCount').textContent =
                toppers.length ? `top ${toppers.length}` : '';

            // ── Topper board ──
            const medal = ['bg-amber-100 text-amber-700 border-amber-300',
                           'bg-slate-100 text-slate-600 border-slate-300',
                           'bg-orange-100 text-orange-700 border-orange-300'];
            toppersGrid.innerHTML = toppers.length === 0
                ? '<p class="col-span-full text-sm text-gray-500 italic py-6 text-center">No marks recorded yet.</p>'
                : toppers.map((s, i) => `
                    <div class="border rounded-xl p-3 ${i < 3 ? medal[i] : 'bg-white/60 border-gray-200'}">
                        <div class="flex items-center justify-between">
                            <span class="text-xs font-bold">#${s.rank}</span>
                            <span class="text-xs text-gray-500 truncate" title="${escStat(s.batch_name || 'no section')}">${escStat(s.batch_name || '—')}</span>
                        </div>
                        <div class="font-semibold text-gray-900 text-sm mt-1 truncate" title="${escStat(s.student_name)}">${escStat(s.student_name)}</div>
                        <div class="text-xl font-bold text-gray-900 leading-tight">${s.total_scored}</div>
                        <div class="text-xs text-gray-500">marks${s.percentage === null ? '' : ` · ${s.percentage}%`}</div>
                    </div>`).join('');

            // ── One column per subject, then Total and Score ──
            headRow.innerHTML = `
                <th class="py-2 font-medium">#</th>
                <th class="py-2 font-medium">Student</th>
                ${subjects.map((s) => `<th class="py-2 font-medium text-right capitalize">${escStat(s)}</th>`).join('')}
                <th class="py-2 font-medium text-right">Total</th>
                <th class="py-2 font-medium text-right">Score</th>`;

            if (students.length === 0) {
                body.innerHTML = `<tr><td colspan="${subjects.length + 4}" class="py-6 text-center text-sm text-gray-500 italic">No students in this college yet.</td></tr>`;
                return;
            }

            body.innerHTML = students.map((s) => {
                const pct = s.percentage;
                const tone = pct === null ? 'text-gray-400'
                    : pct >= 60 ? 'text-emerald-600'
                    : pct >= 0 ? 'text-amber-600'
                    : 'text-red-600';

                const cells = subjects.map((subject) => {
                    const cell = s.subjects[subject];
                    if (!cell) return '<td class="py-2.5 text-right text-gray-300">—</td>';
                    return `<td class="py-2.5 text-right text-gray-700">${cell.scored}<span class="text-gray-400"> / ${cell.possible}</span></td>`;
                }).join('');

                return `
                    <tr class="hover:bg-gray-50/50 transition-colors cursor-pointer"
                        data-student-id="${escStat(s.student_id)}"
                        data-student-name="${escStat(s.student_name)}"
                        onclick="openAnalyticsRow(this)">
                        <td class="py-2.5 font-bold ${s.rank <= 3 ? 'text-amber-600' : 'text-gray-500'}">#${s.rank}</td>
                        <td class="py-2.5">
                            <div class="font-medium text-gray-800">${escStat(s.student_name)}</div>
                            <div class="text-xs text-gray-400">${escStat(s.student_email)}</div>
                        </td>
                        ${cells}
                        <td class="py-2.5 text-right font-semibold text-gray-900">${s.total_scored} <span class="text-gray-400 font-normal">/ ${s.total_possible}</span></td>
                        <td class="py-2.5 text-right font-bold ${tone}">${s.percentage === null ? '—' : s.percentage + '%'}</td>
                    </tr>`;
            }).join('');
        } catch (error) {
            toppersGrid.innerHTML = '';
            body.innerHTML = '';
            status.classList.remove('hidden');
            status.textContent = `Could not load the class overview: ${error.message}`;
        }
    }

    window.showSubjectRoster = function () {
        const roster = document.getElementById('analyticsRoster');
        const content = document.getElementById('analyticsContent');
        if (content) content.classList.add('hidden');
        document.getElementById('analyticsOverview').classList.add('hidden');
        if (roster) roster.classList.remove('hidden');

        document.getElementById('analyticsStudentName').textContent = 'Subject Analytics';
        document.getElementById('analyticsSubtitle').textContent = 'How each student scored in your subject';
        document.getElementById('btnBackToStudents').classList.add('hidden');

        // 'Back to Users' only makes sense where that tab exists (admin, principal).
        const backUsers = document.getElementById('btnBackToUsers');
        if (backUsers) backUsers.classList.toggle('hidden', user.role === 'faculty');

        loadSubjectRoster();
    };

    async function loadSubjectRoster() {
        const body = document.getElementById('analyticsRosterBody');
        const status = document.getElementById('analyticsRosterStatus');
        const count = document.getElementById('analyticsRosterCount');

        body.innerHTML = '<tr><td colspan="5" class="py-6 text-center text-gray-500 animate-pulse">Loading…</td></tr>';
        status.classList.add('hidden');
        count.textContent = '';

        try {
            const data = await api.request('/analytics/subject', 'GET');
            const students = data.students || [];

            // Admins have no subject, so their roster mixes subjects and needs the
            // Subject column; a faculty roster is single-subject by construction.
            const mixed = !data.subject;
            document.getElementById('thRosterSubject').classList.toggle('hidden', !mixed);
            document.getElementById('analyticsRosterTitle').textContent =
                mixed ? 'Student marks by subject' : `Student marks in ${data.subject}`;
            document.getElementById('analyticsRosterSubtitle').textContent = mixed
                ? 'Every subject — admin view'
                : 'Your subject only — other subjects are never included';
            count.textContent = `${students.length} row${students.length === 1 ? '' : 's'}`;

            if (students.length === 0) {
                body.innerHTML = '<tr><td colspan="5" class="py-6 text-center text-sm text-gray-500 italic">No student has taken an exam yet.</td></tr>';
                return;
            }

            body.innerHTML = students.map((s) => {
                const scored = Number(s.marks_scored ?? 0);
                const possible = Number(s.marks_possible ?? 0);
                const pct = s.percentage;
                // Negative marking can land below 0 — colour it red rather than
                // pretending a losing student scored nothing.
                const tone = pct === null ? 'text-gray-400'
                    : pct >= 60 ? 'text-emerald-600'
                    : pct >= 0 ? 'text-amber-600'
                    : 'text-red-600';

                // The name travels in a data attribute, not interpolated into a
                // JS string literal — a name like "O'Brien" would otherwise break
                // the onclick after HTML decodes it.
                return `
                    <tr class="hover:bg-gray-50/50 transition-colors cursor-pointer"
                        data-student-id="${escStat(s.student_id)}"
                        data-student-name="${escStat(s.student_name)}"
                        onclick="openAnalyticsRow(this)">
                        <td class="py-2.5">
                            <div class="font-medium text-gray-800">${escStat(s.student_name)}</div>
                            <div class="text-xs text-gray-400">${escStat(s.student_email)}</div>
                        </td>
                        <td class="py-2.5 ${mixed ? '' : 'hidden'}">
                            <span class="px-2 py-0.5 bg-gray-100 text-gray-600 rounded capitalize border border-gray-200">${escStat(s.subject)}</span>
                        </td>
                        <td class="py-2.5 text-center text-gray-600">${Number(s.exams_taken ?? 0)}</td>
                        <td class="py-2.5 text-right font-medium text-gray-800">${scored} <span class="text-gray-400 font-normal">/ ${possible}</span></td>
                        <td class="py-2.5 text-right font-bold ${tone}">${pct === null ? '—' : pct + '%'}</td>
                    </tr>`;
            }).join('');
        } catch (error) {
            body.innerHTML = '';
            status.classList.remove('hidden');
            status.textContent = `Could not load the roster: ${error.message}`;
        }
    }

    // Reads the row's data attributes so escaping stays the browser's job.
    window.openAnalyticsRow = function (row) {
        if (!row || !row.dataset) return;
        window.openAnalytics(row.dataset.studentId, row.dataset.studentName);
    };

    window.openAnalytics = (studentId, studentName) => {
        // Switch tab (the tab handler loads the roster; we replace it below)
        const navAnalytics = document.getElementById('navAnalytics');
        if (navAnalytics) navAnalytics.click();

        // Setup UI
        document.getElementById('analyticsStudentName').textContent = `${studentName}'s Analytics`;
        document.getElementById('analyticsSubtitle').textContent = user.role === 'faculty'
            ? 'Subject-scoped performance breakdown'
            : 'Full performance breakdown, every subject';
        document.getElementById('analyticsRoster').classList.add('hidden');
        document.getElementById('analyticsOverview').classList.add('hidden');
        document.getElementById('btnBackToStudents').classList.remove('hidden');

        const content = document.getElementById('analyticsContent');
        content.classList.remove('hidden');
        content.style.opacity = '0.5';

        loadAnalyticsData(studentId);
    };

    async function loadAnalyticsData(studentId) {
        try {
            const data = await api.request(`/analytics/student/${studentId}`, 'GET');
            
            // Overall Stats
            const overall = data.overall || { total_exams: 0, average_score: 0, total_correct: 0, total_wrong: 0, total_unattempted: 0 };
            document.getElementById('statTotalExams').textContent = overall.total_exams || 0;
            document.getElementById('statAvgScore').textContent = (overall.average_score || 0).toFixed(1) + '%';
            document.getElementById('statTotalCorrect').textContent = overall.total_correct || 0;
            document.getElementById('statTotalWrong').textContent = overall.total_wrong || 0;
            
            // Subject Performance (CSS Bars)
            const subjectsContainer = document.getElementById('analyticsSubjects');
            if (!data.subjects || data.subjects.length === 0) {
                subjectsContainer.innerHTML = '<p class="text-sm text-gray-500 italic">No subject data available.</p>';
            } else {
                subjectsContainer.innerHTML = data.subjects.map(sub => {
                    const total = sub.total_correct + sub.total_wrong;
                    const correctPct = total === 0 ? 0 : Math.round((sub.total_correct / total) * 100);
                    const wrongPct = total === 0 ? 0 : Math.round((sub.total_wrong / total) * 100);
                    
                    return `
                        <div>
                            <div class="flex justify-between text-sm mb-1">
                                <span class="font-medium text-gray-700 capitalize">${sub.subject}</span>
                                <span class="text-gray-500">${sub.total_correct} correct / ${sub.total_wrong} wrong</span>
                            </div>
                            <div class="w-full bg-gray-100 rounded-full h-3.5 flex overflow-hidden border border-gray-200">
                                <div class="bg-green-500 h-3.5 transition-all duration-1000" style="width: ${correctPct}%" title="${correctPct}% Correct"></div>
                                <div class="bg-red-500 h-3.5 transition-all duration-1000" style="width: ${wrongPct}%" title="${wrongPct}% Wrong"></div>
                            </div>
                        </div>
                    `;
                }).join('');
            }
            
            // Chapter Weaknesses
            const chaptersContainer = document.getElementById('analyticsChapters');
            if (!data.chapters || data.chapters.length === 0) {
                chaptersContainer.innerHTML = '<tr><td colspan="3" class="py-4 text-center text-sm text-gray-500 italic">No chapter data available.</td></tr>';
            } else {
                chaptersContainer.innerHTML = data.chapters.map(chap => `
                    <tr class="hover:bg-gray-50/50 transition-colors">
                        <td class="py-2.5 font-medium text-gray-800 text-xs truncate max-w-[200px]" title="${chap.chapter}">${chap.chapter}</td>
                        <td class="py-2.5 text-center text-xs">
                            <span class="px-2 py-0.5 bg-gray-100 text-gray-600 rounded capitalize border border-gray-200">${chap.subject}</span>
                        </td>
                        <td class="py-2.5 text-right font-bold text-red-500">${chap.total_wrong}</td>
                    </tr>
                `).join('');
            }
            
            document.getElementById('analyticsContent').style.opacity = '1';
            
        } catch (error) {
            document.getElementById('analyticsContent').style.opacity = '1';
            notify.error('Failed to load analytics: ' + error.message);
        }
    }

    // Load users on tab switch to 'users'
    const usersTabLink = document.querySelector('[data-tab="users"]');
    if (usersTabLink) {
        usersTabLink.addEventListener('click', () => {
            loadUsersList();
        });
    }

    // ─── Notifications ───────────────────────────────────────────────────────
    // In-app notification centre. Quota alerts are raised server-side when a
    // faculty member submits an exam for review and a blueprint subject is
    // missing, short, over its quota, or has no faculty assigned. The principal
    // can then message the responsible faculty straight from the alert, and the
    // faculty receive that message here.

    const canMessageFaculty = (user.role === 'principal' || user.role === 'admin');

    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));

    const NOTIF_STYLES = {
        quota_shortfall:    { ring: 'border-l-amber-400',  chip: 'bg-amber-100 text-amber-800',    label: 'Quota short' },
        quota_missing:      { ring: 'border-l-red-400',    chip: 'bg-red-100 text-red-700',        label: 'Nothing selected' },
        quota_excess:       { ring: 'border-l-orange-400', chip: 'bg-orange-100 text-orange-800',  label: 'Quota exceeded' },
        faculty_unassigned: { ring: 'border-l-purple-400', chip: 'bg-purple-100 text-purple-800',  label: 'No faculty' },
        task_completed:     { ring: 'border-l-emerald-400', chip: 'bg-emerald-100 text-emerald-700',   label: 'Task completed' },
        blueprint_assigned: { ring: 'border-l-sky-400',    chip: 'bg-sky-100 text-sky-800',        label: 'New task' },
        principal_message:  { ring: 'border-l-indigo-400', chip: 'bg-indigo-100 text-indigo-800',  label: 'Message' },
    };

    function updateNotifBadge(count) {
        const badge = document.getElementById('notifBadge');
        if (!badge) return;
        if (count > 0) {
            badge.textContent = count > 99 ? '99+' : String(count);
            badge.classList.remove('hidden');
            badge.classList.add('flex');
        } else {
            badge.classList.add('hidden');
            badge.classList.remove('flex');
        }
    }

    async function refreshNotifBadge() {
        try {
            const data = await api.request('/notifications?limit=1', 'GET');
            updateNotifBadge(data.unread_count || 0);
        } catch {
            // Badge is non-critical — never interrupt the panel for it.
        }
    }

    // Simple per-subject completion view: has each subject's faculty finished
    // filling its quota? Completed means the selected count matches the required
    // count exactly — deliberately coarse, one line per subject.
    window.loadQuotaStatus = async function () {
        const box = document.getElementById('quotaStatusSummary');
        if (!box) return;

        try {
            const data = await api.request('/notifications/quota-status', 'GET');
            const exams = data.exams || [];
            if (exams.length === 0) { box.innerHTML = ''; return; }

            box.innerHTML = `
                <div class="glass-panel rounded-xl p-5">
                    <div class="flex items-center justify-between gap-3 flex-wrap mb-3">
                        <h3 class="text-sm font-bold text-gray-700 uppercase tracking-wider">Subject completion</h3>
                        <span class="text-xs text-gray-400">Completed = selected questions match the blueprint quota</span>
                    </div>
                    <div class="space-y-4">
                        ${exams.map(ex => `
                            <div>
                                <div class="flex items-center gap-2 mb-1.5 flex-wrap">
                                    <span class="text-sm font-semibold text-gray-900">${esc(ex.title)}</span>
                                    <span data-exam-status="${esc(ex.status)}" class="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 border border-gray-200">${esc(String(ex.status || '').replace(/_/g, ' '))}</span>
                                    ${ex.all_completed ? '<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-200">All subjects completed</span>' : ''}
                                </div>
                                <div class="flex flex-wrap gap-2">
                                    ${(ex.subjects || []).map(s => {
                                        const cls = s.completed
                                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                            : 'bg-red-50 text-red-700 border-red-200';
                                        const label = s.completed ? '✓ Completed' : '✗ Not completed';
                                        const who = s.faculty === 0 ? ' · no faculty' : '';
                                        return `<span class="text-xs font-medium px-2.5 py-1 rounded-lg border ${cls}"><strong class="capitalize">${esc(s.subject)}</strong> — ${label} <span class="opacity-70">(${s.selected}/${s.required}${who})</span></span>`;
                                    }).join('')}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>`;
        } catch (e) {
            box.innerHTML = '';
            console.error('Could not load subject completion:', e);
        }
    };

    window.loadNotifications = async function () {
        const list = document.getElementById('notificationsList');
        const empty = document.getElementById('notificationsEmpty');
        if (!list) return;

        loadQuotaStatus();  // refresh the completion summary alongside the alerts
        list.innerHTML = '<p class="text-sm text-gray-500 italic">Loading notifications…</p>';

        try {
            const data = await api.request('/notifications?limit=100', 'GET');
            const items = data.notifications || [];
            updateNotifBadge(data.unread_count || 0);

            if (items.length === 0) {
                list.innerHTML = '';
                empty.classList.remove('hidden');
                return;
            }
            empty.classList.add('hidden');

            list.innerHTML = items.map((n) => {
                const style = NOTIF_STYLES[n.type] || NOTIF_STYLES.principal_message;
                const unread = !n.read_at;
                const actionable = canMessageFaculty && n.exam_id && n.subject && n.type !== 'principal_message';

                return `
                    <div class="glass-panel rounded-xl p-5 border-l-4 ${style.ring} ${unread ? '' : 'opacity-60'}">
                        <div class="flex items-start justify-between gap-4">
                            <div class="flex-1 min-w-0">
                                <div class="flex items-center gap-2 flex-wrap mb-1.5">
                                    <span class="text-xs font-bold px-2 py-0.5 rounded ${style.chip}">${esc(style.label)}</span>
                                    ${unread ? '<span class="w-2 h-2 rounded-full bg-indigo-500" title="Unread"></span>' : ''}
                                    <span class="text-xs text-gray-400">${new Date((n.created_at || 0) * 1000).toLocaleString()}</span>
                                </div>
                                <h3 class="font-semibold text-gray-900">${esc(n.title)}</h3>
                                <p class="text-sm text-gray-600 mt-1">${esc(n.message)}</p>
                            </div>
                            <div class="flex-none flex flex-col items-end gap-2">
                                ${actionable ? `<button onclick="messageFacultyFor('${esc(n.exam_id)}', '${esc(n.subject)}')" class="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-medium whitespace-nowrap transition-colors">Message faculty</button>` : ''}
                                ${unread
                                    ? `<button onclick="markNotifRead('${esc(n.id)}')" class="text-xs px-3 py-1.5 rounded-lg bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 transition-colors">Mark read</button>`
                                    : '<span class="text-xs text-gray-400">Read</span>'}
                            </div>
                        </div>
                    </div>`;
            }).join('');
        } catch (error) {
            list.innerHTML = `<p class="text-sm text-red-600">Failed to load notifications: ${esc(error.message)}</p>`;
        }
    };

    window.markNotifRead = async (id) => {
        try {
            await api.request(`/notifications/${id}/read`, 'PUT');
            loadNotifications();
        } catch (error) {
            notify.error('Failed to mark as read: ' + error.message);
        }
    };

    // Principal/admin → message every faculty responsible for a subject, so they
    // complete their part of the blueprint.
    window.messageFacultyFor = async (examId, subject) => {
        const text = await notify.prompt(
            `Message the ${subject} faculty asking them to complete their quota:`,
            { title: `Remind ${subject} faculty`, confirmText: 'Send' }
        );
        if (!text || !text.trim()) return;

        try {
            const res = await api.request('/notifications', 'POST', {
                exam_id: examId,
                subject: subject,
                message: text.trim(),
            });
            notify.success(`Reminder sent to ${res.sent} ${subject} faculty.`);
            loadNotifications();
        } catch (error) {
            notify.error('Failed to send reminder: ' + error.message);
        }
    };

    const btnMarkAllRead = document.getElementById('btnMarkAllRead');
    if (btnMarkAllRead) {
        btnMarkAllRead.addEventListener('click', async () => {
            try {
                await api.request('/notifications/read-all', 'POST');
                notify.success('All notifications marked as read.');
                loadNotifications();
            } catch (error) {
                notify.error('Failed to update notifications: ' + error.message);
            }
        });
    }

    // Keep the sidebar badge current without a manual refresh.
    refreshNotifBadge();
    setInterval(refreshNotifBadge, 30000);

});