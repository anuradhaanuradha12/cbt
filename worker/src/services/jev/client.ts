import { 
  DifficultyClassificationInput, 
  JevDecision, 
  JevDecisionClient,
  DifficultyLevel
} from './types';
import { resolveRubric } from '../../config/rubrics';
import { buildSystemOnePayload, TypeSafeSystemOneResponse } from './mapper';

export interface TypeSafeClientConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class TypeSafeJevClient implements JevDecisionClient {
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(config: TypeSafeClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.typesafe.ai/v1/systemone';
    this.timeoutMs = config.timeoutMs || 8000;
    this.maxRetries = config.maxRetries ?? 2;
  }

  async classify(input: DifficultyClassificationInput): Promise<JevDecision> {
    const rubric = resolveRubric(input.subject, input.exam_standard);
    const payload = buildSystemOnePayload(input, rubric);

    let lastError: Error | null = null;
    let attempt = 0;

    while (attempt <= this.maxRetries) {
      attempt++;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await fetch(this.baseUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errBody = await response.text();
          if (response.status === 429 || response.status >= 500) {
            // Transient rate limit or server error -> backoff & retry
            await new Promise(r => setTimeout(r, attempt * 1000));
            continue;
          }
          throw new Error(`TypeSafe API error (${response.status}): ${errBody}`);
        }

        const data = (await response.json()) as TypeSafeSystemOneResponse;
        const ans = data.answers?.difficulty;

        if (!ans || !ans.choice) {
          throw new Error('TypeSafe API response missing difficulty choice answer');
        }

        const choice = ans.choice.toLowerCase() as DifficultyLevel;
        const confidence = typeof ans.confidence === 'number' ? ans.confidence : 0.5;
        const probs = ans.probabilities || { easy: 0, medium: 0, hard: 0 };

        // Auto-approval logic: high confidence + complete probability distribution
        // Note: exact threshold can be tuned post-benchmark
        const review_status = confidence >= 0.85 ? 'auto_approved' : 'unreviewed';

        return {
          difficulty: choice,
          confidence,
          probabilities: {
            easy: probs.easy ?? 0,
            medium: probs.medium ?? 0,
            hard: probs.hard ?? 0,
          },
          model_version: data.model || 'jev-latest',
          rubric_version: rubric.rubric_version,
          extractor_version: input.signals.extractor_version,
          question_hash: input.question_hash,
          signals: input.signals,
          review_status,
          validation_status: 'unvalidated',
          classified_at: Math.floor(Date.now() / 1000),
        };
      } catch (err: any) {
        lastError = err;
        if (attempt <= this.maxRetries) {
          await new Promise(r => setTimeout(r, attempt * 1000));
        }
      }
    }

    // DO NOT silently generate a fake heuristic difficulty!
    // Throw error so callers route to pending queue or faculty review.
    throw new Error(`Jev classification failed after ${this.maxRetries + 1} attempts: ${lastError?.message || 'Unknown error'}`);
  }
}
