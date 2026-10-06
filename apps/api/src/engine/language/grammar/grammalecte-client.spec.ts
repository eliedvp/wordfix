import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GRAMMALECTE_OPTIONS,
  GrammalecteClient,
  getGrammalecte,
} from './grammalecte-client.js';

describe('GrammalecteClient (processus Python)', () => {
  const clients: GrammalecteClient[] = [];
  const create = (options = {}) => {
    const client = new GrammalecteClient({ ...DEFAULT_GRAMMALECTE_OPTIONS, ...options });
    clients.push(client);
    return client;
  };
  afterEach(() => {
    for (const client of clients.splice(0)) client.stop();
  });

  it('se lance une seule fois, même avec des appels simultanés', async () => {
    const client = create();
    await Promise.all([client.start(), client.start(), client.check(['Les serveur.'])]);
    await client.check(['Un autre document.']);
    expect(client.getStats()).toMatchObject({ starts: 1, failures: 0, version: '2.3.0' });
  }, 60_000);

  it('traite les lots dans l’ordre, avec une réponse par paragraphe', async () => {
    const client = create();
    const [a, b] = await Promise.all([
      client.check(['Les serveur sont prêts.', 'Texte correct.']),
      client.check(['Nous avons installer le logiciel.']),
    ]);
    expect(a.map((errors) => errors?.length)).toEqual([1, 0]);
    expect(b[0]?.[0]).toMatchObject({ type: 'ppas', suggestions: ['installé'] });
    expect(await client.check([])).toEqual([]);
  }, 60_000);

  it('n’active que les options de grammaire demandées', async () => {
    const client = create();
    const [errors] = await client.check(["L'équipe s'est réunie : c'est l'heure."]);
    expect(errors).toEqual([]);
  }, 60_000);

  it('relance le processus après un délai dépassé', async () => {
    const client = create({ requestTimeoutMs: 1 });
    await client.start();
    await expect(client.check(['Les serveur sont prêts.'.repeat(2000)])).rejects.toThrow(/délai/);
    expect(client.running).toBe(false);
    // La requête suivante relance un processus (le délai reste trop court pour répondre).
    await expect(client.check(['Texte.'])).rejects.toThrow(/délai/);
    expect(client.getStats().starts).toBe(2);
  }, 60_000);

  it('échoue proprement si Python est introuvable', async () => {
    const client = create({ python: 'python-introuvable-wordfix' });
    await expect(client.start()).rejects.toThrow(/lancement impossible/);
    await expect(client.check(['Texte.'])).rejects.toThrow();
  }, 60_000);

  it('refuse toute requête une fois arrêté', async () => {
    const client = create();
    client.stop();
    await expect(client.check(['Texte.'])).rejects.toThrow(/arrêté/);
  });

  it('une seule instance partagée par processus', () => {
    expect(getGrammalecte()).toBe(getGrammalecte());
  });
});
