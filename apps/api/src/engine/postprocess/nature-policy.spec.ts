import { describe, expect, it } from 'vitest';
import type { CandidateIssue } from '../types.js';
import { decideNature, ensureHedged } from './nature-policy.js';

const base: CandidateIssue = {
  category: 'grammar',
  subtype: 'agreement',
  blockId: 'b_000001',
  original: 'x',
  suggestion: 'y',
  explanation: 'e',
  severity: 'major',
  confidence: 'high',
  source: 'local',
  relatedBlockIds: [],
};

describe('decideNature', () => {
  it('une faute sûre avec correction est une erreur', () => {
    expect(decideNature(base)).toBe('error');
  });

  it('sans correction ou avec un doute, ce n’est pas une erreur certaine', () => {
    expect(decideNature({ ...base, suggestion: null })).toBe('suggestion');
    expect(decideNature({ ...base, confidence: 'medium' })).toBe('suggestion');
    expect(decideNature({ ...base, confidence: 'low' })).toBe('verify');
  });

  it('une partie qui semble manquer reste toujours « à vérifier »', () => {
    expect(
      decideNature({
        ...base,
        category: 'structure',
        subtype: 'possibly_missing_section',
        confidence: 'high',
      }),
    ).toBe('verify');
  });

  it('une contradiction dépend du verdict de la vérification', () => {
    const contradiction = { ...base, category: 'coherence' as const, subtype: 'contradiction' };
    expect(decideNature({ ...contradiction, verdict: 'contradictory' })).toBe('potential');
    expect(decideNature({ ...contradiction, verdict: 'uncertain' })).toBe('verify');
  });
});

describe('ensureHedged', () => {
  it('remplace une affirmation par une formulation prudente', () => {
    expect(ensureHedged('verify', 'possibly_missing_section', 'La conclusion manque.')).toMatch(
      /semble absente/,
    );
  });

  it('garde une explication déjà prudente', () => {
    const text =
      'Cette section semble incomplète. Vérifiez qu’aucune information importante n’a été oubliée.';
    expect(ensureHedged('verify', 'incomplete_paragraph', text)).toBe(text);
  });

  it('ne touche pas aux erreurs certaines', () => {
    expect(ensureHedged('error', 'agreement', 'Le mot est faux.')).toBe('Le mot est faux.');
  });
});
