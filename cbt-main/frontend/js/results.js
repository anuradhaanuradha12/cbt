// results.js - Display student's post-exam results
document.addEventListener('DOMContentLoaded', async () => {
    // Auth Check
    const token = api.getToken();
    if (!token) {
        window.location.href = '/';
        return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const examId = urlParams.get('id');
    if (!examId) {
        await notify.alert("No exam ID provided!", { icon: 'error' });
        window.location.href = '/dashboard';
        return;
    }

    const loadingIndicator = document.getElementById('loadingIndicator');
    const resultsContent = document.getElementById('resultsContent');
    const answerList = document.getElementById('answerList');

    async function loadResults() {
        try {
            // First fetch exam details for the title
            const examRes = await api.request(`/exams/${examId}`);
            document.getElementById('examTitle').textContent = `Results: ${examRes.exam.title}`;

            // Fetch submission results
            const resultRes = await api.request(`/submissions/${examId}`);
            const { submission, answers } = resultRes;

            // Update stats
            document.getElementById('totalScore').textContent = submission.score;
            document.getElementById('totalCorrect').textContent = submission.total_correct;
            document.getElementById('totalWrong').textContent = submission.total_wrong;
            document.getElementById('totalUnattempted').textContent = submission.total_unattempted;

            // Render Answers
            answerList.innerHTML = '';
            answers.forEach((ans, idx) => {
                const item = document.createElement('div');
                
                let statusClass = 'unattempted';
                let statusText = 'Not Attempted';
                if (ans.is_correct === 1) { statusClass = 'correct'; statusText = 'Correct'; }
                else if (ans.is_correct === 0) { statusClass = 'wrong'; statusText = 'Wrong'; }

                item.className = `answer-item ${statusClass}`;
                
                let optionsHtml = '';
                if (ans.option_a) {
                    const opts = { 'A': ans.option_a, 'B': ans.option_b, 'C': ans.option_c, 'D': ans.option_d };
                    for (const [key, val] of Object.entries(opts)) {
                        if (val) {
                            let style = '';
                            if (key === ans.correct_answer) style = 'color: var(--success); font-weight: bold;';
                            else if (key === ans.selected_answer && statusClass === 'wrong') style = 'color: var(--danger); text-decoration: line-through;';
                            
                            optionsHtml += `<div style="margin-top: 0.5rem; ${style}"><strong>${key})</strong> ${api.renderRichText(val)}</div>`;
                        }
                    }
                }

                item.innerHTML = `
                    <div class="answer-header">
                        <span>Question ${idx + 1}</span>
                        <span class="${statusClass}" style="color: var(--${statusClass === 'unattempted' ? 'text-muted' : statusClass})">
                            ${statusText} (${ans.marks_awarded > 0 ? '+' : ''}${ans.marks_awarded} marks)
                        </span>
                    </div>
                    <div class="whitespace-pre-wrap">${api.renderRichText(ans.question_text)}</div>
                    ${ans.image_r2_key ? `<img src="/images/${ans.image_r2_key}?v=${ans.updated_at ?? ''}" class="mt-3 max-h-64 rounded border border-gray-300" alt="Question Image" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'[image unavailable — hard-refresh: Ctrl+Shift+R]',className:'text-xs text-gray-400'}))">` : ''}
                    <div style="margin-top: 1rem;">
                        ${optionsHtml}
                    </div>
                    <div style="margin-top: 1rem;">
                        <strong>Your Answer:</strong> ${ans.selected_answer || 'None'} <br>
                        <strong>Correct Answer:</strong> ${ans.correct_answer}
                    </div>
                    ${ans.explanation ? `
                        <div class="explanation whitespace-pre-wrap">
                            <strong>Explanation:</strong><br>
                            ${api.renderRichText(ans.explanation)}
                            ${ans.explanation_image_r2_key ? `<br><img src="/images/${ans.explanation_image_r2_key}" class="mt-3 max-h-48 rounded border border-gray-300" alt="Solution Image">` : ''}
                        </div>
                    ` : ''}
                `;
                answerList.appendChild(item);
            });

            loadingIndicator.style.display = 'none';
            resultsContent.style.display = 'block';

            // Trigger KaTeX if available
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
            loadingIndicator.innerHTML = `<span style="color:var(--danger)">Error loading results: ${error.message}</span>`;
            console.error(error);
        }
    }

    loadResults();
});
