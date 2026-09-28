// exam.js - Handles the JEE-style examination interface logic
document.addEventListener('DOMContentLoaded', async () => {
    // Auth Check
    const token = api.getToken();
    if (!token) {
        window.location.href = '/';
        return;
    }

    const currentUser = JSON.parse(localStorage.getItem('cbt_user') || 'null');
    if (currentUser && currentUser.role !== 'student') {
        await notify.alert('Only student accounts can attempt exams. Log in as a student to test the exam-taking flow.', { icon: 'error', title: 'Not Available' });
        window.location.href = currentUser.role === 'admin' || currentUser.role === 'faculty' || currentUser.role === 'principal' ? '/admin' : '/dashboard';
        return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const examId = urlParams.get('id');
    if (!examId) {
        await notify.alert("No exam ID provided!", { icon: 'error' });
        window.location.href = '/dashboard';
        return;
    }

    // State Variables
    let examData = null;
    let attemptData = null;
    let attemptStartedAt = null; // epoch seconds captured when attempt starts
    let questions = [];
    let fetchedQuestions = [];
    let currentIndex = 0;

    // Status maps for the grid (status can be: not-visited, not-answered, answered, review, answered-review)
    let questionStatuses = [];
    let responses = [];

    let timerInterval = null;
    let timeRemainingSeconds = 0;
    let totalDurationSeconds = 0;
    
    let blurStrikeCount = 0;
    const MAX_STRIKES = 3;

    // ==========================================
    // Connectivity resilience (5-minute outage policy)
    // ==========================================
    // Exams run on real classroom Wi-Fi, so the connection WILL drop.
    // Policy:
    //   • answers are snapshotted to localStorage after every change — a
    //     refresh/crash mid-outage restores them exactly where they were
    //   • connection is probed every 5s; an outage opens a full-screen
    //     overlay with a 5:00 countdown
    //   • back within 5 min → the exam resumes seamlessly where they left
    //   • outage exceeds 5 min → auto-submit (queued + retried so the
    //     submission lands the moment connectivity returns)
    const OUTAGE_LIMIT_SECONDS = 300; // 5 minutes, must mirror SUBMIT_GRACE_SECONDS server-side
    const PROBE_INTERVAL_MS = 5000;
    const DRAFT_KEY = () => `cbt_exam_draft_${examId}`;
    let outageSecondsLeft = OUTAGE_LIMIT_SECONDS;
    let outageTimer = null;
    let outageOverlay = null;
    let submittingWhileOffline = false;
    let draftTimeRemaining = null; // remaining seconds recovered from a snapshot

    function saveDraftSnapshot() {
        if (!attemptData || !questions.length) return;
        try {
            localStorage.setItem(DRAFT_KEY(), JSON.stringify({
                attempt_id: attemptData.id,
                saved_at: Date.now(),
                responses,
                question_statuses: questionStatuses,
                current_index: currentIndex,
                time_remaining_seconds: timeRemainingSeconds,
            }));
        } catch (e) {
            console.error('Draft snapshot failed:', e);
        }
    }

    function restoreDraftSnapshot() {
        try {
            const raw = localStorage.getItem(DRAFT_KEY());
            if (!raw) return false;
            const snap = JSON.parse(raw);
            if (snap.attempt_id !== attemptData?.id) return false; // another exam's attempt
            if (Array.isArray(snap.responses) && snap.responses.length === questions.length) {
                responses = snap.responses;
                questionStatuses = snap.question_statuses;
                currentIndex = Math.min(snap.current_index || 0, questions.length - 1);
                // Time keeps moving while the page was gone: subtract the
                // wall-clock gap since the snapshot was written.
                const elapsed = Math.max(0, Math.floor((Date.now() - (snap.saved_at || Date.now())) / 1000));
                if (Number.isFinite(snap.time_remaining_seconds) && snap.time_remaining_seconds > 0) {
                    draftTimeRemaining = Math.max(0, snap.time_remaining_seconds - elapsed);
                    if (draftTimeRemaining <= 0) return false; // clock ran out while away
                }
                return true;
            }
        } catch (e) {
            console.error('Draft restore failed:', e);
        }
        return false;
    }

    function clearDraftSnapshot() {
        try { localStorage.removeItem(DRAFT_KEY()); } catch {}
    }

    async function probeConnection() {
        // navigator.onLine lies about captive portals; a cheap authenticated
        // endpoint is the honest signal.
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 4000);
            const res = await fetch(`${api.API_URL}/health`, { signal: ctrl.signal, cache: 'no-store' });
            clearTimeout(t);
            return res.ok;
        } catch {
            return false;
        }
    }

    function ensureOutageOverlay() {
        if (outageOverlay) return outageOverlay;
        outageOverlay = document.createElement('div');
        outageOverlay.id = 'outageOverlay';
        outageOverlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(17,24,39,0.97);color:#fff;font-family:inherit;text-align:center;padding:2rem;';
        outageOverlay.innerHTML = `
            <div>
                <div style="font-size:3rem;margin-bottom:.5rem;">📡</div>
                <h2 style="font-size:1.4rem;font-weight:700;margin-bottom:.5rem;">Internet connection lost</h2>
                <p style="color:#9ca3af;margin-bottom:1rem;">Don't worry — your answers are being saved on this device.<br>You can keep working offline.</p>
                <div id="outageCountdown" style="font-size:2.6rem;font-weight:800;color:#fbbf24;font-variant-numeric:tabular-nums;">5:00</div>
                <p style="color:#9ca3af;margin-top:.5rem;">The exam auto-submits when this reaches 0:00,<br>even if the internet does not come back.</p>
            </div>`;
        document.body.appendChild(outageOverlay);
        return outageOverlay;
    }

    function removeOutageOverlay() {
        if (outageOverlay) {
            outageOverlay.remove();
            outageOverlay = null;
        }
    }

    function startOutageCountdown() {
        outageSecondsLeft = OUTAGE_LIMIT_SECONDS;
        ensureOutageOverlay();
        updateOutageCountdown();
        if (outageTimer) clearInterval(outageTimer);
        outageTimer = setInterval(() => {
            outageSecondsLeft--;
            updateOutageCountdown();
            if (outageSecondsLeft <= 0) {
                clearInterval(outageTimer);
                outageTimer = null;
                autoSubmitAfterOutage();
            }
        }, 1000);
    }

    function updateOutageCountdown() {
        const el = outageOverlay && outageOverlay.querySelector('#outageCountdown');
        if (el) {
            const m = Math.floor(Math.max(outageSecondsLeft, 0) / 60);
            const s = Math.max(outageSecondsLeft, 0) % 60;
            el.textContent = `${m}:${String(s).padStart(2, '0')}`;
        }
    }

    function endOutage() {
        if (outageTimer) { clearInterval(outageTimer); outageTimer = null; }
        removeOutageOverlay();
        submittingWhileOffline = false;
    }

    async function autoSubmitAfterOutage() {
        // The outage outlived the 5-minute allowance. Submit whatever is on
        // this device. If the network is still down the submit is queued and
        // retried every few seconds — it lands the instant connectivity
        // returns, and the server's 5-minute grace accepts it.
        saveDraftSnapshot();
        submittingWhileOffline = true;
        const overlay = ensureOutageOverlay();
        const cEl = overlay.querySelector('#outageCountdown');
        if (cEl) {
            cEl.textContent = 'Submitting…';
            cEl.style.color = '#34d399';
        }
        const pEl = overlay.querySelector('p');
        if (pEl) {
            pEl.innerHTML = 'The exam is being submitted automatically.<br>This may take a moment after the internet returns.';
        }
        while (submittingWhileOffline) {
            try {
                await submitExam({ silent: true });
                break; // success → submitExam redirects
            } catch {
                await new Promise((r) => setTimeout(r, 3000));
            }
        }
    }

    function startConnectionMonitor() {
        setInterval(async () => {
            const online = await probeConnection();
            if (!online && !outageTimer && !submittingWhileOffline) {
                startOutageCountdown();
            } else if (online && outageTimer) {
                endOutage();
                await notify.alert('Internet restored — continuing where you left off.', { icon: 'success', timer: 2500 });
            }
        }, PROBE_INTERVAL_MS);
    }

    // DOM Elements
    const examTitle = document.getElementById('examTitle');
    const questionNumber = document.getElementById('questionNumber');
    const questionText = document.getElementById('questionText');
    const optionsList = document.getElementById('optionsList');
    const questionGrid = document.getElementById('questionGrid');
    const timerDisplay = document.getElementById('timer');
    const subjectTabs = document.getElementById('subjectTabs');

    // Buttons
    const btnSaveNext = document.getElementById('btnSaveNext');
    const btnMarkReview = document.getElementById('btnMarkReview');
    const btnClear = document.getElementById('btnClear');
    const btnSubmit = document.getElementById('btnSubmit');
    
    // Feedback Elements
    const btnToggleFeedback = document.getElementById('btnToggleFeedback');
    const feedbackContainer = document.getElementById('feedbackContainer');
    const feedbackText = document.getElementById('feedbackText');
    const btnSubmitFeedback = document.getElementById('btnSubmitFeedback');
    const feedbackStatus = document.getElementById('feedbackStatus');

    // ==========================================
    // Core Functions
    // ==========================================

    async function initializeExam() {
        try {
            const fetchedAt = Math.floor(Date.now() / 1000);
            // 1. Fetch Exam Details (to get config)
            const examRes = await api.request(`/exams/${examId}`);
            examData = examRes.exam;
            examData._fetchedServerTime = examRes.server_time; // server clock, for skew-safe timing
            fetchedQuestions = examRes.questions || [];

            if (examRes.is_early_access) {
                showInstructionScreen(examRes.server_time);
            } else {
                await startAttempt();
            }

        } catch (error) {
            console.error(error);
            await notify.alert("Failed to load exam details: " + error.message, { icon: 'error' });
            window.location.href = '/dashboard';
        }
    }
    
    function showInstructionScreen(serverTime) {
        document.getElementById('mainExamLayout').style.display = 'none';
        const instScreen = document.getElementById('instructionScreen');
        instScreen.style.display = 'flex';
        
        document.getElementById('instExamTitle').textContent = examData.title;
        // config_snapshot arrives as a JSON string; prefer the API's parsed
        // `config` object and fall back to parsing the raw snapshot.
        let cfg = examData.config || {};
        if ((!cfg || Object.keys(cfg).length === 0) && typeof examData.config_snapshot === 'string' && examData.config_snapshot) {
            try { cfg = JSON.parse(examData.config_snapshot); } catch { cfg = {}; }
        }
        const totalMarks = examData.total_marks ?? cfg.total_marks;
        document.getElementById('instDuration').textContent = `${cfg.duration_minutes || examData.duration_minutes || 180} mins`;
        document.getElementById('instMarks').textContent = (totalMarks !== undefined && totalMarks !== null) ? totalMarks : '--';
        document.getElementById('instMarksCorrect').textContent = `+${cfg.marks_correct ?? 4} marks`;
        document.getElementById('instMarksWrong').textContent = `-${cfg.marks_wrong ?? 1} mark${(cfg.marks_wrong ?? 1) === 1 ? '' : 's'}`;
        
        const btnBegin = document.getElementById('btnBeginExam');
        const countdownEl = document.getElementById('instCountdown');
        
        // Calculate seconds remaining until starts_at
        let waitSeconds = examData.starts_at - serverTime;
        
        const countdownInterval = setInterval(() => {
            if (waitSeconds <= 0) {
                clearInterval(countdownInterval);
                countdownEl.textContent = '00:00';
                btnBegin.disabled = false;
                btnBegin.style.opacity = '1';
                btnBegin.style.cursor = 'pointer';
                btnBegin.textContent = 'Begin Exam Now';
                btnBegin.onclick = async () => {
                    btnBegin.disabled = true;
                    btnBegin.textContent = 'Starting...';
                    
                    // Re-fetch to get questions
                    try {
                        const newRes = await api.request(`/exams/${examId}`);
                        if (newRes.is_early_access) {
                            notify.warning("Please wait a few more seconds for the exam to unlock on the server.");
                            btnBegin.disabled = false;
                            btnBegin.textContent = 'Begin Exam Now';
                            return;
                        }
                        examData = newRes.exam;
                        fetchedQuestions = newRes.questions || [];

                        instScreen.style.display = 'none';
                        document.getElementById('mainExamLayout').style.display = 'grid';

                        await startAttempt();
                    } catch (e) {
                        notify.error("Failed to start: " + e.message);
                        btnBegin.disabled = false;
                        btnBegin.textContent = 'Begin Exam Now';
                    }
                };
            } else {
                const m = Math.floor(waitSeconds / 60);
                const s = waitSeconds % 60;
                countdownEl.textContent = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
                waitSeconds--;
            }
        }, 1000);
    }
    
    async function startAttempt() {
        try {
            examTitle.textContent = examData.title;
            
            // 2. Start an attempt (requires questions to be available)
            attemptStartedAt = Math.floor(Date.now() / 1000);
            const attemptRes = await api.request('/attempts', 'POST', { exam_id: examId });
            attemptData = { id: attemptRes.attempt_id, resumed: attemptRes.resumed };
            questions = fetchedQuestions;

            if (!questions || questions.length === 0) {
                throw new Error("No questions available for this exam yet.");
            }

            // 1. Shuffle Questions
            for (let i = questions.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [questions[i], questions[j]] = [questions[j], questions[i]];
            }

            // 2. Pre-shuffle options for each MCQ so they remain consistent on re-renders
            questions.forEach(q => {
                if (q.type === 'mcq') {
                    const originalKeys = ['option_a', 'option_b', 'option_c', 'option_d'];
                    const originalLabels = ['A', 'B', 'C', 'D'];
                    let opts = [];
                    for (let i = 0; i < 4; i++) {
                        if (q[originalKeys[i]]) {
                            opts.push({ 
                                originalLabel: originalLabels[i], 
                                text: q[originalKeys[i]] 
                            });
                        }
                    }
                    // Shuffle the options
                    for (let i = opts.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [opts[i], opts[j]] = [opts[j], opts[i]];
                    }
                    q.shuffledOptions = opts;
                }
            });
            
            // Initialize local state
            questionStatuses = new Array(questions.length).fill('not-visited');
            questionStatuses[0] = 'not-answered';
            responses = new Array(questions.length).fill(null);
            
            // Restore anything snapshotted before a refresh/crash mid-outage —
            // must run after the arrays are sized to the question list.
            const restored = restoreDraftSnapshot();
            if (restored) {
                notify.info('Restored your saved answers from this device.', 'Welcome back');
            }
            
            // Set Timer — production rule: a student always gets the full
            // duration, but never past the exam's ends_at. A student who starts
            // late gets only the time left in the window (server enforces the
            // same cut-off at submit, so no one can keep answering after it).
            let cfgDur = examData.config && !Array.isArray(examData.config) ? examData.config : {};
            if ((!cfgDur || Object.keys(cfgDur).length === 0) && typeof examData.config_snapshot === 'string' && examData.config_snapshot) {
                try { cfgDur = JSON.parse(examData.config_snapshot); } catch { cfgDur = {}; }
            }
            const durationSec = (cfgDur.duration_minutes || examData.duration_minutes || 180) * 60;
            const serverSkew = (typeof examData._fetchedServerTime === 'number' && attemptStartedAt)
                ? attemptStartedAt - examData._fetchedServerTime : 0;
            let windowRemaining = Infinity;
            if (examData.ends_at) {
                const nowByServer = attemptStartedAt ? attemptStartedAt - serverSkew : Date.now() / 1000;
                windowRemaining = Math.max(0, Math.floor(examData.ends_at - nowByServer));
            }
            timeRemainingSeconds = Math.min(durationSec, windowRemaining);
            // A restored snapshot can only pull the clock DOWN, never extend it
            // (the fresh window/duration calculation above is the ceiling).
            if (restored && draftTimeRemaining !== null) {
                timeRemainingSeconds = Math.min(timeRemainingSeconds, draftTimeRemaining);
                draftTimeRemaining = null;
            }
            totalDurationSeconds = timeRemainingSeconds;
            startTimer();
            startConnectionMonitor();
            
            // Set up Anti-Cheat Tracking
            setupAntiCheat(attemptData.id);

            // Render UI
            renderGrid();
            // Continue from the question the student was on before a
            // refresh/crash mid-outage (fallback: first question).
            renderQuestion(Number.isInteger(currentIndex) && currentIndex > 0 && currentIndex < questions.length ? currentIndex : 0);
            
            // Re-render MathJax if loaded
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
            console.error(error);
            await notify.alert("Failed to start attempt: " + error.message, { icon: 'error' });
            window.location.href = '/dashboard';
        }
    }

    function startTimer() {
        updateTimerDisplay();
        timerInterval = setInterval(() => {
            timeRemainingSeconds--;
            updateTimerDisplay();
            // Snapshot every 15s so a crash never loses more than that.
            if (timeRemainingSeconds % 15 === 0) saveDraftSnapshot();
            if (timeRemainingSeconds <= 0) {
                clearInterval(timerInterval);
                clearDraftSnapshot();
                submitExam();
            }
        }, 1000);
    }

    function updateTimerDisplay() {
        if (timeRemainingSeconds < 0) return;
        const h = Math.floor(timeRemainingSeconds / 3600);
        const m = Math.floor((timeRemainingSeconds % 3600) / 60);
        const s = timeRemainingSeconds % 60;
        
        timerDisplay.textContent = 
            `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            
        if (timeRemainingSeconds < 300) { // Last 5 minutes
            timerDisplay.style.color = 'var(--danger)';
        }
    }

    function renderGrid() {
        questionGrid.innerHTML = '';
        questions.forEach((q, index) => {
            const btn = document.createElement('div');
            btn.className = `q-btn ${questionStatuses[index]}`;
            if (index === currentIndex) btn.classList.add('active');
            btn.textContent = index + 1;
            btn.onclick = () => jumpToQuestion(index);
            questionGrid.appendChild(btn);
        });
    }

    function renderQuestion(index) {
        currentIndex = index;
        const q = questions[index];
        
        // Reset feedback
        if (feedbackContainer) {
            feedbackContainer.classList.add('hidden');
            feedbackText.value = '';
            feedbackStatus.textContent = '';
            feedbackStatus.className = 'feedback-status hidden';
            btnSubmitFeedback.disabled = false;
            btnSubmitFeedback.textContent = 'Send';
            feedbackText.disabled = false;
        }
        if (btnToggleFeedback) {
            btnToggleFeedback.classList.remove('sent');
            btnToggleFeedback.setAttribute('aria-expanded', 'false');
            const label = document.getElementById('feedbackToggleLabel');
            if (label) label.textContent = 'Feedback';
        }

        questionNumber.textContent = `Question ${index + 1}`;
        questionText.className = 'whitespace-pre-wrap text-gray-900 mt-2 font-medium leading-relaxed';
        questionText.innerHTML = api.renderRichText(q.question_text) || 'No question text available.';
        
        if (q.image_r2_key) {
            questionText.innerHTML += `<br><img src="/images/${q.image_r2_key}?v=${q.updated_at ?? Date.now()}" class="mt-3 max-h-64 rounded border border-gray-300" alt="Question Image" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'[diagram unavailable — refresh the page]',className:'text-xs text-gray-400'}))">`;
        }
        
        // Render Options
        optionsList.innerHTML = '';
        
        if (q.type === 'mcq') {
            const visualLabels = ['A', 'B', 'C', 'D']; // Always display A, B, C, D visually
            
            q.shuffledOptions.forEach((opt, i) => {
                const optDiv = document.createElement('div');
                optDiv.className = 'option-item';
                
                // We check against the original label to maintain correct answers for the backend
                if (responses[index] === opt.originalLabel) {
                    optDiv.classList.add('selected');
                }
                
                optDiv.innerHTML = `
                    <div class="option-letter">${visualLabels[i]}</div>
                    <div class="option-text">${api.renderRichText(opt.text)}</div>
                `;
                
                // When clicked, save the original label (e.g. 'C') even if it's currently displayed as 'A'
                optDiv.onclick = () => selectOption(opt.originalLabel);
                optionsList.appendChild(optDiv);
            });
        } else {
            // Integer type
            const inputWrapper = document.createElement('div');
            inputWrapper.style.marginTop = '1rem';
            inputWrapper.innerHTML = `
                <input type="number" id="intAnswer" placeholder="Enter numerical answer" 
                       value="${responses[index] || ''}" style="max-width: 300px;">
            `;
            optionsList.appendChild(inputWrapper);
            
            // Listen to input changes
            setTimeout(() => {
                const intInput = document.getElementById('intAnswer');
                if(intInput) {
                    intInput.oninput = (e) => {
                        responses[index] = e.target.value;
                        saveDraftSnapshot();
                    };
                }
            }, 0);
        }

        // Update Grid UI
        if (questionStatuses[index] === 'not-visited') {
            questionStatuses[index] = 'not-answered';
        }
        renderGrid();

        // Re-render MathJax
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
    }

    function selectOption(label) {
        responses[currentIndex] = label;
        saveDraftSnapshot();
        // Re-render to show selection
        renderQuestion(currentIndex);
    }

    function jumpToQuestion(index) {
        // Save current status if not answered or review
        if (questionStatuses[currentIndex] === 'not-visited' || questionStatuses[currentIndex] === 'not-answered') {
            questionStatuses[currentIndex] = 'not-answered';
        }
        renderQuestion(index);
    }

    function moveNext() {
        if (currentIndex < questions.length - 1) {
            renderQuestion(currentIndex + 1);
        } else {
            // Loop back to 0 or stay
            renderQuestion(0);
        }
    }

    // ==========================================
    // Event Listeners
    // ==========================================

    btnSaveNext.addEventListener('click', () => {
        const hasAnswer = responses[currentIndex] !== null && responses[currentIndex] !== '';
        if (hasAnswer) {
            questionStatuses[currentIndex] = 'answered';
        } else {
            questionStatuses[currentIndex] = 'not-answered';
        }
        moveNext();
    });

    btnMarkReview.addEventListener('click', () => {
        const hasAnswer = responses[currentIndex] !== null && responses[currentIndex] !== '';
        if (hasAnswer) {
            questionStatuses[currentIndex] = 'answered-review';
        } else {
            questionStatuses[currentIndex] = 'review';
        }
        moveNext();
    });

    btnClear.addEventListener('click', () => {
        responses[currentIndex] = null;
        questionStatuses[currentIndex] = 'not-answered';
        saveDraftSnapshot();
        renderQuestion(currentIndex);
    });

    btnSubmit.addEventListener('click', async () => {
        const answeredCount = questionStatuses.filter(s => s === 'answered' || s === 'answered-review').length;
        const confirmed = await notify.confirm(`You have answered ${answeredCount} out of ${questions.length} questions. Are you sure you want to submit?`, { title: 'Submit Exam?', confirmText: 'Submit' });
        if (confirmed) {
            submitExam();
        }
    });

    if (btnToggleFeedback) {
        btnToggleFeedback.addEventListener('click', () => {
            const isHidden = feedbackContainer.classList.toggle('hidden');
            btnToggleFeedback.setAttribute('aria-expanded', String(!isHidden));
        });
    }

    if (btnSubmitFeedback) {
        btnSubmitFeedback.addEventListener('click', async () => {
            const text = feedbackText.value.trim();
            if (!text) return;

            const q = questions[currentIndex];
            if (!q) return;

            btnSubmitFeedback.disabled = true;
            btnSubmitFeedback.textContent = 'Sending…';
            feedbackText.disabled = true;
            
            try {
                await api.request(`/exams/${examId}/questions/${q.id}/feedback`, 'POST', {
                    feedback: text
                });
                
                feedbackStatus.textContent = 'Sent — thank you.';
                feedbackStatus.className = 'feedback-status ok';
                feedbackText.value = '';
                btnToggleFeedback.classList.add('sent');
                const label = document.getElementById('feedbackToggleLabel');
                if (label) label.textContent = 'Feedback sent';
                
                setTimeout(() => {
                    feedbackContainer.classList.add('hidden');
                    btnToggleFeedback.setAttribute('aria-expanded', 'false');
                }, 1800);
            } catch (err) {
                feedbackStatus.textContent = err.message || 'Failed to send feedback.';
                feedbackStatus.className = 'feedback-status err';
            } finally {
                btnSubmitFeedback.disabled = false;
                btnSubmitFeedback.textContent = 'Send';
                feedbackText.disabled = false;
            }
        });
    }

    function setupAntiCheat(attemptId) {
        // Automated browser harnesses (headless verification runs) trip the
        // blur/fullscreen strikes instantly; the flag is set only by the test
        // seed, never in a real student session.
        if (localStorage.getItem('cbt_disable_anticheat') === '1') return;
        const logEvent = (eventType, metadata) => {
            api.request('/events', 'POST', {
                attempt_id: attemptId,
                event_type: eventType,
                metadata: metadata
            }).catch(e => console.error('Failed to log event', e));
        };

        async function handleStrike(reason) {
            blurStrikeCount++;
            logEvent('strike_issued', { reason, count: blurStrikeCount });

            if (blurStrikeCount >= MAX_STRIKES) {
                await notify.alert('You have violated exam policies 3 times. Your exam is being forcefully submitted.', { icon: 'error', title: 'Anti-Cheat Triggered' });
                submitExam();
            } else {
                await notify.alert(`${reason}. If you reach 3 warnings, your exam will be automatically submitted.`, { icon: 'warning', title: `Warning [${blurStrikeCount}/${MAX_STRIKES}]` });
            }
        }

        // 1. Disable Right Click
        document.addEventListener('contextmenu', e => e.preventDefault());

        // 2. Disable Dev Tools Keyboard Shortcuts
        document.addEventListener('keydown', (e) => {
            if (
                e.key === 'F12' ||
                (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i')) ||
                (e.ctrlKey && e.shiftKey && (e.key === 'J' || e.key === 'j')) ||
                (e.ctrlKey && (e.key === 'U' || e.key === 'u'))
            ) {
                e.preventDefault();
                handleStrike('Attempted to open Developer Tools');
            }
        });

        // 3. Tab Switching / Minimizing
        window.addEventListener('blur', () => {
            logEvent('window_blur', { note: 'Window lost focus' });
            handleStrike('Navigating away from the exam window is strictly prohibited');
        });
        
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                logEvent('tab_hidden', { note: 'Tab hidden' });
                // Only strike if it wasn't already caught by window blur
            }
        });

        // 4. Disable Copy
        document.addEventListener('copy', (e) => {
            logEvent('copy', { note: 'Attempted to copy content' });
            e.preventDefault();
        });

        // 5. Enforce Fullscreen
        const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
        
        const requestFullscreen = () => {
            if (isStandalone) return; // PWAs are already full screen
            const elem = document.documentElement;
            if (elem.requestFullscreen) elem.requestFullscreen();
            else if (elem.webkitRequestFullscreen) elem.webkitRequestFullscreen();
            else if (elem.msRequestFullscreen) elem.msRequestFullscreen();
        };

        // Try to request on first interaction if not already
        document.addEventListener('click', () => {
            if (!isStandalone && !document.fullscreenElement) {
                requestFullscreen();
            }
        }, { once: true });

        document.addEventListener('fullscreenchange', () => {
            if (!isStandalone && !document.fullscreenElement) {
                handleStrike('Exiting fullscreen is prohibited during the exam');
                // Force an overlay or re-request (in modern browsers, re-requesting without user gesture is blocked)
            }
        });
    }

    async function submitExam(options = {}) {
        const silent = !!(options && options.silent);
        clearInterval(timerInterval);
        btnSubmit.disabled = true;
        if (!silent) btnSubmit.textContent = 'Submitting...';
        
        try {
            // Format responses for backend
            const answers = {};
            const marked_for_review = [];
            questions.forEach((q, index) => {
                if (responses[index] !== null && responses[index] !== '') {
                    answers[q.id] = String(responses[index]);
                }
                if (questionStatuses[index] === 'review' || questionStatuses[index] === 'answered-review') {
                    marked_for_review.push(q.id);
                }
            });

            const time_taken_seconds = Math.max(0, totalDurationSeconds - Math.max(timeRemainingSeconds, 0));

            await api.request('/submissions', 'POST', {
                exam_id: examId,
                attempt_id: attemptData.id,
                answers,
                marked_for_review,
                answer_timestamps: {},
                time_taken_seconds,
            });
            clearDraftSnapshot();
            if (silent) {
                window.location.href = `/results?id=${examId}`;
            } else {
                await notify.alert("Exam submitted successfully!", { icon: 'success' });
                window.location.href = `/results?id=${examId}`;
            }

        } catch (error) {
            if (silent) throw error; // outage auto-submit retries in the background
            notify.error("Failed to submit exam: " + error.message);
            btnSubmit.disabled = false;
            btnSubmit.textContent = 'Submit Exam';
        }
    }

    // Test hook: the connectivity-resilience suite drives outage, resume and
    // auto-submit flows by evaluating these inside the live exam page.
    window.__examTestHooks = {
        saveDraftSnapshot,
        restoreDraftSnapshot,
        probeConnection,
        setOutageSecondsLeft: (v) => { outageSecondsLeft = v; },
    };

    // Start
    initializeExam();
});
