# Grammalecte (correcteur grammatical) — composant tiers

Ce dossier contient le moteur grammatical utilisé par le `GrammarAnalyzer` de WordFix
(`src/engine/language/analyzers/grammar.analyzer.ts`).

| Fichier                 | Contenu                                                                        | Licence                                     |
| ----------------------- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| `grammalecte-2.3.0.zip` | Paquet Python `grammalecte` 2.3.0, réduit au strict nécessaire (voir plus bas) | **GPL-3.0** (dictionnaire inclus : MPL-2.0) |
| `LICENSE.txt`           | Texte de la GNU General Public License v3, fourni avec Grammalecte             | —                                           |
| `bridge.py`             | Pont JSON entre le worker WordFix et Grammalecte                               | **GPL-3.0-or-later**                        |

Le reste de WordFix n'est **pas** concerné par la GPL : Grammalecte tourne dans un processus
Python séparé, qui ne communique avec le worker que par des messages JSON (voir
[`docs/language-engine.md`](../../../../docs/language-engine.md#licence-de-grammalecte-gpl-30)).

## Provenance

- Projet : Grammalecte, par Olivier R. et contributeurs — <https://grammalecte.net>
- Source : miroir Git <https://github.com/Pofilo/grammalecte>, commit
  `08511c222029b3be20bf547563315d10fb48d44b` (15 décembre 2025, `gc_lang/fr/config.ini` : version 2.3.0).
- Licence : GPL-3.0 (`LICENSE.txt` du dépôt d'origine, identique au fichier de ce dossier).
  Le lexique français (`fr-allvars.json`, généré à partir de `lexicons/French.lex`) est sous MPL-2.0.

## Construction de l'archive

```bash
git clone https://github.com/Pofilo/grammalecte && cd grammalecte
git checkout 08511c222029b3be20bf547563315d10fb48d44b
python3 make.py fr -d            # ≈ 6 min ; produit _build/Grammalecte-fr-v2.3.0.zip
```

Puis, depuis le contenu de `_build/Grammalecte-fr-v2.3.0.zip`, on garde uniquement le dossier
`grammalecte/` (sans `grammalecte-cli.py`, `grammalecte-server.py` ni l'extension LibreOffice),
avec un seul dictionnaire (`graphspell/_dictionaries/fr-allvars.json`) et sans les fichiers
inutiles à l'exécution :

- `bottle.py` (serveur web), `fr/tests_core.py`, `fr/tests_modules.py`, `fr/gc_test.txt`, `fr/perf.txt` ;
- `fr/thesaurus.py`, `fr/thesaurus_data.py` (thésaurus), `fr/textformatter.py` (formateur de texte).

Aucun fichier de Grammalecte n'est modifié. Archive produite avec des dates fixes, fichiers triés :

```bash
find grammalecte -exec touch -d '2025-12-15 17:58:20' {} +
find grammalecte -type f | LC_ALL=C sort | TZ=UTC zip -q -X -D grammalecte-2.3.0.zip -@
```

| Fichier                 | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `grammalecte-2.3.0.zip` | `fb78cd8301492aab8f350378c6782585cec91e69c244294c54560b3b97876b26` |
| `LICENSE.txt`           | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` |

## Exécution

`python3 -I bridge.py grammalecte-2.3.0.zip conf,loc,gn,…` : Python 3.9 ou plus récent, sans
dépendance. Le paquet est lu directement dans l'archive (pas d'extraction sur disque), en mode
isolé (`-I` : ni variables `PYTHON*`, ni dossier courant dans le chemin d'import). Aucun accès
réseau. Le processus reçoit un environnement minimal : aucun secret du worker ne lui est transmis.

## Mise à jour

Reconstruire l'archive comme ci-dessus à partir du nouveau commit, mettre à jour le nom du
fichier (`VENDOR_FILES` dans `grammalecte-client.ts`), ce README (commit, version, SHA-256) et
relancer `pnpm --filter @wordfix/api test` : les tests vérifient les fautes détectées et
l'absence de faux positifs.
