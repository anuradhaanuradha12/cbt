import { DifficultyClassificationInput } from './types';
import { SubjectRubric } from '../../config/rubrics';

export interface TypeSafeSystemOneRequest {
  state: {
    subject: string;
    exam_standard: string;
    question_text: string;
    options: {
      A?: string | null;
      B?: string | null;
      C?: string | null;
      D?: string | null;
    };
    deterministic_signals: {
      has_latex: boolean;
      latex_formula_count: number;
      equation_count: number;
      has_diagram: boolean;
      has_case_analysis: boolean;
      step_count_estimate: number;
      concept_count_estimate: number;
      char_count: number;
      word_count: number;
    };
  };
  model: string;
  questions: {
    difficulty: {
      type: 'choice';
      instructions: string;
      criteria: {
        easy: string;
        medium: string;
        hard: string;
      };
    };
  };
}

export interface TypeSafeSystemOneResponse {
  model: string;
  answers: {
    difficulty: {
      type: 'choice';
      choice: 'easy' | 'medium' | 'hard';
      confidence: number;
      probabilities: {
        easy: number;
        medium: number;
        hard: number;
      };
    };
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export function buildSystemOnePayload(
  input: DifficultyClassificationInput,
  rubric: SubjectRubric
): TypeSafeSystemOneRequest {
  return {
    state: {
      subject: input.subject,
      exam_standard: input.exam_standard || 'general',
      question_text: input.question_text,
      options: {
        A: input.option_a,
        B: input.option_b,
        C: input.option_c,
        D: input.option_d,
      },
      deterministic_signals: {
        has_latex: input.signals.has_latex,
        latex_formula_count: input.signals.latex_formula_count,
        equation_count: input.signals.equation_count,
        has_diagram: input.signals.has_diagram,
        has_case_analysis: input.signals.has_case_analysis,
        step_count_estimate: input.signals.step_count_estimate,
        concept_count_estimate: input.signals.concept_count_estimate,
        char_count: input.signals.char_count,
        word_count: input.signals.word_count,
      },
    },
    model: 'jev-latest',
    questions: {
      difficulty: {
        type: 'choice',
        instructions: rubric.instructions,
        criteria: rubric.criteria,
      },
    },
  };
}
