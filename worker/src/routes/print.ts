// ─── Print / OMR Routes ────────────────────────────────────────────────────────
// GET  /exams/:id/print-paper       — printable question paper + OMR sheet (admin/faculty)
// GET  /exams/:id/print-paper-omr  — OMR grid metadata JSON for scanner binding
// The paper is rendered as self-contained HTML with print CSS:
//   • questions in 2 columns
//   • one printed page per section (page-break control)
//   • an attached OMR sheet page generated from the same question list
//
// OMR scanning is intentionally client-side (js/scan.js). This backend only
// serves the printable layout and grid metadata; it does not accept scanned images.

import { requireAuth } from '../middleware/auth';
import { json404 } from '../middleware/responses';
import type { Env } from '../types';
import type { QuestionSafe } from '../../../shared/types';

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function latexPlaceholder(text: string): string {
  let out = '';
  let i = 0;
  const chars = [...text];
  while (i < chars.length) {
    if (chars[i] === '$' && chars[i + 1] === '$') {
      out += '$$';
      i += 2;
      let buf = '';
      while (i < chars.length && !(chars[i] === '$' && chars[i + 1] === '$')) {
        buf += chars[i];
        i += 1;
      }
      if (i < chars.length) {
        i += 2;
      }
      out += buf + '$$';
      continue;
    }
    if (chars[i] === '$') {
      out += '$';
      i += 1;
      let buf = '';
      while (i < chars.length && chars[i] !== '$') {
        buf += chars[i];
        i += 1;
      }
      if (i < chars.length) {
        i += 1;
      }
      out += buf + '$';
      continue;
    }
    out += escapeHtml(chars[i]);
    i += 1;
  }
  return out;
}

function renderQuestion(q: QuestionSafe, index: number, marks: number | undefined): string {
  const num = index + 1;
  const marksLabel = marks != null && marks > 0 ? marks : 4;
  const options = [
    q.option_a,
    q.option_b,
    q.option_c,
    q.option_d,
  ].map((opt, i) => {
    const label = String.fromCharCode(65 + i);
    const text = opt ? latexPlaceholder(escapeHtml(opt)) : '—';
    return `<div class="omr-opt"><span class="omr-opt-mark" data-i="${i}"></span><span class="omr-opt-label">${label}</span><span class="omr-opt-text">${text}</span></div>`;
  }).join('');

  const qtext = q.question_text ? latexPlaceholder(escapeHtml(q.question_text)) : '—';

  return `
    <section class="q" data-q="${num}">
      <div class="q-top">
        <span class="q-num">Q${num}</span>
        <span class="q-mark">${marksLabel} mark${marksLabel === 1 ? '' : 's'}</span>
      </div>
      <div class="q-body">
        <p class="q-text">${qtext}</p>
        <div class="q-opts">${options}</div>
      </div>
    </section>`;
}

