/**
 * Batch Classifier for Existing Question Bank using TypeSafe Jev Model
 *
 * Mode 1: --limit=100 (Pilot 100 questions sanity inspection)
 * Mode 2: --limit=1000 (1,000 questions distribution check)
 * Mode 3: --all (Full batch across all unclassified questions)
 *
 * Supports:
 * - Resumable (skips questions where difficulty_source = 'jev_auto')
 * - Concurrency control & rate-limiting with exponential backoff
 * - D1 batch updates with atomic writes
 * - Live terminal progress bar & distribution reporting
 *
 * Usage:
 *   npx tsx scripts/classify-existing-questions.ts --limit=100
 *   npx tsx scripts/classify-existing-questions.ts --limit=1000
 *   npx tsx scripts/classify-existing-questions.ts --remote --limit=100
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const API_KEY = process.env.TYPESAFE_API_KEY || 'apikey_284e20454e8f0aa4b039216c00d0050b4bd_f7368307281e6ddef0d560698153dfbad0fe72f05ff47cbb8db768535392901d';
const API_URL = 'https://api.typesafe.ai/v1/systemone';

const args = process.argv.slice(2);
const isRemote = args.includes('--remote');
const isDryRun = args.includes('--dry-run');
const isAll = args.includes('--all');
const limitArg = args.find((a: string) => a.startsWith('--limit='));
const targetLimit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 500;
const subjectArg = args.find((a: string) => a.startsWith('--subject='));
const targetSubject = subjectArg ? subjectArg.split('=')[1].toLowerCase() : null;

const BATCH_SIZE = 45;       // Number of concurrent Jev requests per burst
const DB_BATCH_SIZE = 50;    // Number of SQL updates per D1 execute batch
const SHARD_ID = targetSubject || 'all';


interface QuestionRecord {
  id: string;
  subject: string;
  chapter: string;
  difficulty: string;
  question_text: string;
  option_a?: string | null;
  option_b?: string | null;
  option_c?: string | null;
  option_d?: string | null;
}

const RUBRIC_CRITERIA: Record<string, { instructions: string; criteria: Record<string, string> }> = {
  physics: {
    instructions: 'Classify high-school/competitive exam Physics question difficulty into easy, medium, or hard.',
    criteria: {
      easy: 'Single-step formula substitution (v=u+at, F=ma, Ohm law), direct conceptual definition, minimal algebra.',
      medium: 'Standard 2-3 step calculation, single unit conversion, standard kinematics/circuit/optics application.',
      hard: 'Multi-concept combination (mechanics + calculus, thermodynamics + electrostatics), non-standard algebra, deep reasoning.'
    }
  },
  chemistry: {
    instructions: 'Classify high-school/competitive exam Chemistry question difficulty into easy, medium, or hard.',
    criteria: {
      easy: 'Direct NCERT factual recall (periodic trends, IUPAC name, named reaction reagent, electronic configuration).',
      medium: 'Standard stoichiometry, buffer pH calculation, standard organic product prediction, equilibrium constant math.',
      hard: 'Multi-step organic synthesis roadmaps, complex ionic equilibrium, multi-statement assertion-reason with exceptions.'
    }
  },
  mathematics: {
    instructions: 'Classify high-school/competitive exam Mathematics question difficulty into easy, medium, or hard.',
    criteria: {
      easy: 'Standard single-step formula evaluation, direct derivative/integral of elementary function, basic matrix determinant.',
      medium: 'Standard 2-3 step algebraic manipulation, coordinate geometry tangent/normal, L’Hôpital limit, standard probability.',
      hard: 'Non-trivial substitution, multi-stage calculus, intricate geometric proof, interlocking theorem application.'
    }
  },
  biology: {
    instructions: 'Classify high-school/competitive exam Biology question difficulty into easy, medium, or hard.',
    criteria: {
      easy: 'Direct NCERT terminology or organelle/function recall, straightforward identification.',
      medium: 'Process sequencing, monohybrid/dihybrid Punnett square calculation, physiological cascade identification.',
      hard: 'Complex multi-statement assertion-reasoning, nuanced pedigree analysis, multi-gene linkage math.'
    }
  },
  general: {
    instructions: 'Classify academic question difficulty into easy, medium, or hard based on cognitive depth.',
    criteria: {
      easy: 'Single-step direct recall or application.',
      medium: 'Two-step application or standard domain reasoning.',
      hard: 'Multi-concept synthesis, complex logic, or advanced reasoning.'
    }
  }
};

async function queryD1(sql: string): Promise<any[]> {
  const flags = isRemote ? '--remote' : '--local';
  // Normalize SQL single-line for --command
  const cleanSql = sql.replace(/\s+/g, ' ').trim();

  try {
    const raw = execSync(`npx wrangler d1 execute cbt-platform ${flags} --command="${cleanSql.replace(/"/g, '\\"')}" --json`, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024, // 64 MB buffer for large question payload queries
      stdio: ['pipe', 'pipe', 'ignore'],
    });


    const jsonStart = raw.indexOf('[');
    const jsonEnd = raw.lastIndexOf(']');
    if (jsonStart === -1 || jsonEnd === -1) {
      throw new Error(`Invalid JSON in wrangler output: ${raw.slice(0, 150)}...`);
    }
    const jsonStr = raw.slice(jsonStart, jsonEnd + 1);
    const parsed = JSON.parse(jsonStr);
    return parsed[0]?.results || [];
  } catch (err: any) {
    throw new Error(`D1 query failed: ${err.message}`);
  }
}

async function executeD1Statements(statements: string[]): Promise<void> {
  if (statements.length === 0) return;
  const flags = isRemote ? '--remote' : '--local';
  const tmpFile = path.join(process.cwd(), `.tmp_batch_update_${SHARD_ID}_${Date.now()}.sql`);
  fs.writeFileSync(tmpFile, statements.join('\n'), 'utf8');

  let maxRetries = 6;
  let delayMs = 2500;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      execSync(`npx wrangler d1 execute cbt-platform ${flags} --file="${tmpFile}"`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      return;
    } catch (err: any) {
      if (attempt === maxRetries) {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        throw new Error(`D1 batch execute failed after ${maxRetries} attempts: ${err.message}`);
      }
      const jitter = Math.floor(Math.random() * 1500);
      const wait = delayMs + jitter;
      console.warn(`\n⚠️ D1 write contention detected on shard ${SHARD_ID}. Retrying in ${(wait/1000).toFixed(1)}s (Attempt ${attempt}/${maxRetries})...`);
      await new Promise(r => setTimeout(r, wait));
      delayMs *= 1.5;
    }
  }
}

async function classifyWithJev(q: QuestionRecord): Promise<{ difficulty: string; confidence: number }> {
  const sub = (q.subject || 'general').toLowerCase();
  const rubric = RUBRIC_CRITERIA[sub] || RUBRIC_CRITERIA.general;

  const payload = {
    state: {
      subject: q.subject,
      chapter: q.chapter,
      question: q.question_text,
      options: {
        A: q.option_a || null,
        B: q.option_b || null,
        C: q.option_c || null,
        D: q.option_d || null,
      }
    },
    model: 'jev-latest',
    questions: {
      difficulty: {
        type: 'choice',
        instructions: rubric.instructions,
        criteria: rubric.criteria
      }
    }
  };

  let retries = 2;
  while (retries >= 0) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);

      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          await new Promise(r => setTimeout(r, 1000 * (3 - retries)));
          retries--;
          continue;
        }
        throw new Error(`Jev HTTP ${res.status}`);
      }

      const data: any = await res.json();
      const ans = data.answers?.difficulty;
      if (ans && ans.choice) {
        return {
          difficulty: ans.choice.toLowerCase(),
          confidence: typeof ans.confidence === 'number' ? ans.confidence : 0.8
        };
      }
      throw new Error('Malformed Jev response');
    } catch (e) {
      if (retries === 0) throw e;
      retries--;
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  throw new Error('Jev classification retries exhausted');
}

function escapeSql(str?: string | null): string {
  if (!str) return 'NULL';
  return `'${str.replace(/'/g, "''")}'`;
}

async function main() {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`⚡ Jev Batch Question Classifier (${isRemote ? '🌐 Remote Production' : '💻 Local D1'})`);
  console.log(`🔬 Subject Shard: ${targetSubject ? targetSubject.toUpperCase() : 'ALL SUBJECTS'}`);
  console.log(`🎯 Target Limit : ${isAll ? 'ALL UNCLASSIFIED' : targetLimit} questions`);
  console.log('══════════════════════════════════════════════════════════════════\n');

  // 1. Fetch target unclassified batch (skips already classified jev_auto rows)
  const limitClause = isAll ? '' : `LIMIT ${targetLimit}`;
  const subjectCondition = targetSubject ? `AND LOWER(subject) = '${targetSubject}'` : '';
  const fetchSql = `
    SELECT id, subject, chapter, difficulty, question_text, option_a, option_b, option_c, option_d 
    FROM questions 
    WHERE (difficulty_source IS NULL OR difficulty_source = 'legacy_import')
    ${subjectCondition}
    ORDER BY created_at ASC
    ${limitClause};
  `;



  console.log('🔍 Fetching candidate questions from D1...');
  const questions: QuestionRecord[] = await queryD1(fetchSql);
  console.log(`✅ Loaded ${questions.length} questions for classification.`);
  if (isDryRun) {
    console.log('🛡️ [DRY RUN ACTIVE] No changes will be written to D1.\n');
  } else {
    console.log('');
  }

  if (questions.length === 0) {
    console.log('🎉 No unclassified questions found! All questions are up to date.');
    return;
  }

  const counts: Record<string, number> = { easy: 0, medium: 0, hard: 0, failed: 0 };
  const updateStatements: string[] = [];
  const now = Math.floor(Date.now() / 1000);

  const startTime = Date.now();

  for (let i = 0; i < questions.length; i += BATCH_SIZE) {
    const chunk = questions.slice(i, i + BATCH_SIZE);
    
    // Process concurrent burst
    const promises = chunk.map(async (q) => {
      try {
        const res = await classifyWithJev(q);
        counts[res.difficulty] = (counts[res.difficulty] || 0) + 1;

        const sub = (q.subject || 'general').toLowerCase();
        const rubricVer = `${sub}-kcet-v1.0`;

        return `UPDATE questions SET difficulty = ${escapeSql(res.difficulty)}, difficulty_confidence = ${res.confidence.toFixed(2)}, difficulty_source = 'jev_auto', difficulty_rubric_version = '${rubricVer}', difficulty_classified_at = ${now} WHERE id = ${escapeSql(q.id)};`;
      } catch (err: any) {
        counts.failed++;
        return null;
      }
    });

    const results = await Promise.all(promises);
    const validStatements = results.filter(Boolean) as string[];
    updateStatements.push(...validStatements);

    // Flush to D1 when statement batch reaches DB_BATCH_SIZE (unless in dry-run mode)
    if (updateStatements.length >= DB_BATCH_SIZE) {
      if (!isDryRun) {
        await executeD1Statements(updateStatements.splice(0, updateStatements.length));
      } else {
        updateStatements.splice(0, updateStatements.length);
      }
    }

    const processed = Math.min(i + BATCH_SIZE, questions.length);
    const pct = ((processed / questions.length) * 100).toFixed(0);
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(`\r[${pct}%] Processed ${processed}/${questions.length} | E:${counts.easy} M:${counts.medium} H:${counts.hard} Fail:${counts.failed} (${elapsedSec}s)${isDryRun ? ' [DRY-RUN]' : ''}`);
  }

  // Flush any remaining statements
  if (updateStatements.length > 0 && !isDryRun) {
    await executeD1Statements(updateStatements);
  }


  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalSuccess = counts.easy + counts.medium + counts.hard;

  console.log('\n\n══════════════════════════════════════════════════════════════════');
  console.log('📊 BATCH CLASSIFICATION SUMMARY');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`Total Attempted : ${questions.length}`);
  console.log(`Successfully Set: ${totalSuccess}`);
  console.log(`Failed / Skipped: ${counts.failed}`);
  console.log(`Time Elapsed    : ${totalTime}s (avg ${((Number(totalTime) / (totalSuccess || 1)) * 1000).toFixed(0)}ms/question)\n`);

  if (totalSuccess > 0) {
    console.log('Difficulty Distribution:');
    console.log(`🟢 Easy   : ${counts.easy.toString().padStart(5)} (${((counts.easy / totalSuccess) * 100).toFixed(1)}%)`);
    console.log(`🟡 Medium : ${counts.medium.toString().padStart(5)} (${((counts.medium / totalSuccess) * 100).toFixed(1)}%)`);
    console.log(`🔴 Hard   : ${counts.hard.toString().padStart(5)} (${((counts.hard / totalSuccess) * 100).toFixed(1)}%)`);
  }
  console.log('══════════════════════════════════════════════════════════════════');
}

main().catch(console.error);
