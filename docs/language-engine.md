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

| Analyseur            | Règle                       | Exemple                          | Catégorie / sous-type     | Confiance → nature                   |
| -------------------- | --------------------------- | -------------------------------- | ------------------------- | ------------------------------------ |
| `RepetitionAnalyzer` | `repeated_word`             | « permet permet » → « permet »   | spelling / typo           | élevée + correction → Erreur         |
| `TypographyAnalyzer` | `double_space`              | deux espaces entre deux mots     | punctuation / spacing     | élevée, sans correction → Suggestion |
|                      | `space_before_punctuation`  | « serveur , » → « serveur, »     | punctuation / spacing     | élevée + correction → Erreur         |
|                      | `doubled_punctuation`       | « ,, » → « , »                   | punctuation / punctuation | élevée + correction → Erreur         |
|                      | `missing_space_after_comma` | « rouge,vert » → « rouge, vert » | punctuation / spacing     | élevée + correction → Erreur         |
| `SentenceAnalyzer`   | `long_sentence`             | phrase de plus de 45 mots        | style / too_long          | moyenne → Suggestion                 |

### Garde-fous contre les faux positifs

- Titres, entrées de sommaire, en-têtes et pieds de page ne sont pas analysés.
- URL, adresses e-mail, chemins, noms de fichiers et identifiants techniques (`Node.js`, `config.json`, `src/app`) sont protégés.
- Répétitions : seulement deux mots identiques séparés par des espaces. Exceptions « nous nous » et « vous vous ». Ni répétition à travers une ponctuation (« oui, oui »), ni mots de même famille (« il permet de permettre »).
- Typographie : nombres (« 3,5 »), variables d'une lettre (« x,y ») et code (« f(a,b) ») exclus. Un signalement n'est émis que si le texte est continu dans le fichier Word : une image, un appel de note ou un champ invisible entre deux caractères suffit à l'annuler. L'espace avant la ponctuation n'est pas contrôlée dans un document contenant des équations (absentes du texte extrait).
- Phrases longues : énumérations (points-virgules) et phrases surtout numériques ignorées.
- Un même endroit n'est signalé qu'une fois ; chaque règle est plafonnée par document.

Non traité volontairement à ce stade : orthographe des mots inconnus, accords, espaces avant « ; : ! ? » (conventions différentes selon les pays), guillemets et apostrophes.

## Configuration

Tous les seuils sont dans `engine/language/config.ts` (`LANGUAGE_ENGINE_CONFIG`) : types de paragraphes analysés, plafonds par règle, exceptions de répétition, seuil de phrase longue, détection des énumérations. Un moteur avec d'autres réglages s'obtient par `createLanguageEngine(config)`.

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

`language-engine.spec.ts` couvre les répétitions, les phrases longues, la typographie, les garde-fous, la localisation multi-paragraphes, les plafonds, la compatibilité avec le pipeline (nature décidée par le backend) et la performance sur 60 000 mots.
