export interface QuestionSignalData {
  char_count: number;
  word_count: number;
  has_latex: boolean;
  latex_formula_count: number;
  equation_count: number;
  has_diagram: boolean;
  has_case_analysis: boolean;
  step_count_estimate: number;
  concept_count_estimate: number;
  option_length_mean: number;
  option_length_variance: number;
  extractor_version: string;
}

export const EXTRACTOR_VERSION = 'signals-v1.0';

/**
 * Computes a deterministic SHA-256 hash over normalized question fields using Web Crypto API.
 * Compatible with Cloudflare Workers, browser, and Node.js runtimes.
 */
export async function computeQuestionHash(params: {
  subject: string;
  question_text: string;
  option_a?: string | null;
  option_b?: string | null;
  option_c?: string | null;
  option_d?: string | null;
  exam_standard?: string | null;
}): Promise<string> {
  const norm = (s?: string | null) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const payload = [
    norm(params.subject),
    norm(params.exam_standard || 'general'),
    norm(params.question_text),
    norm(params.option_a),
    norm(params.option_b),
    norm(params.option_c),
    norm(params.option_d),
  ].join('|||');

  const encoder = new TextEncoder();
  const data = encoder.encode(payload);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}


/**
 * Deterministically extracts syntactic, structural, and domain signals from question text & options.
 * Does NOT decide difficulty. Provides observable evidence for the decision model and human review.
 */
export function extractQuestionSignals(params: {
  subject: string;
  question_text: string;
  option_a?: string | null;
  option_b?: string | null;
  option_c?: string | null;
  option_d?: string | null;
  image_r2_key?: string | null;
}): QuestionSignalData {
  const text = params.question_text || '';
  const options = [params.option_a, params.option_b, params.option_c, params.option_d].filter(Boolean) as string[];

  // 1. Text Metrics
  const char_count = text.length;
  const words = text.trim().split(/\s+/).filter(w => w.length > 0);
  const word_count = words.length;

  // 2. LaTeX & Equation Detection
  // Matches $...$ (inline) or $$...$$ (block)
  const latexMatches = text.match(/\$\$[\s\S]*?\$\$|\$[^\$]+?\$/g) || [];
  const latex_formula_count = latexMatches.length;
  const has_latex = latex_formula_count > 0;

  // Equation symbols & operators (=, \approx, \equiv, \int, \sum, \sqrt, \frac, \partial, \lim)
  const eqTokens = text.match(/(=|\\approx|\\equiv|\\int|\\sum|\\sqrt|\\frac|\\partial|\\lim|\\times|\\div)/g) || [];
  const equation_count = eqTokens.length;

  // 3. Diagram / Figure Detection
  const has_explicit_image = Boolean(params.image_r2_key);
  const diagramKeywords = /(figure|diagram|circuit|graph|shown in the given|illustrated below|schematic)/i;
  const has_diagram = has_explicit_image || diagramKeywords.test(text);

  // 4. Case Analysis / Multi-part Statements
  // Matches (i), (ii), (iii) or statement 1, statement 2 or Assertion / Reason
  const caseKeywords = /(statement\s*(?:1|2|i|ii|a|b)|assertion[\s\S]*reason|column\s*(?:i|ii)|match the following|\([i|v|x]+\))/i;
  const has_case_analysis = caseKeywords.test(text);

  // 5. Reasoning / Calculation Step Count Estimate
  // Counts reasoning transitions, sub-clauses, and calculation triggers
  const stepMarkers = /(given that|assuming|then|find the|calculate|determine|such that|if\s+[\s\S]+?then|ratio of|percentage of)/gi;
  const stepMatches = text.match(stepMarkers) || [];
  // Base step is 1 + detected structural transitions (capped at 5)
  const step_count_estimate = Math.min(5, Math.max(1, stepMatches.length + (has_case_analysis ? 1 : 0)));

  // 6. Concept Count Estimate (Domain Keyword density)
  const conceptKeywords: Record<string, RegExp> = {
    physics: /(thermodynamics|rotational|torque|entropy|magnetic field|dielectric|doppler|interference|photoelectric|kinematics|gravitation|capacitance|shm|superposition)/gi,
    chemistry: /(equilibrium|hybridization|electronegativity|isomerism|aromaticity|redox|enthalpy|activation energy|coordination|sn1|sn2|buffer|colligative)/gi,
    mathematics: /(eigenvalue|integration|differential equation|matrix|determinant|probability|permutation|conic section|hyperbola|ellipse|limit|continuity|asymptote|binomial)/gi,
    biology: /(transcription|translation|glycolysis|photosynthesis|mitosis|meiosis|mendelian|endoplasmic|nephron|action potential|hormone|phylogeny|ecosystem)/gi,
  };

  const subjectKey = params.subject.toLowerCase();
  let concept_count_estimate = 1;
  if (conceptKeywords[subjectKey]) {
    const conceptMatches = text.match(conceptKeywords[subjectKey]) || [];
    const uniqueConcepts = new Set(conceptMatches.map(m => m.toLowerCase()));
    concept_count_estimate = Math.max(1, uniqueConcepts.size);
  }

  // 7. Option Metrics
  const optLengths = options.map(o => o.length);
  const option_length_mean = optLengths.length > 0 
    ? Math.round(optLengths.reduce((a, b) => a + b, 0) / optLengths.length) 
    : 0;
  const option_length_variance = optLengths.length > 0
    ? Math.round(optLengths.reduce((acc, len) => acc + Math.pow(len - option_length_mean, 2), 0) / optLengths.length)
    : 0;

  return {
    char_count,
    word_count,
    has_latex,
    latex_formula_count,
    equation_count,
    has_diagram,
    has_case_analysis,
    step_count_estimate,
    concept_count_estimate,
    option_length_mean,
    option_length_variance,
    extractor_version: EXTRACTOR_VERSION,
  };
}
