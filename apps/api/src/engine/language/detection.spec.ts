import type { Block } from '@wordfix/shared';
import { describe, expect, it } from 'vitest';
import { LANGUAGE_ENGINE_CONFIG } from './config.js';
import { detectBlockLanguage, detectDocumentLanguage, type LanguageLexicon } from './detection.js';

/** Détection de la langue par phrase, sans dictionnaire (mots-outils, élisions, accents). */
const CONFIG = LANGUAGE_ENGINE_CONFIG.language;

/** Paragraphe découpé en phrases sur « . », « ? », « ! » (suffisant pour ces tests). */
function block(text: string): Pick<Block, 'text' | 'sentences'> {
  const sentences = [...text.matchAll(/[^.!?]+[.!?]?\s*/g)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
  }));
  return { text, sentences };
}

const languageOf = (
  text: string,
  documentLanguage: 'fr' | 'en' = 'fr',
  lexicon?: LanguageLexicon,
) => detectBlockLanguage(block(text), documentLanguage, CONFIG, lexicon ?? null);

describe('Détection de la langue (par phrase, locale et déterministe)', () => {
  it('paragraphe français → fr', () => {
    expect(
      languageOf('Le comité a examiné les résultats de l’enquête avec les partenaires.').block,
    ).toBe('fr');
  });

  it('paragraphe anglais → en (mots-outils, contractions)', () => {
    expect(
      languageOf(
        'The project focuses on the dissemination of research results across European universities.',
      ).block,
    ).toBe('en');
    expect(languageOf('It’s clear that we don’t know the answer yet.').block).toBe('en');
  });

  it('paragraphe qui alterne : chaque phrase a sa langue', () => {
    const text =
      'Les résultats sont présentés dans le tableau suivant. The results are presented in the following table. Ils confirment notre hypothèse.';
    const map = languageOf(text);
    expect(map.at(text.indexOf('Les résultats'))).toBe('fr');
    expect(map.at(text.indexOf('The results'))).toBe('en');
    expect(map.at(text.indexOf('Ils confirment'))).toBe('fr');
  });

  it('citation anglaise dans une phrase française : langue incertaine (aucune certitude)', () => {
    expect(
      languageOf(
        'Comme l’écrit Smith, « the integration of new technologies is a long and uneven process », ce qui nuance notre propos.',
      ).block,
    ).toBe('uncertain');
  });

  it('passage trop court (titre) : langue du document', () => {
    expect(languageOf('Méthodologie générale').block).toBe('fr');
    expect(languageOf('Research design', 'en').block).toBe('en');
    expect(languageOf('Research design', 'fr').block).toBe('fr');
  });

  it('phrase courte d’un paragraphe : langue du paragraphe', () => {
    const text =
      'The survey was conducted in 2023 and the response rate was high. See Table 2. It confirms the trend.';
    expect(languageOf(text).at(text.indexOf('See Table'))).toBe('en');
  });

  it('sans mots-outils (mots-clés) : les dictionnaires départagent, s’ils sont chargés', () => {
    const lexicon: LanguageLexicon = {
      isFrench: (w) =>
        ['gouvernance', 'politique', 'publique', 'évaluation', 'participation'].includes(w),
      isEnglish: (w) =>
        ['keywords', 'governance', 'public', 'policy', 'evaluation', 'participation'].includes(w),
    };
    const keywords = 'Keywords: governance, public policy, evaluation, participation';
    expect(languageOf(keywords, 'fr', lexicon).block).toBe('en');
    expect(languageOf(keywords, 'fr').block).toBe('fr'); // sans dictionnaires : langue du document
    expect(
      languageOf(
        'Mots-clés : gouvernance, politique publique, évaluation, participation',
        'fr',
        lexicon,
      ).block,
    ).toBe('fr');
  });

  it('langue du document : français par défaut, anglais seulement s’il domine nettement', () => {
    const fr = { text: 'Le rapport présente les résultats de l’étude et les perspectives.' };
    const en = { text: 'The report presents the results of the study and the next steps.' };
    expect(detectDocumentLanguage([fr, fr, en], CONFIG)).toBe('fr');
    expect(detectDocumentLanguage([en, en, en], CONFIG)).toBe('en');
    expect(detectDocumentLanguage([], CONFIG)).toBe('fr');
  });

  it('les noms propres et sigles ne font pas basculer une phrase française', () => {
    expect(
      languageOf(
        'Elle a soutenu sa thèse à l’Université de Versailles Saint-Quentin-en-Yvelines avec le CNRS.',
      ).block,
    ).toBe('fr');
    // Noms anglais en milieu de phrase et sigles : ni indices anglais ni mots-outils.
    expect(
      languageOf(
        'On retiendra plus particulierement The Cranberries et The Corrs parmi les invités.',
      ).block,
    ).toBe('fr');
    expect(
      languageOf(
        'La compagnie, officiellemnt Ethiopian Airlines (code AITA : ET), dessert la ville.',
      ).block,
    ).toBe('fr');
    // En début de phrase, le mot reste un indice : l'anglais est toujours reconnu.
    expect(languageOf('The results are presented in the following table.').block).toBe('en');
  });
});
