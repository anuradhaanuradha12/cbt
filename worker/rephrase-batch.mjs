import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config({ path: '.dev.vars' });

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.error("Please set a valid GROQ_API_KEY in .dev.vars");
  process.exit(1);
}

const GROQ_URL = `https://api.groq.com/openai/v1/chat/completions`;

const DB_PATH = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/82ed3d9ff502f7382874778df6ecb14db42da56def327314e2a27be609632375.sqlite';
const db = new Database(DB_PATH);

// Helper to call Groq
async function callGroq(prompt) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-20b',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      top_p: 0.95,
      max_tokens: 1024,
      response_format: { type: "json_object" }
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response from Groq');
  return text;
}

// Sleep for rate limiting
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const limit = parseInt(process.argv[2] || '5');
  console.log(`Starting batch rephrase for ${limit} questions...`);

  const query = `
    SELECT * FROM questions 
    WHERE (image_r2_key IS NOT NULL OR explanation_image_r2_key IS NOT NULL)
    AND NOT (
      question_text LIKE '%201%' OR question_text LIKE '%202%' OR question_text LIKE '%200%' OR question_text LIKE '%199%'
      OR explanation LIKE '%201%' OR explanation LIKE '%202%' OR explanation LIKE '%200%' OR explanation LIKE '%199%'
      OR question_text LIKE '%JEE%' OR explanation LIKE '%JEE%'
      OR question_text LIKE '%NEET%' OR explanation LIKE '%NEET%'
      OR question_text LIKE '%AIPMT%' OR explanation LIKE '%AIPMT%'
      OR question_text LIKE '%KCET%' OR explanation LIKE '%KCET%'
    )
    LIMIT ?
  `;

  const questions = db.prepare(query).all(limit);
  console.log(`Found ${questions.length} questions to rephrase.`);

  const updateStmt = db.prepare(`
    UPDATE questions 
    SET question_text = ?, option_a = ?, option_b = ?, option_c = ?, option_d = ?, explanation = ?, image_r2_key = NULL, explanation_image_r2_key = NULL
    WHERE id = ?
  `);

  let successCount = 0;

  for (const q of questions) {
    console.log(`\nProcessing Question ID: ${q.id} (Subject: ${q.subject})`);
    
    const prompt = `You are an expert question setter. We need to rephrase the following multiple choice question to avoid copyright issues. 
The original question might have relied on an image, but we are removing the image. Please rephrase the text so it makes sense without the image if possible, or just rephrase the textual parts to be entirely original while keeping the exact same mathematical/scientific meaning.

Original Question:
Question Text: ${q.question_text}
Option A: ${q.option_a || ''}
Option B: ${q.option_b || ''}
Option C: ${q.option_c || ''}
Option D: ${q.option_d || ''}
Correct Answer: ${q.correct_answer}
Explanation: ${q.explanation || ''}

Return ONLY a JSON object with the exact following keys and the rephrased content. Do not include markdown formatting or comments.
{
  "question_text": "...",
  "option_a": "...",
  "option_b": "...",
  "option_c": "...",
  "option_d": "...",
  "explanation": "..."
}`;

    let maxRetries = 3;
    let success = false;
    while (!success && maxRetries > 0) {
      try {
        const rawResponse = await callGroq(prompt);
        const rephrased = JSON.parse(rawResponse);

        updateStmt.run(
          rephrased.question_text,
          rephrased.option_a,
          rephrased.option_b,
          rephrased.option_c,
          rephrased.option_d,
          rephrased.explanation,
          q.id
        );

        console.log(`✅ Successfully rephrased ${q.id}`);
        successCount++;
        success = true;
      } catch (e) {
        if (e.message.includes('429')) {
          console.error(`⚠️ Rate limited on ${q.id}. Detailed error: ${e.message}`);
          console.error(`Waiting 60s before retry... (${maxRetries} retries left)`);
          await sleep(60000);
          maxRetries--;
        } else if (e.message.includes('503')) {
          console.error(`⚠️ 503 Unavailable on ${q.id}. Waiting 10s before retry... (${maxRetries} retries left)`);
          await sleep(10000);
          maxRetries--;
        } else {
          console.error(`❌ Failed to rephrase ${q.id}:`, e.message);
          break;
        }
      }
    }

    // Rate limit pause (Groq free tier is ~30 RPM - wait 2s)
    await sleep(2000); 
  }

  console.log(`\nCompleted! Successfully rephrased ${successCount}/${questions.length} questions.`);
}

main().catch(console.error);
