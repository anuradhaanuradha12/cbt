// ─── Smoke test: quota-gap notifications ─────────────────────────────────────
// Verifies the exam-blueprint quota workflow end to end:
//
//   1. principal creates an exam with a subject blueprint
//   2. physics faculty fills only part of their quota
//   3. faculty submits for review -> the audit flags the subjects that are
//      short / missing / have no faculty, and notifies the principal
//   4. principal reads the notifications and messages the physics faculty
//   5. the physics faculty receives that message and can mark it read
//
// Usage:  node smoke-notifications.mjs      (dev server must be running on :8787)
// The throwaway exam it creates is deleted before the run finishes — otherwise
// it lingers at 'pending_principal_review' and clutters the principal's queue.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:8787';
const PASSWORD = 'demo12345';

let passed = 0;
let failed = 0;

function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else    { failed++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
}

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function login(email) {
  const { status, data } = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (status !== 200) throw new Error(`login failed for ${email} (${status}): ${JSON.stringify(data)}`);
  return data.token;
}

async function run() {
  console.log('QForge — quota-gap notification smoke test\n');

  const principalToken = await login('principal@example.com');
  const physicsToken   = await login('physics@cbt.local');
  const chemistryToken = await login('chemistry@cbt.local');

  // ── 1. Principal creates an exam with a blueprint ───────────
  console.log('1. Create exam with blueprint (physics:5, chemistry:3, general:2)');
  const created = await api('/exams', {
    method: 'POST',
    token: principalToken,
    body: {
      title: 'Quota Alert Smoke Test',
      description: 'Created by smoke-notifications.mjs',
      exam_type: 'custom',
      duration_minutes: 180,
      total_marks: 40,
      subject_quotas: { physics: 5, chemistry: 3, general: 2 },
    },
  });
  check('exam created', created.status === 201, `status ${created.status}`);
  const examId = created.data.id;
  if (!examId) throw new Error('no exam id returned');

  // ── 2. Physics faculty fills only part of their quota ───────
  console.log('\n2. Physics faculty adds 2 of the 5 required questions');
  const pool = await api('/questions?subject=physics&limit=5', { token: physicsToken });
  const ids = (pool.data.data ?? []).slice(0, 2).map((q) => ({ id: q.id }));
  check('fetched physics questions', ids.length === 2, `${ids.length} found`);

  if (ids.length > 0) {
    const added = await api(`/exams/${examId}/questions`, {
      method: 'PUT',
      token: physicsToken,
      body: { question_ids: ids },
    });
    check('questions added to exam', added.status === 200, `status ${added.status}`);
  }

  // ── 3. Submit for review — the audit should fire ────────────
  console.log('\n3. Faculty submits for principal review');
  const submitted = await api(`/exams/${examId}/submit-for-review`, { method: 'POST', token: physicsToken });
  check('submit-for-review accepted', submitted.status === 200, `status ${submitted.status}`);

  const quotaStatus = submitted.data.quota_status ?? [];
  const bySubject = Object.fromEntries(quotaStatus.map((g) => [g.subject, g]));

  check('physics flagged as under quota (2/5)',
    bySubject.physics?.status === 'under' && bySubject.physics?.selected === 2 && bySubject.physics?.required === 5,
    JSON.stringify(bySubject.physics && { required: bySubject.physics.required, selected: bySubject.physics.selected, status: bySubject.physics.status }));
  check('chemistry flagged as nothing selected (0/3)',
    bySubject.chemistry?.status === 'missing' && bySubject.chemistry?.selected === 0,
    JSON.stringify(bySubject.chemistry && { required: bySubject.chemistry.required, selected: bySubject.chemistry.selected, status: bySubject.chemistry.status }));
  check('general (2) has no faculty assigned',
    (bySubject.general?.faculty?.length ?? -1) === 0,
    `${bySubject.general?.faculty?.length} faculty found`);
  check('principal was notified', (submitted.data.principal_notifications_sent ?? 0) > 0,
    `${submitted.data.principal_notifications_sent} notification(s) created`);

  // ── 4. Principal reads the alerts and messages the faculty ──
  console.log('\n4. Principal reads notifications and messages the physics faculty');
  const inbox = await api('/notifications', { token: principalToken });
  const alerts = (inbox.data.notifications ?? []).filter((n) => n.exam_id === examId);
  check('principal received quota alert(s)', alerts.length > 0, `${alerts.length} for this exam`);
  check('unread count reported', (inbox.data.unread_count ?? 0) > 0, `${inbox.data.unread_count} unread`);

  const gap = alerts.find((n) => n.subject === 'physics');
  check('physics alert mentions the shortfall',
    !!gap && gap.type === 'quota_shortfall' && /2 of 5/.test(gap.message),
    gap ? gap.message : 'no physics alert found');

  const sent = await api('/notifications', {
    method: 'POST',
    token: principalToken,
    body: {
      exam_id: examId,
      subject: 'physics',
      message: 'Your physics quota is incomplete — please add the remaining questions and resubmit.',
    },
  });
  check('principal message sent to physics faculty', sent.status === 201, `status ${sent.status}, sent ${sent.data.sent}`);

  // ── 5. Faculty receives the message ─────────────────────────
  console.log('\n5. Physics faculty receives the principal\'s message');
  const facultyInbox = await api('/notifications', { token: physicsToken });
  const message = (facultyInbox.data.notifications ?? []).find(
    (n) => n.type === 'principal_message' && n.exam_id === examId
  );
  check('faculty received the message', !!message, message ? message.title : 'not found');

  if (message) {
    const read = await api(`/notifications/${message.id}/read`, { method: 'PUT', token: physicsToken });
    check('faculty marked it read', read.status === 200, `status ${read.status}`);

    const after = await api('/notifications', { token: physicsToken });
    const reread = (after.data.notifications ?? []).find((n) => n.id === message.id);
    check('read_at is now set', !!reread?.read_at);
  }

  // A different faculty must not be able to see or read that message.
  const chemInbox = await api('/notifications', { token: chemistryToken });
  const leaked = (chemInbox.data.notifications ?? []).find((n) => n.id === message?.id);
  check('message is not visible to other faculty', !leaked);

  if (message) {
    const stolen = await api(`/notifications/${message.id}/read`, { method: 'PUT', token: chemistryToken });
    check('other faculty cannot mark it read', stolen.status === 403, `status ${stolen.status}`);
  }

  // ── Clean up the throwaway exam so reruns stay idempotent ──
  try {
    const d1 = path.join(__dirname, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
    const file = fs.readdirSync(d1).filter(f => f.endsWith('.sqlite'))
      .map(f => ({ f, size: fs.statSync(path.join(d1, f)).size }))
      .sort((a, b) => b.size - a.size)[0].f;
    const db = new DatabaseSync(path.join(d1, file));
    db.prepare('DELETE FROM notifications WHERE exam_id = ?').run(examId);
    db.prepare('DELETE FROM exam_questions WHERE exam_id = ?').run(examId);
    db.prepare('DELETE FROM exam_attempts WHERE exam_id = ?').run(examId);
    db.prepare('DELETE FROM exams WHERE id = ?').run(examId);
    console.log(`\n   cleaned up test exam ${examId}`);
  } catch (e) {
    console.log(`\n   WARNING: could not clean up ${examId} — ${e.message}`);
  }

  console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error('\nTest aborted:', e.message);
  process.exit(1);
});
