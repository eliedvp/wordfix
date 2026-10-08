# Stratégie de tests — WordFix MVP

Le MVP n'est pas considéré comme terminé tant que les parcours critiques ci-dessous ne sont pas verts. Tous les tests tournent en intégration continue (`.github/workflows/ci.yml`).

## Niveaux

| Niveau          | Outil              | Commande                                  | Contenu                                                                                                                                 |
| --------------- | ------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Unitaire        | Vitest             | `pnpm test`                               | Validateur et lecteur DOCX, règles, ancrage, nature, score, schémas IA, fournisseur OpenAI (HTTP simulé), composants et filtres du site |
| Intégration     | Vitest + Supertest | `pnpm test:integration`                   | API complète + file BullMQ + worker + moteur, contre PostgreSQL et Redis réels, avec le fournisseur IA de test                          |
| E2E             | Playwright         | `pnpm test:e2e`                           | Parcours dans Chromium sur le build de production (site + API + worker)                                                                 |
| Qualité de l'IA | script             | `pnpm --filter @wordfix/api eval:quality` | Vraie API OpenAI sur des fautes connues : rappel, précision, faux positifs                                                              |

Le fournisseur IA `fake` (réponses déterministes) n'existe que pour les tests : la configuration le refuse hors `NODE_ENV=test`.

### Bases dédiées

- Intégration : `wordfix_test` (recréée à chaque lancement) et Redis n° 15. Créez-la une fois : `docker compose exec postgres createdb -U wordfix wordfix_test`. Variables : `TEST_DATABASE_URL`, `TEST_REDIS_URL` ; sans `TEST_DATABASE_URL`, la base de test utilise le port `POSTGRES_PORT` (environnement, puis `.env`), sinon 5432.
- E2E : `wordfix_e2e` (créée automatiquement) et Redis n° 14 ; l'API de test écoute sur le port 4000 : arrêtez `pnpm dev` avant. Variables : `E2E_DATABASE_URL`, `E2E_REDIS_URL` ; sans `E2E_DATABASE_URL`, la base E2E utilise le port `POSTGRES_PORT` (environnement, puis `.env`), sinon 5432.

## Corpus de documents (`apps/api/test/fixtures/corpus.ts`)

Générés à la volée (bibliothèque `docx`, décision D2) ; `pnpm --filter @wordfix/api fixtures:generate` les écrit sur disque pour des essais manuels.

| #   | Document                                         | Résultat attendu                                                            | Test                                                    |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | Petit document                                   | Analyse terminée, aucune erreur inventée                                    | `test/corpus.e2e-spec.ts`                               |
| 2   | Rapport de 10 pages                              | 8 à 12 pages estimées, analyse terminée                                     | idem                                                    |
| 3   | Rapport de 45 pages                              | ≥ 40 pages, > 10 morceaux tous traités, pipeline < 45 s sans IA réelle      | idem                                                    |
| 4   | Beaucoup de fautes                               | ≥ 10 erreurs, plafonds respectés, score < 90                                | idem                                                    |
| 5   | Presque sans faute                               | 0 erreur, score ≥ 90                                                        | idem                                                    |
| 6   | Répétitions                                      | Mots doublés ; graphies concurrentes (e-mail / email, Wi-Fi / wifi)         | idem                                                    |
| 7   | Contradictions                                   | Une contradiction « à examiner », deux passages liés, jamais « erreur »     | idem + `analysis.e2e-spec.ts`                           |
| 8   | Tableaux                                         | Fautes localisées « Tableau 1, ligne N, colonne M »                         | idem + `docx-parser.spec.ts`                            |
| 9   | Titres complexes                                 | Arbre à 4 niveaux, saut de numérotation signalé ; titres non stylés déduits | idem + `docx-parser.spec.ts`                            |
| 10  | Document vide                                    | `EMPTY_DOCUMENT` (422), aucune session créée                                | idem                                                    |
| 11  | Document corrompu                                | `CORRUPTED_FILE` (422)                                                      | idem + `errors.spec.ts` (E2E)                           |
| 12  | Faux `.docx` (PDF, ZIP), `.doc`, `.docx` protégé | `UNSUPPORTED_FORMAT`, `LEGACY_DOC_FORMAT`, `PASSWORD_PROTECTED`             | idem + `docx-validator.spec.ts`                         |
| 13  | Trop volumineux / trop long                      | `FILE_TOO_LARGE` (413, coupé à l'envoi) / `DOCUMENT_TOO_LONG`               | idem + `errors.spec.ts` (E2E, refus dans le navigateur) |

Fichiers hostiles en plus : bombe ZIP, XML avec entités externes (XXE), `.docm` et `vbaProject.bin` (`docx-validator.spec.ts`).

## Scénarios système

| Scénario                                                                               | Vérifié par                                                                |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Upload (session après validation, stockage, isolation entre sessions)                  | `documents.e2e-spec.ts`                                                    |
| Extraction (sections, tableaux, listes, notes, pages, suivi des modifications, champs) | `docx-parser.spec.ts`                                                      |
| Création du job (une seule analyse active)                                             | `analysis.e2e-spec.ts`                                                     |
| Traitement BullMQ + moteur complet                                                     | `analysis.e2e-spec.ts`, `corpus.e2e-spec.ts`                               |
| Analyse IA (sortie stricte, ancrage, nature, prudence)                                 | `openai.provider.spec.ts`, `anchor.spec.ts`, `nature-policy.spec.ts`       |
| Erreur IA → échec propre puis relance                                                  | `analysis.e2e-spec.ts`                                                     |
| Sauvegarde PostgreSQL sans doublon, reprise                                            | `analysis.e2e-spec.ts` (reprise sans rappeler l'analyse locale)            |
| Récupération et filtres des résultats                                                  | `analysis.e2e-spec.ts`, `filtering.test.ts`                                |
| Affichage frontend                                                                     | `journey.spec.ts`, `mobile.spec.ts`                                        |
| Erreurs réseau                                                                         | `errors.spec.ts` (coupure pendant l'envoi), décisions optimistes rétablies |
| Interruption / annulation / suppression pendant l'analyse                              | `analysis.e2e-spec.ts`                                                     |
| Sécurité (CSRF, quotas, budget, en-têtes, purge)                                       | `security.e2e-spec.ts`                                                     |

## Qualité de l'IA

Objectifs MVP : rappel ≥ 80 % sur les fautes injectées, précision des « erreurs » ≥ 90 %, aucune « erreur » sur un texte sans faute. À mesurer avec la vraie clé avant la mise en production et à chaque changement de prompt (`PROMPT_VERSION`) ou de modèle.
