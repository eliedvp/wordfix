# WordFix Language Engine

Le Language Engine est la partie **déterministe** de l'analyse linguistique de WordFix. Il relit le document extrait, paragraphe par paragraphe, et signale les problèmes qu'un programme détecte avec certitude, sans appel réseau ni IA. Il est la fondation du futur correcteur français : de nouveaux analyseurs s'y ajouteront progressivement.

Code : `apps/api/src/engine/language/`.

## Place dans le pipeline

```
.docx → extraction (docx/parser) → DocumentModel
                                      │
        planification de l'analyse ───┤
                                      ├─► runRules() ─► Language Engine (langue)
                                      │              └► règles du document (numérotation, sommaire, sigles, graphies)
                                      │
                                      └─► étapes IA : locale → contextuelle → globale → vérification
                                                      │
               problèmes candidats (CandidateIssue) ◄─┘
                     │
                     ▼
     materialize : ancrage, nature décidée par le backend, formulation prudente, localisation
                     ▼
     Prisma (Issue) → finalisation : doublons entre étapes, plafond, score → API → Review Workbench
```

- Le moteur tourne pendant la planification : ses résultats sont enregistrés immédiatement, avant les appels IA.
- Ses problèmes ont la source `rules` (déterministe) ; `local`, `context`, `global` et `verify` désignent l'IA.
- Quand une règle et l'IA signalent le même endroit (même paragraphe, positions qui se chevauchent, même famille de problème), la finalisation n'en garde qu'un, le plus sûr ; à égalité, celui de la règle.
- Le moteur ne dépend d'aucun fournisseur d'IA : il fonctionne de la même façon avec OpenAI ou avec `AI_PROVIDER=fake`.

## Déterministe ou IA

|                   | Language Engine (déterministe)                                                             | Analyse IA                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Problèmes visés   | Ce qu'une règle détecte avec certitude : mot doublé, espace mal placée, phrase très longue | Ce qui demande du contexte ou du sens : accords, formulations, cohérence, contradictions |
| Coût, réseau      | Gratuit, local, instantané                                                                 | Appels OpenAI payants                                                                    |
| Reproductibilité  | Même document, mêmes résultats                                                             | Variable selon le modèle                                                                 |
| Règle de prudence | Un cas douteux n'est pas signalé                                                           | La nature est bornée par le backend                                                      |

Dans les deux cas, **la nature** (Erreur, Suggestion, À examiner, À vérifier) est décidée par le backend (`postprocess/nature-policy.ts`) à partir de la catégorie, de la confiance et de la présence d'une correction, jamais par l'analyseur lui-même.

## Analyseurs disponibles

| Analyseur            | Règle                       | Exemple                            | Catégorie / sous-type     | Confiance → nature                                     |
| -------------------- | --------------------------- | ---------------------------------- | ------------------------- | ------------------------------------------------------ |
| `RepetitionAnalyzer` | `repeated_word`             | « permet permet » → « permet »     | spelling / typo           | élevée + correction → Erreur                           |
| `SpellingAnalyzer`   | `misspelling`               | « Informatiue » → « Informatique » | spelling / misspelling    | élevée → Erreur ; moyenne → Suggestion ; faible → rien |
| `TypographyAnalyzer` | `double_space`              | deux espaces entre deux mots       | punctuation / spacing     | élevée, sans correction → Suggestion                   |
|                      | `space_before_punctuation`  | « serveur , » → « serveur, »       | punctuation / spacing     | élevée + correction → Erreur                           |
|                      | `doubled_punctuation`       | « ,, » → « , »                     | punctuation / punctuation | élevée + correction → Erreur                           |
|                      | `missing_space_after_comma` | « rouge,vert » → « rouge, vert »   | punctuation / spacing     | élevée + correction → Erreur                           |
| `SentenceAnalyzer`   | `long_sentence`             | phrase de plus de 45 mots          | style / too_long          | moyenne → Suggestion                                   |

### Garde-fous contre les faux positifs

- Titres, entrées de sommaire, en-têtes et pieds de page ne sont pas analysés.
- URL, adresses e-mail, chemins, noms de fichiers et identifiants techniques (`Node.js`, `config.json`, `src/app`) sont protégés.
- Répétitions : seulement deux mots identiques séparés par des espaces. Exceptions « nous nous » et « vous vous ». Ni répétition à travers une ponctuation (« oui, oui »), ni mots de même famille (« il permet de permettre »).
- Typographie : nombres (« 3,5 »), variables d'une lettre (« x,y ») et code (« f(a,b) ») exclus. Un signalement n'est émis que si le texte est continu dans le fichier Word : une image, un appel de note ou un champ invisible entre deux caractères suffit à l'annuler. L'espace avant la ponctuation n'est pas contrôlée dans un document contenant des équations (absentes du texte extrait).
- Phrases longues : énumérations (points-virgules) et phrases surtout numériques ignorées.
- Un même endroit n'est signalé qu'une fois ; chaque règle est plafonnée par document.

