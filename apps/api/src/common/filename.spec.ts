import { describe, expect, it } from 'vitest';
import { sanitizeFilename } from './filename.js';

describe('sanitizeFilename', () => {
  it('garde un nom normal, accents compris', () => {
    expect(sanitizeFilename('Rapport de stage – Élodie.docx')).toBe(
      'Rapport de stage – Élodie.docx',
    );
  });

  it('retire les dossiers et tentatives de remontée', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\moi\\rapport.docx')).toBe('rapport.docx');
  });

  it('retire les caractères de contrôle et invisibles', () => {
    expect(sanitizeFilename('rap\u0000port\u202e.docx')).toBe('rapport.docx');
  });

  it('tronque les noms trop longs en gardant l’extension', () => {
    const name = sanitizeFilename(`${'a'.repeat(300)}.docx`);
    expect(name).toHaveLength(200);
    expect(name.endsWith('.docx')).toBe(true);
  });

  it('fournit un nom par défaut', () => {
    expect(sanitizeFilename('')).toBe('document.docx');
    expect(sanitizeFilename('..')).toBe('document.docx');
  });
});
