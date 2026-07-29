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
    if (user.role !== 'admin' && user.role !== 'faculty') {
        alert("Access Denied: Admins or Faculty only.");
        window.location.href = '/dashboard';
        return;
    }

    // Role-based UI updates
    document.getElementById('userName').textContent = user.name;
    if (user.role === 'admin') {
        document.getElementById('navUsers').classList.remove('hidden');
        document.getElementById('navUsers').classList.add('flex');
    } else if (user.subject) {
        const subjectBadge = document.getElementById('userSubject');
        subjectBadge.textContent = `(${user.subject})`;
        subjectBadge.classList.remove('hidden');
        
        // Show Pending Tasks tab for faculty
        const navTasks = document.getElementById('navTasks');
        navTasks.classList.remove('hidden');
        navTasks.classList.add('flex');
        
        // Hide Exam Draft panel and make Question Bank full width
        const questionsGrid = document.querySelector('#tab-questions .grid');
        if (questionsGrid) {
            questionsGrid.classList.remove('lg:grid-cols-[1fr_400px]');
            questionsGrid.classList.add('grid-cols-1');
            questionsGrid.children[1].style.display = 'none'; // hide right pane
        }
        
        // Switch to Pending Tasks tab by default
        setTimeout(() => navTasks.click(), 10);
        
        // Lock the subject filter to the faculty's subject
        const filterSubject = document.getElementById('filterSubject');
        if (filterSubject) {
            filterSubject.value = user.subject.toLowerCase();
            filterSubject.disabled = true;
            
            // Trigger change event to load chapters for this subject
            setTimeout(() => filterSubject.dispatchEvent(new Event('change')), 0);
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
        });
    });

    async function loadTasks(user) {
        const tasksList = document.getElementById('tasksList');
        tasksList.innerHTML = '<div class="text-gray-600 text-center animate-pulse py-8">Loading tasks...</div>';
        
        try {
            const res = await api.request('/exams?status=draft');
            const exams = res.filter(e => {
                if (!e.subject_quotas) return false;
                let quotas = {};
                try { quotas = JSON.parse(e.subject_quotas); } catch(e) {}
                // If user has a subject, only show if there's a quota for it
                if (user.subject && !quotas[user.subject]) return false;
                return true;
            });
            
            if (exams.length === 0) {
                tasksList.innerHTML = '<p class="text-gray-500 text-sm text-center py-8 italic bg-gray-50/30 rounded-lg border border-dashed border-gray-200">No pending tasks found for your subject.</p>';
                return;
            }
            
            tasksList.innerHTML = exams.map(exam => {
                let quotas = {};
                try { quotas = JSON.parse(exam.subject_quotas); } catch(e) {}
                const userQuota = user.subject ? quotas[user.subject] : JSON.stringify(quotas);
                
                return `
                <div class="p-5 bg-white/50 rounded-xl border border-gray-300 hover:border-amber-500/50 transition-colors">
                    <div class="flex justify-between items-start mb-3">
                        <div>
                            <h3 class="text-lg font-semibold text-gray-900">${exam.title}</h3>
                            <p class="text-sm text-gray-600 mt-1">${exam.description || 'No description'}</p>
                        </div>
                        <span class="px-3 py-1 bg-amber-500/20 text-amber-400 text-xs font-bold rounded-full border border-amber-500/30">
                            Quota: ${userQuota}
                        </span>
                    </div>
                    <div class="mt-4 flex gap-3">
                        <button onclick="startAutoSelect('${exam.id}', '${user.subject}', ${userQuota})" class="flex-1 bg-amber-600 hover:bg-amber-700 text-white font-medium rounded-lg text-sm px-4 py-2 transition-colors flex items-center justify-center gap-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"></path></svg>
                            Auto-Select Questions
                        </button>
                    </div>
                </div>
                `;
            }).join('');
            
        } catch (error) {
            tasksList.innerHTML = `<p class="text-red-400 text-sm">Failed to load tasks: ${error.message}</p>`;
        }
    }
    
    // Make startAutoSelect available globally for the inline onclick handler
    window.startAutoSelect = async (examId, subject, count) => {
        if (!subject) {
            alert('Admin users must select a subject first (not implemented in this prototype).');
            return;
        }
        
        // Ask for chapters
        const chaptersStr = prompt(`Enter chapters for ${subject} (comma separated) to auto-select ${count} questions:`);
        if (!chaptersStr) return;
        const chapters = chaptersStr.split(',').map(s => s.trim()).filter(Boolean);
        if (chapters.length === 0) return;
        
        try {
            const previewRes = await api.request(`/exams/${examId}/auto-select-preview`, 'POST', {
                subject, chapters, count
            });
            
            if (previewRes.length === 0) {
                alert('No questions found for the given criteria.');
                return;
            }
            
            if (confirm(`Found ${previewRes.length} questions (some might be previously used). Do you want to add them to this exam?`)) {
                await api.request(`/exams/${examId}/questions`, 'PUT', {
                    question_ids: previewRes.map(q => ({ id: q.id, marks: 4, negative_marks: 1 }))
                });
                alert('Successfully filled your quota for this exam!');
                loadTasks(user);
            }
        } catch (error) {
            alert('Failed auto-select: ' + error.message);
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

    async function loadQuestions() {
        loadingIndicator.classList.remove('hidden');
        loadingIndicator.classList.add('flex');
        questionsContainer.innerHTML = '';
        
        const subject = filterSubject.value;
        const chapter = filterChapter.value;
        const difficulty = filterDifficulty.value;
        
        let query = `/questions?page=${currentPage}&limit=${limit}`;
        if (subject) query += `&subject=${subject}`;
        if (chapter) query += `&chapter=${encodeURIComponent(chapter)}`;
        if (difficulty) query += `&difficulty=${difficulty}`;

        try {
            const response = await api.request(query);
            loadingIndicator.classList.add('hidden');
            loadingIndicator.classList.remove('flex');
            
            if (response.data.length === 0) {
                questionsContainer.innerHTML = '<p class="text-gray-500 text-sm text-center py-8 italic bg-gray-50/30 rounded-lg border border-dashed border-gray-200">No questions found.</p>';
                return;
            }
            
            pageInfo.textContent = `Page ${currentPage} of ${Math.ceil(response.total / limit) || 1}`;
            btnPrevPage.disabled = currentPage === 1;
            btnNextPage.disabled = currentPage >= Math.ceil(response.total / limit);
            
            response.data.forEach(q => {
                const isSelected = selectedQuestions.some(sq => sq.id === q.id);
                
                const card = document.createElement('div');
                card.className = `p-4 rounded-xl border transition-colors relative ${isSelected ? 'bg-indigo-500/10 border-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.1)]' : 'bg-gray-50 border-gray-200 hover:border-gray-300'}`;
                
                // Format options
                let optionsHtml = '';
                if (q.option_a && q.option_b) {
                    optionsHtml = `
                        <div class="grid grid-cols-2 gap-2 mt-3 text-sm text-gray-600">
                            <div class="bg-white/50 p-2 rounded border border-gray-300"><strong class="text-gray-700">A)</strong> ${q.option_a}</div>
                            <div class="bg-white/50 p-2 rounded border border-gray-300"><strong class="text-gray-700">B)</strong> ${q.option_b}</div>
                            ${q.option_c ? `<div class="bg-white/50 p-2 rounded border border-gray-300"><strong class="text-gray-700">C)</strong> ${q.option_c}</div>` : ''}
                            ${q.option_d ? `<div class="bg-white/50 p-2 rounded border border-gray-300"><strong class="text-gray-700">D)</strong> ${q.option_d}</div>` : ''}
                        </div>
                    `;
                }

                // Solution block (hidden by default)
                let solutionHtml = '';
                if (q.correct_answer || q.explanation) {
                    solutionHtml = `
                        <div class="solution-block hidden mt-4 p-3 bg-indigo-600/10 border border-emerald-500/20 rounded-lg text-sm">
                            <div class="font-bold text-indigo-600 mb-1">Correct Answer: ${q.correct_answer.toUpperCase()}</div>
                            ${q.explanation ? `<div class="text-emerald-100/80 mt-2 whitespace-pre-wrap">${q.explanation}</div>` : ''}
                            ${q.explanation_image_r2_key ? `<img src="/images/${q.explanation_image_r2_key}" class="mt-3 max-h-48 rounded border border-indigo-600/30" alt="Solution Image">` : ''}
                        </div>
                    `;
                }
                
                card.innerHTML = `
                    <div class="flex gap-2 flex-wrap mb-3 pr-24">
                        <span class="text-xs font-semibold px-2 py-1 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">${q.subject}</span>
                        <span class="text-xs font-semibold px-2 py-1 rounded bg-white text-gray-700 border border-gray-300">${q.difficulty}</span>
                        <span class="text-xs font-semibold px-2 py-1 rounded bg-white text-gray-700 border border-gray-300">${q.type}</span>
                    </div>
                    
                    <button class="add-btn absolute top-4 right-4 text-xs font-semibold px-4 py-2 rounded-lg transition-all border shadow-md ${isSelected ? 'bg-indigo-600/20 text-indigo-400 border-indigo-500/30 hover:bg-indigo-600/30' : 'bg-white text-gray-700 border-gray-300 hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-300'}">
                        ${isSelected ? '✓ Added' : '+ Add'}
                    </button>

                    <div class="text-sm text-gray-900 mt-2 font-medium leading-relaxed">${q.question_text}</div>
                    ${q.image_r2_key ? `<img src="/images/${q.image_r2_key}" class="mt-3 max-h-48 rounded border border-gray-300" alt="Question Image">` : ''}
                    
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
                addBtn.onclick = () => toggleQuestion(q, card, addBtn);
                
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
            selectedQuestions.push(question);
            cardElement.className = 'p-4 rounded-xl border transition-colors relative bg-indigo-500/10 border-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.1)]';
            btnElement.className = 'add-btn absolute top-4 right-4 text-xs font-semibold px-4 py-2 rounded-lg transition-all border shadow-md bg-indigo-600/20 text-indigo-400 border-indigo-500/30 hover:bg-indigo-600/30';
            btnElement.textContent = '✓ Added';
        }
        
        renderDraftList();
    }

    function renderDraftList() {
        draftCount.textContent = `${selectedQuestions.length} Qs`;
        
        if (selectedQuestions.length === 0) {
            draftList.innerHTML = '<p class="text-gray-500 text-sm text-center py-8 italic bg-gray-50/30 rounded-lg border border-dashed border-gray-200">No questions added yet.</p>';
            return;
        }
        
        draftList.innerHTML = '';
        selectedQuestions.forEach((q, index) => {
            const item = document.createElement('div');
            item.className = 'flex justify-between items-center p-3 border-b border-gray-200 text-sm';
            
            let preview = q.question_text.substring(0, 40).replace(/<[^>]+>/g, '');
            if (preview.length === 40) preview += '...';
            
            item.innerHTML = `
                <span class="text-gray-700"><strong class="text-gray-900">Q${index + 1}.</strong> ${preview}</span>
                <button class="text-red-400 hover:text-red-300 transition-colors p-1" title="Remove">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            `;
            
            item.querySelector('button').onclick = () => {
                selectedQuestions.splice(index, 1);
                renderDraftList();
                loadQuestions();
            };
            
            draftList.appendChild(item);
        });
    }

    // ==========================================
    // Exam Creation
    // ==========================================

    const examTypeSelect = document.getElementById('examType');
    const quotaInputsContainer = document.getElementById('quotaInputs');
    const quotaTotalLabel = document.getElementById('quotaTotalLabel');
    const examDurationInput = document.getElementById('examDuration');

    const subjects = ['physics', 'chemistry', 'maths', 'biology'];

    function renderQuotaInputs() {
        const type = examTypeSelect.value;
        quotaInputsContainer.innerHTML = '';
        
        let activeSubjects = [];
        if (type === 'jee') {
            activeSubjects = ['physics', 'chemistry', 'maths'];
            examDurationInput.value = 180;
        } else if (type === 'neet') {
            activeSubjects = ['physics', 'chemistry', 'biology'];
            examDurationInput.value = 200; // As requested, NEET time
        } else {
            activeSubjects = [...subjects];
            // Don't auto-change time for custom
        }

        activeSubjects.forEach(sub => {
            const div = document.createElement('div');
            
            let defaultVal = 0;
            if (type === 'jee') defaultVal = 25;
            if (type === 'neet' && (sub === 'physics' || sub === 'chemistry')) defaultVal = 45;
            if (type === 'neet' && sub === 'biology') defaultVal = 90;

            div.innerHTML = `
                <label class="block mb-1 text-xs font-medium text-gray-600 capitalize flex justify-between">
                    ${sub}
                    ${type === 'custom' ? `<input type="checkbox" class="quota-toggle" data-subject="${sub}" checked>` : ''}
                </label>
                <input type="number" min="0" data-subject="${sub}" value="${defaultVal}" class="quota-input bg-white border border-gray-300 text-gray-900 text-sm rounded focus:ring-indigo-600 focus:border-indigo-600 block w-full p-2 transition-colors">
            `;
            quotaInputsContainer.appendChild(div);
        });

        updateTotal();

        // Add listeners for total update
        document.querySelectorAll('.quota-input, .quota-toggle').forEach(el => {
            el.addEventListener('input', updateTotal);
            el.addEventListener('change', updateTotal);
        });
    }

    function updateTotal() {
        let total = 0;
        document.querySelectorAll('.quota-input').forEach(input => {
            const sub = input.dataset.subject;
            const toggle = document.querySelector(`.quota-toggle[data-subject="${sub}"]`);
            if (!toggle || toggle.checked) {
                total += parseInt(input.value || 0);
            }
        });
        quotaTotalLabel.textContent = `Total: ${total} Qs`;
    }

    if (examTypeSelect) {
        examTypeSelect.addEventListener('change', renderQuotaInputs);
        renderQuotaInputs(); // initial render
    }

    btnCreateExam.addEventListener('click', async () => {
        const title = document.getElementById('examTitle').value.trim();
        const description = document.getElementById('examDescription').value.trim();
        const duration = parseInt(document.getElementById('examDuration').value);
        const status = document.getElementById('examStatus').value;
        const examType = examTypeSelect ? examTypeSelect.value : 'custom';
        
        let subjectQuotas = {};
        let hasQuotas = false;
        
        if (examTypeSelect) {
            document.querySelectorAll('.quota-input').forEach(input => {
                const sub = input.dataset.subject;
                const toggle = document.querySelector(`.quota-toggle[data-subject="${sub}"]`);
                if (!toggle || toggle.checked) {
                    const count = parseInt(input.value || 0);
                    if (count > 0) {
                        subjectQuotas[sub] = count;
                        hasQuotas = true;
                    }
                }
            });
        }
        
        if (!hasQuotas) {
            subjectQuotas = null;
        }
        
        if (!title) {
            alert('Please enter an exam title.');
            return;
        }
        if (selectedQuestions.length === 0 && !subjectQuotas) {
            alert('Please add at least one question or specify subject quotas.');
            return;
        }
        if (status === 'published' && selectedQuestions.length === 0) {
            alert('Cannot publish an exam with no questions.');
            return;
        }
        
        let calculatedTotalMarks = selectedQuestions.length * 4;
        if (subjectQuotas && selectedQuestions.length === 0) {
            const totalQs = Object.values(subjectQuotas).reduce((a, b) => a + b, 0);
            calculatedTotalMarks = totalQs * 4;
        }
        
        btnCreateExam.disabled = true;
        btnCreateExam.innerHTML = `<div class="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div> Creating...`;
        
        try {
            const targetBatchVal = document.getElementById('targetBatch').value.trim();
            const payload = {
                title,
                description,
                exam_type: examType,
                duration_minutes: duration,
                total_marks: calculatedTotalMarks,
                target_batch: targetBatchVal ? targetBatchVal : undefined,
                subject_quotas: subjectQuotas,
                question_ids: selectedQuestions.map(q => ({ id: q.id, marks: 4, negative_marks: 1 }))
            };
            
            const createRes = await api.request('/exams', 'POST', payload);
            
            if (status === 'published') {
                const startsAtInput = document.getElementById('examStartsAt').value;
                const startsAt = startsAtInput ? Math.floor(new Date(startsAtInput).getTime() / 1000) : Math.floor(Date.now() / 1000);
                await api.request(`/exams/${createRes.id}/publish`, 'PUT', {
                    starts_at: startsAt
                });
            }
            
            alert(`Exam successfully created${status === 'published' ? ' and published' : ''}!`);
            
            selectedQuestions = [];
            document.getElementById('examTitle').value = '';
            document.getElementById('examDescription').value = '';
            document.getElementById('examStartsAt').value = '';
            renderDraftList();
            loadQuestions();
            
        } catch (error) {
            alert('Failed to create exam: ' + error.message);
        } finally {
            btnCreateExam.disabled = false;
            btnCreateExam.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path></svg> Create Exam`;
        }
    });

    // ==========================================
    // Bulk CSV Upload
    // ==========================================
    // CSV Download Template
    const btnDownloadTemplate = document.getElementById('btnDownloadTemplate');
    if (btnDownloadTemplate) {
        btnDownloadTemplate.addEventListener('click', () => {
            const csvContent = "name,email,password\nJohn Doe,john.doe@example.com,TempPass123!\nJane Smith,jane.smith@example.com,TempPass456!";
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
            const batchIdx = headers.indexOf('batch');

            if (nameIdx === -1 || emailIdx === -1 || passIdx === -1) {
                throw new Error('CSV must contain name, email, and password columns.');
            }

            const users = [];
            for (let i = 1; i < lines.length; i++) {
                const cols = lines[i].split(',').map(c => c.trim());
                if (cols.length >= 3) {
                    users.push({
                        name: cols[nameIdx],
                        email: cols[emailIdx],
                        password: cols[passIdx],
                        batch_name: batchIdx !== -1 ? cols[batchIdx] : null
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
        const subject = filterSubject.value;
        filterChapter.innerHTML = '<option value="">All Chapters</option>';
        if (!subject) return;

        try {
            const res = await api.request(`/questions/chapters?subject=${subject}`);
            res.chapters.forEach(chap => {
                const opt = document.createElement('option');
                opt.value = chap;
                opt.textContent = chap;
                filterChapter.appendChild(opt);
            });
        } catch (e) {
            console.error('Failed to load chapters:', e);
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
});
