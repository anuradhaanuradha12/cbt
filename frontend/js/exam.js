// exam.js - Handles the JEE-style examination interface logic
document.addEventListener('DOMContentLoaded', async () => {
    // Auth Check
    const token = api.getToken();
    if (!token) {
        window.location.href = 'index.html';
        return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const examId = urlParams.get('id');
    if (!examId) {
        alert("No exam ID provided!");
        window.location.href = 'dashboard.html';
        return;
    }

    // State Variables
    let examData = null;
    let attemptData = null;
    let questions = [];
    let currentIndex = 0;
    
    // Status maps for the grid (status can be: not-visited, not-answered, answered, review, answered-review)
    let questionStatuses = [];
    let responses = [];
    
    let timerInterval = null;
    let timeRemainingSeconds = 0;
    
    let blurStrikeCount = 0;
    const MAX_STRIKES = 3;

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

    // ==========================================
    // Core Functions
    // ==========================================

    async function initializeExam() {
        try {
            // 1. Fetch Exam Details (to get config)
            const examRes = await api.request(`/exams/${examId}`);
            examData = examRes.exam;
            
            if (examRes.is_early_access) {
                showInstructionScreen(examRes.server_time);
            } else {
                await startAttempt();
            }

        } catch (error) {
            console.error(error);
            alert("Failed to load exam details: " + error.message);
            window.location.href = 'dashboard.html';
        }
    }
    
    function showInstructionScreen(serverTime) {
        document.getElementById('mainExamLayout').style.display = 'none';
        const instScreen = document.getElementById('instructionScreen');
        instScreen.style.display = 'flex';
        
        document.getElementById('instExamTitle').textContent = examData.title;
        document.getElementById('instDuration').textContent = `${examData.config_snapshot?.duration_minutes || 180} mins`;
        document.getElementById('instMarks').textContent = examData.config_snapshot?.total_marks || '--';
        document.getElementById('instMarksCorrect').textContent = `+${examData.config_snapshot?.marks_correct || 4} marks`;
        document.getElementById('instMarksWrong').textContent = `-${examData.config_snapshot?.marks_wrong || 1} mark`;
        
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
                            alert("Please wait a few more seconds for the exam to unlock on the server.");
                            btnBegin.disabled = false;
                            btnBegin.textContent = 'Begin Exam Now';
                            return;
                        }
                        examData = newRes.exam;
                        
                        instScreen.style.display = 'none';
                        document.getElementById('mainExamLayout').style.display = 'grid';
                        
                        await startAttempt();
                    } catch (e) {
                        alert("Failed to start: " + e.message);
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
            const attemptRes = await api.request(`/exams/${examId}/attempts`, 'POST');
            attemptData = attemptRes.attempt;
            questions = attemptRes.questions;
            
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
            
            // Set Timer
            timeRemainingSeconds = examData.config_snapshot?.duration_minutes * 60 || 180 * 60;
            startTimer();
            
            // Set up Anti-Cheat Tracking
            setupAntiCheat(attemptData.id);

            // Render UI
            renderGrid();
            renderQuestion(0);
            
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
            alert("Failed to start attempt: " + error.message);
            window.location.href = 'dashboard.html';
        }
    }

    function startTimer() {
        updateTimerDisplay();
        timerInterval = setInterval(() => {
            timeRemainingSeconds--;
            updateTimerDisplay();
            
            if (timeRemainingSeconds <= 0) {
                clearInterval(timerInterval);
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
        
        questionNumber.textContent = `Question ${index + 1}`;
        questionText.innerHTML = q.question_text || 'No question text available.';
        
        if (q.image_r2_key) {
            questionText.innerHTML += `<br><img src="/images/${q.image_r2_key}" class="mt-3 max-h-64 rounded border border-slate-700" alt="Question Image">`;
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
                    <div class="option-text">${opt.text}</div>
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
        renderQuestion(currentIndex);
    });

    btnSubmit.addEventListener('click', () => {
        const answeredCount = questionStatuses.filter(s => s === 'answered' || s === 'answered-review').length;
        if (confirm(`You have answered ${answeredCount} out of ${questions.length} questions. Are you sure you want to submit?`)) {
            submitExam();
        }
    });

    function setupAntiCheat(attemptId) {
        const logEvent = (eventType, metadata) => {
            api.request('/events', 'POST', {
                attempt_id: attemptId,
                event_type: eventType,
                metadata: metadata
            }).catch(e => console.error('Failed to log event', e));
        };

        function handleStrike(reason) {
            blurStrikeCount++;
            logEvent('strike_issued', { reason, count: blurStrikeCount });
            
            if (blurStrikeCount >= MAX_STRIKES) {
                alert('ANTI-CHEAT TRIGGERED: You have violated exam policies 3 times. Your exam is being forcefully submitted.');
                submitExam();
            } else {
                alert(`WARNING [${blurStrikeCount}/${MAX_STRIKES}]: ${reason}. If you reach 3 warnings, your exam will be automatically submitted.`);
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
        const requestFullscreen = () => {
            const elem = document.documentElement;
            if (elem.requestFullscreen) elem.requestFullscreen();
            else if (elem.webkitRequestFullscreen) elem.webkitRequestFullscreen();
            else if (elem.msRequestFullscreen) elem.msRequestFullscreen();
        };

        // Try to request on first interaction if not already
        document.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                requestFullscreen();
            }
        }, { once: true });

        document.addEventListener('fullscreenchange', () => {
            if (!document.fullscreenElement) {
                handleStrike('Exiting fullscreen is prohibited during the exam');
                // Force an overlay or re-request (in modern browsers, re-requesting without user gesture is blocked)
            }
        });
    }

    async function submitExam() {
        clearInterval(timerInterval);
        btnSubmit.disabled = true;
        btnSubmit.textContent = 'Submitting...';
        
        try {
            // Format responses for backend
            const submissions = [];
            questions.forEach((q, index) => {
                if (responses[index] !== null && responses[index] !== '') {
                    submissions.push({
                        question_id: q.id,
                        response: String(responses[index])
                    });
                }
            });
            
            await api.request(`/submissions/${attemptData.id}`, 'POST', { responses: submissions });
            alert("Exam submitted successfully!");
            window.location.href = `results.html?id=${examId}`;
            
        } catch (error) {
            alert("Failed to submit exam: " + error.message);
            btnSubmit.disabled = false;
            btnSubmit.textContent = 'Submit Exam';
        }
    }

    // Start
    initializeExam();
});