Non traité volontairement à ce stade : accords et conjugaison, mots composés mal orthographiés, espaces avant « ; : ! ? » (conventions différentes selon les pays), guillemets et apostrophes.

## Orthographe : SpellingAnalyzer

Le `SpellingAnalyzer` signale les mots absents du dictionnaire français et propose une correction **seulement quand elle se détache nettement**. Aucune faute n'est inscrite dans le code : tout vient du dictionnaire général.

### Dictionnaires

| Paquet                                                                              | Version | Rôle                                                                                                              | Licence                                                         |
| ----------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [`nspell`](https://github.com/wooorm/nspell)                                        | 2.1.5   | Moteur Hunspell en JavaScript (vérification, suggestions)                                                         | MIT (dépendance `is-buffer` : MIT)                              |
| [`dictionary-fr`](https://github.com/wooorm/dictionaries/tree/main/dictionaries/fr) | 3.0.0   | Dictionnaire français « classique » v7.5 de [Grammalecte](https://grammalecte.net/) (Olivier R. et contributeurs) | Fichiers du dictionnaire : **MPL-2.0** ; code d'emballage : MIT |
| [`dictionary-en`](https://github.com/wooorm/dictionaries/tree/main/dictionaries/en) | 4.0.0   | Formes de base anglaises (SCOWL), pour reconnaître les anglicismes                                                | MIT AND BSD ; code d'emballage : MIT                            |
| `@types/nspell` (développement)                                                     | 2.1.6   | Types TypeScript                                                                                                  | MIT                                                             |

Les fichiers de dictionnaire sont installés par npm avec l'application : **aucun fichier de dictionnaire n'est copié dans le dépôt** et aucun n'est modifié. La MPL-2.0 est un copyleft limité aux fichiers : les utiliser tels quels dans le service est libre ; une version modifiée de ces fichiers devrait être publiée sous la même licence si elle était distribuée. Aucun appel réseau : rien n'est téléchargé à l'exécution.

### Traitement d'un mot

1. Ignoré s'il est dans une zone protégée (URL, e-mail, chemin, code), s'il contient un chiffre, s'il fait moins de 4 ou plus de 30 lettres, s'il est en majuscules (sigle : API, VPN, SATI), s'il a une majuscule interne (GitHub, MongoDB, RESTful) ou un trait d'union.
2. Connu ? Dictionnaire français (avec les élisions : « qu’il », « l’informatique »), liste technique de départ (`spelling/technical-terms.ts`), dictionnaire utilisateur et noms propres (prévus, vides pour l'instant).
3. Élision : dans « l’informatiue », seul le mot est examiné. Si le mot seul est correct (« l’occasions »), ce n'est pas une faute d'orthographe mais d'accord : rien n'est signalé (futur analyseur grammatical).
4. Anglicisme : un mot connu en anglais (« team », « online », « install », « queries ») n'est jamais signalé.
5. Mot inconnu présent au moins 3 fois dans le document : considéré comme voulu (terme, nom).
6. Contrôle rapide (quelques ms) : existe-t-il un mot du dictionnaire à une faute près (ou à deux fautes légères : accent, lettre doublée) ? Sinon, aucune correction possible. Ce contrôle évite d'interroger nspell pour un nom propre, ce qui peut lui prendre plusieurs secondes.
7. Suggestions de nspell (au plus 8), sur la forme en minuscules : les noms propres sont écartés, la casse d'origine est rétablie (« Informatiue » → « Informatique »).
8. Classement et confiance (`spelling/ranking.ts`).

### Classement et confiance

Distance pondérée selon les fautes réelles en français : casse 0,1 · accent 0,3 · lettre doublée ou dédoublée 0,5 · touche voisine (AZERTY) 0,7 · deux lettres inversées 0,7 · lettre manquante ou en trop 1,0 · autre substitution 1,2. Le rang donné par nspell départage légèrement ; une fréquence d'usage pourra s'y ajouter (`spelling/frequency.ts`, interface prête, aucune source installée).

| Confiance | Conditions                                                                                                                                        | Résultat                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Élevée    | Même premier choix que nspell, coût ≤ 1,3 (≤ 0,8 pour un mot de 5 lettres ou moins), écart ≥ 0,5 avec le deuxième, au plus 2 candidats plausibles | **Erreur** avec correction                       |
| Moyenne   | Même premier choix, écart ≥ 0,15 (ou formes d'un même mot, ex. heureux / heureuse), au plus 3 candidats plausibles                                | **Suggestion**, l'explication cite l'autre forme |
| Faible    | Tout le reste                                                                                                                                     | Aucun signalement                                |

Un mot avec majuscule en milieu de phrase (peut-être un nom propre) ne dépasse jamais la confiance moyenne. Un mot simplement absent du dictionnaire n'est jamais présenté comme une faute certaine.

Exemples obtenus (tests) : developpeur → développeur, environement → environnement, acceuil → accueil, professionel → professionnel, systeme → système (Erreurs) ; Informatiue → Informatique, heureus → heureux (Suggestions). Volontairement non corrigés : « peris » (paris, péris, permis… aussi proches), « cadr » (cade, cadre, cadra…), « l’occasions » (accord).

### Mémoire et chargement

Mesures sur Node.js 22 (worker réel, fournisseur d'IA de test) :

| Mesure                                                                     | Valeur                                    |
| -------------------------------------------------------------------------- | ----------------------------------------- |
| Chargement (nspell + Grammalecte + liste anglaise)                         | **≈ 5,1 s**, une seule fois par processus |
| Tas JavaScript après chargement (après GC)                                 | **≈ 302 Mo** (dont liste anglaise ≈ 3 Mo) |
| RSS du worker : avant → après chargement                                   | 170 Mo → ≈ 690 Mo au repos                |
| RSS du worker après 2 petits documents, puis un document de 59 000 mots    | 725 → 737 → 761 Mo                        |
| RSS après 2 documents de 59 000 mots en parallèle (`WORKER_CONCURRENCY=2`) | ≈ 804 Mo (pic)                            |
| Tas minimal pour charger le dictionnaire                                   | ≈ 416 Mo (échec à 384 Mo)                 |

- **Une seule instance par processus** : `loadSpellingDictionaries()` mémorise le chargement (les appels simultanés partagent la même promesse) ; `dictionaryLoadStats().loads` reste à 1, vérifié par un test sur plusieurs documents. Le log « Dictionnaires orthographiques chargés » du worker donne la durée et la mémoire mesurées.
- **Worker uniquement** : préchargé au démarrage (`SpellingPreloadService`, déclaré dans `WorkerModule`), et attendu par le moteur avant chaque analyse. L'API ne l'importe jamais (≈ 200 Mo de RSS, inchangé).
- **Risque d'OOM** : `start:worker` fixe `--max-old-space-size=1024`, pour ne pas dépendre de la limite par défaut de Node (calculée d'après la mémoire de la machine, parfois inférieure à 416 Mo dans un petit conteneur). Prévoir **au moins 1 Go de mémoire pour le processus worker**. Les documents sont plafonnés (20 Mo, 60 000 mots) et les caches de mots sont bornés : la consommation reste stable d'un document à l'autre.

### Performance

- 60 000 mots : moins de 0,5 s pour l'orthographe (test), ≈ 1,2 à 1,6 s d'analyse complète avec l'IA de test.
- Au plus 200 mots inconnus distincts interrogés par document (`maxSuggestionLookups`), 60 signalements d'orthographe au plus.

## Configuration

Tous les seuils sont dans `engine/language/config.ts` (`LANGUAGE_ENGINE_CONFIG`) : types de paragraphes analysés, plafonds par règle, exceptions de répétition, seuil de phrase longue, détection des énumérations, et pour l'orthographe (`spelling`) longueurs de mots, nombre de suggestions examinées, budget de recherches, seuil de répétition, coûts et écarts de confiance. Un moteur avec d'autres réglages s'obtient par `createLanguageEngine(config)`.

## Ajouter un analyseur

1. Créer `engine/language/analyzers/<nom>.analyzer.ts` qui implémente `LanguageAnalyzer` :
   - `id` : nom court ;
   - `blockKinds(config)` : types de paragraphes acceptés ;
   - `analyze(block, context)` : renvoie des `LanguageIssue` avec `rule`, `category`, `subtype` (de la taxonomie partagée), `range` exacte dans `block.text`, `original` égal au texte de cette plage, `suggestion` ou `null`, `confidence`, `severity`, `source: 'rules'`.
2. Ajouter l'identifiant de règle dans `LANGUAGE_RULE_IDS` et son plafond dans `LANGUAGE_ENGINE_CONFIG.caps`.
3. L'enregistrer dans `createLanguageEngine()` (`language-engine.ts`).
4. Respecter les règles du moteur : linéaire sur la longueur du paragraphe, aucun appel réseau, aucune correction propre à un document particulier, zones protégées (`context.protectedRanges`) respectées, et confiance élevée réservée aux cas certains. Un cas douteux n'est pas signalé, ou l'est avec une confiance faible.
5. Ajouter les tests : cas détectés, faux positifs évités, puis vérifier que le corpus (`pnpm test:integration`) ne produit toujours aucune « erreur » sur les documents propres.

## Tester

```bash
pnpm --filter @wordfix/api exec vitest run --project unit src/engine   # moteur et règles
pnpm test:integration                                                   # pipeline complet + corpus de 13 documents
```

`analyzers/spelling.analyzer.spec.ts` couvre l'orthographe (mots corrects, fautes inconnues, noms propres, sigles, URL, e-mails, chemins, termes techniques, casse, accents, plusieurs fautes, doublons, 60 000 mots, chargement unique du dictionnaire). Les tests qui utilisent le moteur chargent les dictionnaires une fois par fichier (≈ 5 s).

`language-engine.spec.ts` couvre les répétitions, les phrases longues, la typographie, les garde-fous, la localisation multi-paragraphes, les plafonds, la compatibilité avec le pipeline (nature décidée par le backend) et la performance sur 60 000 mots.
