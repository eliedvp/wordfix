# Fréquences des mots français (wordfreq) — données tierces

Liste de fréquences utilisée par l'analyseur orthographique de WordFix pour classer les
corrections proposées (`src/engine/language/spelling/frequency.ts`) : entre deux mots du
dictionnaire aussi proches du mot écrit, le plus courant passe devant (« buget » → budget
plutôt que auget), et une correction vers un mot rare n'est jamais présentée comme certaine.

| Fichier                 | Contenu                                                                          | Licence          |
| ----------------------- | -------------------------------------------------------------------------------- | ---------------- |
| `fr-frequencies.tsv.gz` | 122 589 mots français, « mot<TAB>centibels » (fréquence = 10^(−centibels / 100)) | **CC BY-SA 4.0** |
| `decode.py`             | Extraction de la liste française depuis le paquet wordfreq                       | celle de WordFix |
| `LICENSE.md`            | Licence et attributions des données                                              | —                |

La liste est une **adaptation** des données de wordfreq : elle est distribuée sous la même
licence, CC BY-SA 4.0. Le code de WordFix qui la lit n'est pas concerné (la licence porte sur
les données, pas sur le logiciel qui les utilise).

## Provenance

- Projet : [wordfreq](https://github.com/rspeer/wordfreq) 3.1.1, par Robyn Speer (code Apache-2.0,
  données CC BY-SA 4.0).
- Fichier source : `wordfreq-3.1.1-py3-none-any.whl` sur [PyPI](https://pypi.org/project/wordfreq/3.1.1/),
  SHA-256 `4b1c6ecffc6198be3396d5cf871c4423ca71c907c231348d352dd54d62b97473`,
  liste `wordfreq/data/large_fr.msgpack.gz` (311 419 entrées).
- Sources de la liste française (wordfreq) : Wikipédia, sous-titres (OPUS OpenSubtitles 2018),
  actualités (NewsCrawl 2014, GlobalVoices), livres (Google Books Ngrams 2012), web (OSCAR),
  Twitter, Reddit.

## Construction

```bash
pip download --no-deps wordfreq==3.1.1          # vérifier le SHA-256 ci-dessus
pip install msgpack
python3 -I vendor/wordfreq-fr/decode.py wordfreq-3.1.1-py3-none-any.whl > fr-raw.tsv
pnpm --filter @wordfix/api exec tsx scripts/build-frequencies.ts fr-raw.tsv
```

`scripts/build-frequencies.ts` ne garde que les mots en minuscules reconnus par le dictionnaire
français de WordFix (`dictionary-fr`) : la liste brute contient aussi des noms propres et des
fautes fréquentes du web (« developpement »), qui ne doivent jamais servir de référence. La
fréquence ne sert qu'à classer des mots déjà reconnus par le dictionnaire.

| Fichier                 | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `fr-frequencies.tsv.gz` | `df7a554072bf0da210ae4d8032ec65a07c86dee6dd30149596ad3b3aecf9fb69` |

## Exécution

Chargée une seule fois par worker avec les dictionnaires (≈ 0,1 s, ≈ 10 Mo). Aucun appel réseau.
