import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NatureBadge } from '@/components/results/nature-badge';

describe('NatureBadge', () => {
  it.each([
    ['error', 'Erreur'],
    ['suggestion', 'Suggestion'],
    ['potential', 'À examiner'],
    ['verify', 'À vérifier'],
  ] as const)('affiche un libellé, pas seulement une couleur (%s)', (nature, label) => {
    render(<NatureBadge nature={nature} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
