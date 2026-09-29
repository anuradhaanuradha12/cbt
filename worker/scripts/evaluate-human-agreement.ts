/**
 * Compute Blind Human Reviewer Agreement & Confusion Matrix
 *
 * Usage:
 *   npx tsx scripts/evaluate-human-agreement.ts --input=docs/HUMAN_VALIDATION_SAMPLE_200.md
 *
 * Parses completed reviewer annotations (e.g. [x] Easy, [x] Medium, [x] Hard),
 * compares against Jev assigned difficulties, and outputs:
 *  1. Overall & Subject-wise Agreement %
 *  2. 3x3 Confusion Matrix (Human vs Jev)
 *  3. Critical Disagreements List (Easy <-> Hard)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

type Difficulty = 'easy' | 'medium' | 'hard';

interface EvaluationItem {
  id: string;
  subject: string;
  chapter: string;
  humanDiff: Difficulty | null;
  jevDiff: Difficulty;
  confidence: number;
}

async function main() {
  const samplePath = path.join(process.cwd(), 'docs', 'HUMAN_VALIDATION_SAMPLE_200.md');
  if (!fs.existsSync(samplePath)) {
    console.error(`❌ Validation file not found at: ${samplePath}`);
    console.error('Run scripts/export-validation-sample.ts first.');
    process.exit(1);
  }

  const content = fs.readFileSync(samplePath, 'utf8');
  const sections = content.split(/### \d+\./g).slice(1);

  const items: EvaluationItem[] = [];

  for (const sec of sections) {
    const idMatch = sec.match(/ID:\s*`([^`]+)`/);
    const id = idMatch ? idMatch[1] : '';

    const headerMatch = sec.match(/^\s*([A-Z]+)\s*—\s*\*([^*]+)\*/);
    const subject = headerMatch ? headerMatch[1].toLowerCase() : 'unknown';
    const chapter = headerMatch ? headerMatch[2] : 'unknown';

    // Parse Jev Diff
    const jevMatch = sec.match(/Jev Assigned Difficulty:\s*`[^`]*(EASY|MEDIUM|HARD)[^`]*`/i);
    const jevDiff = jevMatch ? (jevMatch[1].toLowerCase() as Difficulty) : 'medium';

    // Parse Confidence
    const confMatch = sec.match(/Confidence:\s*`(\d+)%`/);
    const confidence = confMatch ? parseInt(confMatch[1], 10) / 100 : 0.5;

    // Parse Human Reviewer selection: [x] or [X]
    let humanDiff: Difficulty | null = null;
    if (/\[[xX]\]\s*Easy/i.test(sec)) humanDiff = 'easy';
    else if (/\[[xX]\]\s*Medium/i.test(sec)) humanDiff = 'medium';
    else if (/\[[xX]\]\s*Hard/i.test(sec)) humanDiff = 'hard';

    items.push({ id, subject, chapter, humanDiff, jevDiff, confidence });
  }

  const reviewed = items.filter(it => it.humanDiff !== null);

  console.log('══════════════════════════════════════════════════════════════════');
  console.log('🔬 BLIND HUMAN REVIEW VS JEV EVALUATION REPORT');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`Total Samples Extracted : ${items.length}`);
  console.log(`Human Annotations Found : ${reviewed.length}`);

  if (reviewed.length === 0) {
    console.log('\n⚠️ No human annotations detected yet!');
    console.log('Open `docs/HUMAN_VALIDATION_SAMPLE_200.md` and mark checkboxes (e.g. `[x] Medium`)');
    return;
  }

  let matches = 0;
  const matrix: Record<Difficulty, Record<Difficulty, number>> = {
    easy:   { easy: 0, medium: 0, hard: 0 },
    medium: { easy: 0, medium: 0, hard: 0 },
    hard:   { easy: 0, medium: 0, hard: 0 },
  };

  const subjectStats: Record<string, { total: number; matches: number }> = {};
  const criticalDisagreements: EvaluationItem[] = [];

  for (const it of reviewed) {
    const h = it.humanDiff!;
    const j = it.jevDiff;

    if (!subjectStats[it.subject]) subjectStats[it.subject] = { total: 0, matches: 0 };
    subjectStats[it.subject].total++;

    matrix[h][j]++;

    if (h === j) {
      matches++;
      subjectStats[it.subject].matches++;
    } else if ((h === 'easy' && j === 'hard') || (h === 'hard' && j === 'easy')) {
      criticalDisagreements.push(it);
    }
  }

  const overallAccuracy = (matches / reviewed.length) * 100;

  console.log(`\nConcordance Rate: ${overallAccuracy.toFixed(1)}% (${matches}/${reviewed.length})\n`);

  console.log('Confusion Matrix (Rows: Human Expert, Columns: Jev AI):');
  console.log('                 Pred Easy | Pred Med | Pred Hard');
  console.log(`Human Easy     : ${String(matrix.easy.easy).padStart(9)} | ${String(matrix.easy.medium).padStart(8)} | ${String(matrix.easy.hard).padStart(9)}`);
  console.log(`Human Medium   : ${String(matrix.medium.easy).padStart(9)} | ${String(matrix.medium.medium).padStart(8)} | ${String(matrix.medium.hard).padStart(9)}`);
  console.log(`Human Hard     : ${String(matrix.hard.easy).padStart(9)} | ${String(matrix.hard.medium).padStart(8)} | ${String(matrix.hard.hard).padStart(9)}`);

  console.log('\nSubject-Wise Agreement:');
  for (const [sub, stat] of Object.entries(subjectStats)) {
    const pct = ((stat.matches / stat.total) * 100).toFixed(1);
    console.log(`- ${sub.toUpperCase().padEnd(12)}: ${pct}% (${stat.matches}/${stat.total})`);
  }

  if (criticalDisagreements.length > 0) {
    console.log('\n⚠️ Severe Disagreements (Easy ↔ Hard):');
    for (const cd of criticalDisagreements) {
      console.log(`- [${cd.subject.toUpperCase()}] ID: ${cd.id} | Human: ${cd.humanDiff?.toUpperCase()} vs Jev: ${cd.jevDiff.toUpperCase()} (${(cd.confidence * 100).toFixed(0)}% conf)`);
    }
  } else {
    console.log('\n✅ Zero severe Easy ↔ Hard polar disagreements found.');
  }

  console.log('══════════════════════════════════════════════════════════════════');
}

main().catch(console.error);
