import { QuestionSignalData } from '../../utils/question-signals';

export type DifficultyLevel = 'easy' | 'medium' | 'hard';
export type DifficultySource = 'legacy_import' | 'jev_auto' | 'faculty_override';
export type DifficultyReviewStatus = 'unreviewed' | 'auto_approved' | 'faculty_reviewed' | 'flagged_conflict';
export type DifficultyValidationStatus = 'unvalidated' | 'benchmark_validated' | 'faculty_validated' | 'empirically_validated';

export interface DifficultyClassificationInput {
  subject: string;
  exam_standard?: string | null;
  question_text: string;
  option_a?: string | null;
  option_b?: string | null;
  option_c?: string | null;
  option_d?: string | null;
  image_r2_key?: string | null;
  signals: QuestionSignalData;
  question_hash: string;
}

export interface JevDecision {
  difficulty: DifficultyLevel;
  confidence: number;
  probabilities: Record<DifficultyLevel, number>;
  model_version: string;
  rubric_version: string;
  extractor_version: string;
  question_hash: string;
  signals: QuestionSignalData;
  review_status: DifficultyReviewStatus;
  validation_status: DifficultyValidationStatus;
  classified_at: number;
}

export interface EmpiricalRules {
  minimumAttempts: number;
  accuracyConflictThreshold: number; // e.g. 0.35 -> if Easy question has accuracy < 35%, flag conflict
  minimumConfidenceForConflict: number; // e.g. 0.80 -> only flag if model was confident
}

export const DEFAULT_EMPIRICAL_RULES: EmpiricalRules = {
  minimumAttempts: 50,
  accuracyConflictThreshold: 0.35,
  minimumConfidenceForConflict: 0.80,
};

export interface JevDecisionClient {
  classify(input: DifficultyClassificationInput): Promise<JevDecision>;
}
