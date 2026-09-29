export interface SubjectRubric {
  rubric_version: string;
  subject: string;
  exam_standard: string;
  instructions: string;
  criteria: {
    easy: string;
    medium: string;
    hard: string;
  };
}

export const RUBRICS: Record<string, SubjectRubric> = {
  'physics-kcet-v1': {
    rubric_version: 'physics-kcet-v1.0',
    subject: 'physics',
    exam_standard: 'KCET',
    instructions: 'Classify the Physics question difficulty against standard KCET (State CET) 1-minute solve expectations.',
    criteria: {
      easy: 'Single-step direct formula recall or substitution (e.g. v=u+at, Ohm law, F=ma). Minimal algebra, no complex unit manipulation.',
      medium: 'Two-step derivation, standard circuit/kinematics calculation, single formula with unit conversion or standard graph reading.',
      hard: 'Multi-concept combination (e.g. thermodynamics + work done, rotational + linear), non-trivial geometry/algebra, or multi-step reasoning.'
    }
  },
  'physics-jee-v1': {
    rubric_version: 'physics-jee-v1.0',
    subject: 'physics',
    exam_standard: 'JEE_MAIN',
    instructions: 'Classify the Physics question difficulty against national JEE Main / Advanced standards.',
    criteria: {
      easy: 'Standard NCERT direct application, direct definition, standard dimensional analysis or direct formula.',
      medium: 'Standard JEE Main level: 2-3 step calculation, coordinate manipulation, standard calculus integration or multi-component vectors.',
      hard: 'JEE Advanced / High-tier Main: Multi-body constraints, non-standard calculus/integration, combined electromagnetism + mechanics, tricky edge conditions.'
    }
  },
  'chemistry-kcet-v1': {
    rubric_version: 'chemistry-kcet-v1.0',
    subject: 'chemistry',
    exam_standard: 'KCET',
    instructions: 'Classify the Chemistry question difficulty against standard State CET / Board curriculum.',
    criteria: {
      easy: 'Direct factual recall (periodic trends, named reactions, standard IUPAC names, electronic configurations).',
      medium: 'Direct stoichiometry/equilibrium calculation, predicting reaction products from standard reagents, acidity/basicity comparison.',
      hard: 'Multi-step organic synthesis sequences, complex electrochemistry / ionic equilibrium calculations, multi-statement exceptions.'
    }
  },
  'mathematics-kcet-v1': {
    rubric_version: 'mathematics-kcet-v1.0',
    subject: 'mathematics',
    exam_standard: 'KCET',
    instructions: 'Classify the Mathematics question difficulty against KCET 60-second speed-solving criteria.',
    criteria: {
      easy: 'Direct standard formula substitution, basic matrix determinant, standard derivative/integral of single elementary function.',
      medium: 'Standard 2-3 step calculation (conic properties, limits requiring L’Hôpital, vector dot/cross products, standard probability).',
      hard: 'Tricky substitution, multi-stage calculus, non-trivial geometric reasoning, or problem involving multiple interlocking theorems.'
    }
  },
  'biology-kcet-v1': {
    rubric_version: 'biology-kcet-v1.0',
    subject: 'biology',
    exam_standard: 'KCET',
    instructions: 'Classify the Biology question difficulty against standard NCERT curriculum.',
    criteria: {
      easy: 'Direct NCERT definition, terminology recall, identifying organ/organelle functions, straightforward matching.',
      medium: 'Process sequencing, genetics Punnett square calculation, identifying physiological cascade mechanisms, statement verification.',
      hard: 'Complex multi-statement assertion-reasoning with nuanced exceptions, multi-gene linkage calculations, high-order pedigree analysis.'
    }
  },
  'general-default-v1': {
    rubric_version: 'general-default-v1.0',
    subject: 'general',
    exam_standard: 'general',
    instructions: 'Classify the academic question difficulty into Easy, Medium, or Hard based on cognitive depth and steps required.',
    criteria: {
      easy: 'Direct recall or 1-step direct application without ambiguity.',
      medium: '2-step problem solving, moderate reasoning, standard domain calculations.',
      hard: 'Multi-stage synthesis, advanced reasoning, complex constraints, or edge-case handling.'
    }
  }
};

/**
 * Resolves the optimal versioned rubric for a given subject and exam standard.
 */
export function resolveRubric(subject: string, exam_standard?: string | null): SubjectRubric {
  const normSub = (subject || '').toLowerCase().trim();
  const normExam = (exam_standard || '').toLowerCase().trim();

  const key = `${normSub}-${normExam}-v1`;
  if (RUBRICS[key]) return RUBRICS[key];

  // Fallback to subject-kcet or general
  const subDefault = `${normSub}-kcet-v1`;
  if (RUBRICS[subDefault]) return RUBRICS[subDefault];

  return RUBRICS['general-default-v1'];
}
