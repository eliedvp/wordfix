import type { IssueNature } from '@wordfix/shared';
import { CircleAlert, Lightbulb, Search, TriangleAlert, type LucideIcon } from 'lucide-react';

/**
 * Repères visuels des quatre natures (dossier de conception, section 4).
 * La couleur n'est jamais le seul signal : icône et libellé l'accompagnent.
 */
export const NATURES: Record<
  IssueNature,
  {
    label: string;
    plural: string;
    icon: LucideIcon;
    text: string;
    soft: string;
    border: string;
    dot: string;
    help: string;
  }
> = {
  error: {
    label: 'Erreur',
    plural: 'Erreurs',
    icon: CircleAlert,
    text: 'text-nature-error',
    soft: 'bg-nature-error-soft',
    border: 'border-nature-error',
    dot: 'bg-nature-error',
    help: 'Faute certaine, avec une correction proposée.',
  },
  suggestion: {
    label: 'Suggestion',
    plural: 'Suggestions',
    icon: Lightbulb,
    text: 'text-nature-suggestion',
    soft: 'bg-nature-suggestion-soft',
    border: 'border-nature-suggestion',
    dot: 'bg-nature-suggestion',
    help: 'Amélioration possible : à vous de choisir.',
  },
  potential: {
    label: 'À examiner',
    plural: 'À examiner',
    icon: TriangleAlert,
    text: 'text-nature-potential',
    soft: 'bg-nature-potential-soft',
    border: 'border-nature-potential',
    dot: 'bg-nature-potential',
    help: 'Problème probable, à confirmer par une relecture.',
  },
  verify: {
    label: 'À vérifier',
    plural: 'À vérifier',
    icon: Search,
    text: 'text-nature-verify',
    soft: 'bg-nature-verify-soft',
    border: 'border-nature-verify',
    dot: 'bg-nature-verify',
    help: 'Hypothèse : seul l’auteur peut trancher.',
  },
};

export const NATURE_ORDER: IssueNature[] = ['error', 'suggestion', 'potential', 'verify'];
