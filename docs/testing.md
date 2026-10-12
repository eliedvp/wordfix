# Stratégie de tests — WordFix MVP

Le MVP n'est pas considéré comme terminé tant que les parcours critiques ci-dessous ne sont pas verts. Tous les tests tournent en intégration continue (`.github/workflows/ci.yml`).

## Niveaux

| Niveau          | Outil              | Commande                                  | Contenu                                                                                                                                 |
| --------------- | ------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Unitaire        | Vitest             | `pnpm test`                               | Validateur et lecteur DOCX, règles, ancrage, nature, score, schémas IA, fournisseur OpenAI (HTTP simulé), composants et filtres du site |
| Intégration     | Vitest + Supertest | `pnpm test:integration`                   | API complète + file BullMQ + worker + moteur, contre PostgreSQL et Redis réels, avec le fournisseur IA de test                          |
| Processus       | Vitest             | `pnpm test:process`                       | Superviseur et protocole du processus enfant d'export, vrais processus, sans base ni Redis (Linux et Windows en CI)                     |
| E2E             | Playwright         | `pnpm test:e2e`                           | Parcours dans Chromium sur le build de production (site + API + worker + service d'export)                                              |
| Qualité de l'IA | script             | `pnpm --filter @wordfix/api eval:quality` | Vraie API OpenAI sur des fautes connues : rappel, précision, faux positifs                                                              |

Documents corrigés : `test/exports.e2e-spec.ts` (API, worker d'analyse et service d'export réels ; processus enfant lancé avec `tsx`) : parcours complet, refus explicites, droits, quota, expiration, corrections figées, une tâche à la fois, mémoire et délai dépassés, récupération des exports bloqués, exécution en double sans doublon ni fichier supprimé à tort, fichiers jamais publiés purgés, purge, absence de texte dans les journaux.

Processus d'export : `apps/api/test/export-child.process-spec.ts` (projet Vitest `process`, `pnpm test:process`) : superviseur et protocole parent-enfant avec de vrais processus enfants, **sans base ni Redis**. Exécuté en CI sous Linux (job « Qualité et tests ») et sous Windows (job « Processus d'export sous Windows »). `scripts/check-process-report.ts` lit le rapport : il compte les tests exécutés (réussis + échoués), réussis, échoués et ignorés (non exécutés, jamais comptés comme réussis), et fait échouer le job si un test échoue, si le rapport est absent, ou si un test autre que ceux du contrôle mémoire est ignoré (ou si l'un de ceux-ci l'est alors que `/proc` est disponible). En CI, ce décompte figure dans le résumé du job et dans une annotation ; sous Windows, il est produit même après un échec des tests, et le rapport `apps/api/test-results/process.json` est conservé comme artefact (`process-tests-windows`, 14 jours).

Selon le système :

| Tests                                                                                                                                          | Linux                                                                              | Windows, macOS (pas de `/proc`)                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Dépassement mémoire (surveillance du pic, contrôle final, pic pendant l'envoi ; et le test HTTP « mémoire dépassée » de `exports.e2e-spec.ts`) | Exécutés                                                                           | **Ignorés** (signalés « skipped », jamais comptés comme réussis) : WordFix ne lit pas la mémoire de l'enfant sur ces systèmes |
| Export normal, délai dépassé, limite suffisante, protocole parent-enfant (fin de l'enfant dans tous les cas, service arrêté brutalement)       | Exécutés (fin vérifiée par `/proc` ; un processus « zombie » compte comme terminé) | Exécutés (fin vérifiée par le signal 0)                                                                                       |
| « Sans lecture du pic » : aucun contrôle mémoire par WordFix (limite connue)                                                                   | Exécuté (fonctionnement sans `/proc` reproduit)                                    | Exécuté                                                                                                                       |

**Compatibilité Windows : pas encore validée.** Le job Windows n'a encore jamais tourné : il s'exécutera au premier envoi de la branche sur GitHub. Il vérifie en particulier `process.kill(pid, 0)` (fin d'un processus vérifiée par existence), l'arrêt forcé de l'enfant (`child.kill('SIGKILL')`) et le classement du résultat, la fermeture du canal IPC (canal nommé sous Windows) quand le service d'export meurt (`process.kill(process.pid, 'SIGKILL')` dans `test/fixtures/dying-export-service.ts`) et la fin de l'enfant après sa libération. Les tests d'intégration (base, Redis) et Playwright ne tournent pas sous Windows en CI.

La sécurité mémoire des exports repose donc, en production, sur Linux et sur la limite de l'environnement (1,5 Gio, à configurer et vérifier sur l'hébergement). Simulation utilisée sous Linux pour vérifier ce tableau : `existsSync` et `readFileSync` du processus de test rendus aveugles à `/proc` (`pnpm test:process` : 12 exécutés, 3 ignorés, contrôle du rapport réussi).

Interface du document corrigé : `apps/web/__tests__/export-panel.test.tsx` (vrais composants, API simulée) : aucune correction choisie, attente puis génération puis téléchargement (jamais avant `READY`), corrections non appliquées avec motif, échecs (`EXPORT_NO_APPLICABLE`, `EXPORT_TIMEOUT`, `EXPORT_FAILED`, `EXPORT_TOO_LARGE`) avec ou sans nouvel essai, choix modifiés après génération, quota, téléchargement expiré, fichier d'origine supprimé, reprise après rechargement, export introuvable. Bout en bout : `apps/web/e2e/export.spec.ts` (service d'export lancé par Playwright) : génération, téléchargement d'un fichier distinct de l'original contenant la correction, reprise après rechargement sans nouvelle demande, choix modifiés. Sous Linux, Chromium a besoin d'une locale UTF-8 (`LANG=C.UTF-8`, par défaut sur les machines GitHub Actions) pour conserver le nom accentué « (corrigé) » du fichier téléchargé.

Le fournisseur IA `fake` (réponses déterministes) n'existe que pour les tests : la configuration le refuse hors `NODE_ENV=test`. Ce n'est pas une vraie correction. Le mode par défaut `none` (aucune IA) est couvert par `test/ai-none.e2e-spec.ts` : analyse complète sans aucun appel IA, reprise sans relancer le moteur local.

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