function renderPaperHtml(payload: {
  exam: {
    title?: string | null;
    description?: string | null;
    duration_minutes?: number | null;
    total_marks?: number | null;
  };
  questions: QuestionSafe[];
}): string {
  const title = escapeHtml(payload.exam.title ?? 'Question Paper');
  const meta = [
    payload.exam.duration_minutes != null ? `<span>Duration: ${payload.exam.duration_minutes} minutes</span>` : '',
    payload.exam.total_marks != null ? `<span>Total Marks: ${payload.exam.total_marks}</span>` : '',
  ].filter(Boolean).join(' · ');

  const desc = payload.exam.description ? escapeHtml(payload.exam.description) : '';

  const questionsHtml = payload.questions.map((q, i) => renderQuestion(q, i, (q as QuestionSafe & { marks?: number }).marks)).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${title} — Printable Question Paper</title>
<style>
  :root {
    --text: #111;
    --muted: #555;
    --line: #999;
    --accent: #2563eb;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    font-family: "Inter", "Segoe UI", system-ui, Arial, sans-serif;
    color: var(--text);
    background: #fff;
  }
  .paper {
    max-width: 210mm;
    margin: 0 auto;
    padding: 14mm 16mm 18mm;
    font-size: 10.5pt;
    line-height: 1.45;
  }
  .paper-head {
    text-align: center;
    border-bottom: 2px solid var(--text);
    padding-bottom: 8mm;
    margin-bottom: 6mm;
  }
  .paper-head h1 {
    margin: 0 0 1.5mm 0;
    font-size: 19pt;
    letter-spacing: 0.3px;
  }
  .paper-head .meta {
    color: var(--muted);
    font-size: 10pt;
    margin-top: 2mm;
  }
  .paper-head .desc {
    color: var(--muted);
    font-size: 9.5pt;
    margin-top: 3mm;
    max-width: 170mm;
    margin-left: auto;
    margin-right: auto;
  }
  .columns {
    column-count: 2;
    column-gap: 8mm;
    column-rule: 1px solid var(--line);
  }
  .q {
    break-inside: avoid;
    margin-bottom: 6mm;
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 3mm 3mm 2mm;
    background: #fbfcfe;
  }
  .q-top {
    display: flex;
    justify-content: space-between;
    font-size: 8.5pt;
    color: var(--muted);
    letter-spacing: 0.4px;
    text-transform: uppercase;
    border-bottom: 1px dashed var(--line);
    padding-bottom: 1mm;
    margin-bottom: 1.5mm;
  }
  .q-num { color: var(--accent); font-weight: 700; }
  .q-text {
    margin: 0 0 2mm 0;
    font-size: 10pt;
    line-height: 1.4;
  }
  .q-opts {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.6mm 0;
  }
  .omr-opt {
    display: flex;
    align-items: baseline;
    gap: 2mm;
    padding: 0.6mm 0;
  }
  .omr-opt-mark {
    width: 4mm;
    height: 4mm;
    border: 1.2px solid var(--text);
    border-radius: 1mm;
    flex: 0 0 auto;
    background: #fff;
  }
  .omr-opt-label {
    font-weight: 700;
    width: 5mm;
    flex: 0 0 auto;
  }
  .omr-opt-text {
    flex: 1 1 auto;
  }

  .omr-page {
    page-break-before: always;
    break-before: page;
  }
  .omr-sheet {
    border: 2px solid var(--text);
    padding: 8mm 10mm;
    max-width: 210mm;
    margin: 0 auto;
  }
  .omr-sheet h2 {
    margin: 0 0 4mm 0;
    text-align: center;
    font-size: 15pt;
  }
  .omr-head {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 3mm 6mm;
    margin-bottom: 5mm;
    font-size: 9pt;
    border: 1px solid var(--line);
    padding: 3mm;
  }
  .omr-head .label { color: var(--muted); }
  .omr-head .val { font-weight: 700; }
  .omr-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 2mm;
  }
  .omr-row {
    break-inside: avoid;
    border: 1px solid var(--line);
    padding: 2.5mm;
    border-radius: 3px;
    background: #fff;
  }
  .omr-row-head {
    display: flex;
    justify-content: space-between;
    font-size: 8.5pt;
    text-transform: uppercase;
    color: var(--muted);
    letter-spacing: 0.4px;
    border-bottom: 1px dashed var(--line);
    margin-bottom: 1.5mm;
    padding-bottom: 1mm;
  }
  .omr-row-q {
    font-weight: 700;
    color: var(--accent);
  }
  .omr-row-opts {
    display: grid;
    grid-template-columns: repeat(4, auto);
    gap: 2mm 3mm;
    align-items: center;
  }
  .omr-bubble {
    display: flex;
    align-items: center;
    gap: 1.5mm;
  }
  .omr-bubble-mark {
    width: 5mm;
    height: 5mm;
    border: 1.4px solid var(--text);
    border-radius: 50%;
    flex: 0 0 auto;
    background: #fff;
  }
  .omr-bubble-label {
    font-weight: 700;
    font-size: 9pt;
  }
  .omr-foot {
    margin-top: 5mm;
    text-align: center;
    font-size: 8.5pt;
    color: var(--muted);
    border-top: 1px solid var(--line);
    padding-top: 3mm;
  }
  @media print {
    body { background: #fff; }
    .paper { max-width: none; padding: 12mm; }
  }
</style>
</head>
<body>
  <main class="paper">
    <header class="paper-head">
      <h1>${title}</h1>
      <div class="meta">${meta}</div>
      ${desc ? `<div class="desc">${desc}</div>` : ''}
    </header>

    <div class="columns">
      ${questionsHtml}
    </div>

    <section class="omr-page">
      <div class="omr-sheet">
        <h2>OMR Answer Sheet</h2>
        <div class="omr-head">
          <div><span class="label">Name:</span> <span class="val">&nbsp;</span></div>
          <div><span class="label">Roll No:</span> <span class="val">&nbsp;</span></div>
          <div><span class="label">Exam:</span> <span class="val">${escapeHtml(payload.exam.title ?? '')}</span></div>
          <div><span class="label">Date:</span> <span class="val">&nbsp;</span></div>
        </div>

        <div class="omr-grid">
          ${payload.questions.map((q, i) => {
            const num = i + 1;
            const marksForQ = (q as QuestionSafe & { marks?: number }).marks;
            const marksLabel = marksForQ != null && marksForQ > 0 ? marksForQ : 4;
            return `
            <div class="omr-row">
              <div class="omr-row-head">
                <span class="omr-row-q">Q${num}</span>
                <span>${marksLabel} mark${marksLabel === 1 ? '' : 's'}</span>
              </div>
              <div class="omr-row-opts">
                ${[0,1,2,3].map(j => `
                  <div class="omr-bubble">
                    <span class="omr-bubble-mark" data-q="${num}" data-opt="${j}"></span>
                    <span class="omr-bubble-label">${String.fromCharCode(65 + j)}</span>
                  </div>
                `).join('')}
              </div>
            </div>`;
          }).join('')}
        </div>

        <div class="omr-foot">
          Shade exactly one bubble per question. Use a blue/black ballpoint pen.
        </div>
      </div>
    </section>
  </main>
</body>
</html>`;
}

export interface OMRGridMeta {
  examId: string;
  examTitle: string | null;
  questionCount: number;
  rows: number;
  cols: number;
  bubblesPerQuestion: number;
  bubbleSizeMm: number;
  cellGapMm: number;
  marks: Array<{ q: number; marks: number }>;
}

export async function printPaperOmrMeta(request: Request, env: Env, examId: string): Promise<Response> {
  const { error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  const exam = await env.DB.prepare('SELECT * FROM exams WHERE id = ?').bind(examId).first<Record<string, unknown>>();
  if (!exam) return json404('Exam not found');

  const qRows = await env.DB.prepare(`
    SELECT q.*, eq.marks, eq.negative_marks, eq.order_index
    FROM exam_questions eq
    JOIN questions q ON q.id = eq.question_id
    WHERE eq.exam_id = ?
    ORDER BY eq.order_index
  `).bind(examId).all<Record<string, unknown>>();

  const questions: Array<QuestionSafe & { marks?: number }> = qRows.results.map((q) => {
    const marks = q.marks as number | null | undefined;
    const safe: QuestionSafe & { marks?: number } = {
      id: q.id as string,
      subject: q.subject as QuestionSafe['subject'],
      chapter: q.chapter as string,
      difficulty: q.difficulty as QuestionSafe['difficulty'],
      type: q.type as QuestionSafe['type'],
      question_text: q.question_text as string,
      option_a: q.option_a as string | undefined,
      option_b: q.option_b as string | undefined,
      option_c: q.option_c as string | undefined,
      option_d: q.option_d as string | undefined,
      image_r2_key: q.image_r2_key as string | undefined,
      marks: marks != null ? marks : undefined,
    };
    return safe;
  });

  const qCount = questions.length;
  const cols = 2;
  const rows = Math.ceil(qCount / cols);
  const bubblesPerQuestion = 4;
  const bubbleSizeMm = 5;
  const cellGapMm = 2;

  const marks: OMRGridMeta['marks'] = questions.map((q, i) => ({
    q: i + 1,
    marks: (q.marks != null && q.marks > 0 ? q.marks : 4),
  }));

  const meta: OMRGridMeta = {
    examId,
    examTitle: exam.title as string | null,
    questionCount: qCount,
    rows,
    cols,
    bubblesPerQuestion,
    bubbleSizeMm,
    cellGapMm,
    marks,
  };

  return new Response(JSON.stringify(meta, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function printPaper(request: Request, env: Env, examId: string): Promise<Response> {
  const { error } = await requireAuth(request, env, ['admin', 'faculty']);
  if (error) return error;

  const exam = await env.DB.prepare('SELECT * FROM exams WHERE id = ?').bind(examId).first<Record<string, unknown>>();
  if (!exam) return json404('Exam not found');

  const qRows = await env.DB.prepare(`
    SELECT q.*, eq.marks, eq.negative_marks, eq.order_index
    FROM exam_questions eq
    JOIN questions q ON q.id = eq.question_id
    WHERE eq.exam_id = ?
    ORDER BY eq.order_index
  `).bind(examId).all<Record<string, unknown>>();

  const questions: Array<QuestionSafe & { marks?: number }> = qRows.results.map((q) => {
    const marks = q.marks as number | null | undefined;
    const safe: QuestionSafe & { marks?: number } = {
      id: q.id as string,
      subject: q.subject as QuestionSafe['subject'],
      chapter: q.chapter as string,
      difficulty: q.difficulty as QuestionSafe['difficulty'],
      type: q.type as QuestionSafe['type'],
      question_text: q.question_text as string,
      option_a: q.option_a as string | undefined,
      option_b: q.option_b as string | undefined,
      option_c: q.option_c as string | undefined,
      option_d: q.option_d as string | undefined,
      image_r2_key: q.image_r2_key as string | undefined,
      marks: marks != null ? marks : undefined,
    };
    return safe;
  });

  const html = renderPaperHtml({
    exam: {
      title: exam.title as string | null,
      description: exam.description as string | null,
      duration_minutes: exam.duration_minutes as number | null,
      total_marks: exam.total_marks as number | null,
    },
    questions,
  });

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function printRouter(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response | null> {
  const method = request.method;

  const printMatch = pathname.match(/^\/exams\/([^/]+)\/print-paper$/);
  if (printMatch && method === 'GET') {
    return printPaper(request, env, printMatch[1]);
  }

  const omrMetaMatch = pathname.match(/^\/exams\/([^/]+)\/print-paper-omr$/);
  if (omrMetaMatch && method === 'GET') {
    return printPaperOmrMeta(request, env, omrMetaMatch[1]);
  }

  return null;
}
