import { z } from 'zod';

/**
 * Schémas des réponses attendues de l'IA, une par étape. Ils sont convertis en
 * JSON Schema strict pour le fournisseur, puis revérifiés à la réception (les
 * longueurs maximales notamment, que le mode strict ne garantit pas).
 *
 * Le modèle ne décide jamais de la nature (erreur / suggestion / à examiner /
 * à vérifier) ni de la position exacte : le backend les calcule.
 */

const severity = z.enum(['minor', 'major', 'critical']);
const confidence = z.enum(['high', 'medium', 'low']);
const blockId = z.string().max(20);
const explanation = z.string().min(1).max(400);

// --- Étape locale : phrase et paragraphe ------------------------------------

export const LOCAL_SUBTYPES = {
  spelling: ['misspelling', 'typo', 'accent', 'capitalization'],
  grammar: ['agreement', 'conjugation', 'syntax', 'gender_number', 'missing_word'],
  punctuation: ['punctuation', 'spacing'],
  style: ['awkward', 'too_long', 'unclear', 'wordy', 'informal_register', 'local_repetition'],
} as const;

export const localIssueSchema = z.strictObject({
  blockId,
  category: z.enum(['spelling', 'grammar', 'punctuation', 'style']),
  subtype: z.enum([
    ...LOCAL_SUBTYPES.spelling,
    ...LOCAL_SUBTYPES.grammar,
    ...LOCAL_SUBTYPES.punctuation,
    ...LOCAL_SUBTYPES.style,
  ]),
  original: z.string().min(1).max(300),
  suggestion: z.string().max(600).nullable(),
  explanation,
  severity,
  confidence,
});

export const localReviewSchema = z.strictObject({
  issues: z.array(localIssueSchema).max(40),
});
export type LocalReview = z.infer<typeof localReviewSchema>;

// --- Étape contextuelle : une section avec son contexte --------------------

export const CONTEXT_SUBTYPES = [
  'local_repetition',
  'tense_shift',
  'terminology_variant',
  'weak_transition',
  'incomplete_paragraph',
  'heading_wording',
] as const;

export const contextIssueSchema = z.strictObject({
  blockId,
  category: z.enum(['style', 'coherence', 'structure']),
  subtype: z.enum(CONTEXT_SUBTYPES),
  original: z.string().min(1).max(300),
  suggestion: z.string().max(600).nullable(),
  explanation,
  severity,
  confidence,
});

export const sectionDigestSchema = z.strictObject({
  summary: z.string().max(600),
  keyFacts: z
    .array(
      z.strictObject({
        subject: z.string().max(120),
        value: z.string().max(200),
        blockId,
      }),
    )
    .max(12),
  terms: z.array(z.string().max(80)).max(20),
  dominantTense: z.enum(['present', 'past', 'future', 'mixed']),
});
export type SectionDigest = z.infer<typeof sectionDigestSchema>;

export const contextReviewSchema = z.strictObject({
  issues: z.array(contextIssueSchema).max(15),
  digest: sectionDigestSchema,
});
export type ContextReview = z.infer<typeof contextReviewSchema>;

// --- Étape globale : cohérence de tout le document --------------------------

export const GLOBAL_SUBTYPES = [
  'contradiction',
  'naming_inconsistency',
  'tense_shift',
  'global_repetition',
  'possibly_missing_section',
  'unbalanced_section',
] as const;

export const globalIssueSchema = z.strictObject({
  category: z.enum(['coherence', 'structure']),
  subtype: z.enum(GLOBAL_SUBTYPES),
  /** Bloc principal concerné (un titre pour les remarques de structure). */
  blockId,
  relatedBlockIds: z.array(blockId).max(5),
  explanation,
  severity,
  confidence,
});

export const globalReviewSchema = z.strictObject({
  issues: z.array(globalIssueSchema).max(15),
});
export type GlobalReview = z.infer<typeof globalReviewSchema>;

// --- Vérification ciblée d'une contradiction --------------------------------

export const verificationSchema = z.strictObject({
  verdict: z.enum(['contradictory', 'compatible', 'uncertain']),
  excerptA: z.string().max(300),
  excerptB: z.string().max(300),
  explanation,
});
export type Verification = z.infer<typeof verificationSchema>;

// --- Cas ambigus du moteur de langue ----------------------------------------

export const ambiguityDecisionSchema = z.strictObject({
  caseId: z.string().max(10),
  decision: z.enum(['correct', 'keep', 'verify']),
  /** Option choisie, recopiée à l'identique ; null pour « keep » et « verify ». */
  correction: z.string().max(120).nullable(),
  justification: z.string().max(200),
  confidence,
});

export const ambiguityResolutionSchema = z.strictObject({
  decisions: z.array(ambiguityDecisionSchema).max(60),
});
export type AmbiguityResolution = z.infer<typeof ambiguityResolutionSchema>;
