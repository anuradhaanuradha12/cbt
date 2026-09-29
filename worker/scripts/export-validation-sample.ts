/**
 * Stratified 200-Question Validation Extractor
 *
 * Extracts exactly:
 * - 50 Easy   (~12-13 per Subject: Physics, Chemistry, Mathematics, Biology)
 * - 100 Medium (~25 per Subject: Physics, Chemistry, Mathematics, Biology)
 * - 50 Hard   (~12-13 per Subject: Physics, Chemistry, Mathematics, Biology)
 *
 * Generates an inspectable Markdown report with full question stems, options,
 * correct answers, Jev confidence, and rubric versions for human review.
 *
 * Run: npx tsx scripts/export-validation-sample.ts
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const isRemote = process.argv.includes('--remote');
const flags = isRemote ? '--remote' : '--local';

interface SampleRow {
  id: string;
  subject: string;
  chapter: string;
  difficulty: string;
  difficulty_confidence: number;
  difficulty_rubric_version: string;
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_answer: string;
}

const TARGETS: Record<string, Record<string, number>> = {
  physics:     { easy: 13, medium: 25, hard: 12 },
  chemistry:   { easy: 13, medium: 25, hard: 13 },
  mathematics: { easy: 12, medium: 25, hard: 13 },
  biology:     { easy: 12, medium: 25, hard: 12 },
};

async function queryD1(sql: string): Promise<any[]> {
  const cleanSql = sql.replace(/\s+/g, ' ').trim();
  const raw = execSync(`npx wrangler d1 execute cbt-platform ${flags} --command="${cleanSql.replace(/"/g, '\\"')}" --json`, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  const jsonStart = raw.indexOf('[');
  const jsonEnd = raw.lastIndexOf(']');
  if (jsonStart === -1 || jsonEnd === -1) return [];
  const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
  return parsed[0]?.results || [];
}

async function main() {
  console.log(`🔍 Extracting 200-question stratified validation sample from ${isRemote ? 'Remote Production' : 'Local'} D1...\n`);

  const allSamples: SampleRow[] = [];

  for (const [subject, diffTargets] of Object.entries(TARGETS)) {
    for (const [diff, count] of Object.entries(diffTargets)) {
      const sql = `
        SELECT id, subject, chapter, difficulty, difficulty_confidence, difficulty_rubric_version,
               question_text, option_a, option_b, option_c, option_d, correct_answer
        FROM questions
        WHERE difficulty_source = 'jev_auto' 
          AND LOWER(subject) = '${subject}' 
          AND difficulty = '${diff}'
        ORDER BY RANDOM()
        LIMIT ${count};
      `;

      const rows: SampleRow[] = await queryD1(sql);
      allSamples.push(...rows);
      console.log(`- ${subject.toUpperCase()} | ${diff.toUpperCase()}: Fetched ${rows.length}/${count}`);
    }
  }

  console.log(`\n✅ Total samples gathered: ${allSamples.length}`);

  // Generate Markdown Document
  let md = `# 🔬 Stratified Human Validation Sample (200 Questions)\n\n`;
  md += `**Environment:** ${isRemote ? 'Remote Production D1' : 'Local D1'}\n`;
  md += `**Generated At:** ${new Date().toISOString()}\n`;
  md += `**Purpose:** Pedagogical sanity check for TypeSafe Jev difficulty classification across Physics, Chemistry, Mathematics, and Biology.\n\n`;
  md += `| Target Subject | Easy Target | Medium Target | Hard Target | Total |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- |\n`;
  md += `| **Physics** | 13 | 25 | 12 | 50 |\n`;
  md += `| **Chemistry** | 13 | 25 | 13 | 51 |\n`;
  md += `| **Mathematics** | 12 | 25 | 13 | 50 |\n`;
  md += `| **Biology** | 12 | 25 | 12 | 49 |\n\n`;
  md += `---\n\n`;

  let idx = 1;
  for (const row of allSamples) {
    const diffIcon = row.difficulty === 'easy' ? '🟢 EASY' : row.difficulty === 'medium' ? '🟡 MEDIUM' : '🔴 HARD';
    const confPct = row.difficulty_confidence != null ? `${(row.difficulty_confidence * 100).toFixed(0)}%` : 'N/A';

    md += `### ${idx++}. ${row.subject.toUpperCase()} — *${row.chapter}* (ID: \`${row.id}\`)\n\n`;
    md += `> **Question:**\n> ${row.question_text.replace(/\n/g, '\n> ')}\n\n`;
    md += `- **A)** ${row.option_a || '(empty)'}\n`;
    md += `- **B)** ${row.option_b || '(empty)'}\n`;
    md += `- **C)** ${row.option_c || '(empty)'}\n`;
    md += `- **D)** ${row.option_d || '(empty)'}\n\n`;
    md += `**Correct Key:** \`${row.correct_answer}\`\n\n`;
    md += `**Human Reviewer Assessment (Check one):** [ ] Easy  |  [ ] Medium  |  [ ] Hard\n\n`;
    md += `<details>\n<summary><b>🔍 Click to Reveal Jev AI Classification & Metadata</b></summary>\n\n`;
    md += `- **Jev Assigned Difficulty:** \`${diffIcon}\`\n`;
    md += `- **Confidence:** \`${confPct}\`\n`;
    md += `- **Rubric Applied:** \`${row.difficulty_rubric_version || 'default'}\`\n`;
    md += `</details>\n\n`;
    md += `---\n\n`;
  }


  const outputPath = path.join(process.cwd(), 'docs', 'HUMAN_VALIDATION_SAMPLE_200.md');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, md, 'utf8');

  console.log(`📄 Exported complete 200-question validation artifact to:\n   ${outputPath}\n`);
}

main().catch(console.error);
