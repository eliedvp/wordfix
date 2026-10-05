# Architecture — WordFix MVP

Ce document décrit le code tel qu'il est. Les choix et leurs raisons sont dans [`decisions.md`](decisions.md).

## Processus

| Processus | Point d'entrée            | Rôle                                                                      |
| --------- | ------------------------- | ------------------------------------------------------------------------- |
| Site      | `apps/web` (`next start`) | Pages, appels `/api/*` relayés vers l'API (réécritures)                   |
| API       | `apps/api/src/main.ts`    | Import, validation, documents, analyses, décisions ; n'écoute qu'en local |
| Worker    | `apps/api/src/worker.ts`  | File `analysis` (moteur d'analyse) et file `maintenance` (purge horaire)  |

L'API et le worker partagent le même code (`infrastructureImports` dans `app.module.ts`) mais tournent séparément : une analyse longue ne bloque jamais une requête HTTP, et un arrêt du worker n'arrête pas le site.

## Parcours d'une analyse

1. `POST /api/documents` : quota d'import, validation du fichier (`docx/docx-validator.ts`), session créée après validation, fichier stocké sous `documents/{id}/source.docx`, statistiques rapides (mots, pages).
2. `POST /api/documents/:id/analyze` : une seule analyse active par document, fichier encore disponible, budget IA, quotas → `Analysis` (`QUEUED`) + job BullMQ (identifiant = analyse).
3. Worker (`engine/analysis-runner.ts`) :
   - **lecture** : extraction structurée (`docx/parser/`) enregistrée dans `DocumentContent` ; avertissements (langue, titres déduits, éléments ignorés, mode secours) ;
   - **planification** : morceaux locaux (~1 800 mots), groupes de sections (~2 500 mots), un appel global ; règles déterministes enregistrées tout de suite ;
   - **locale** → **contextuelle** (avec fiches de section) → **globale** (plan + fiches) → **vérification** des contradictions ;
   - **finalisation** : déduplication, plafond, score.
     Chaque morceau est enregistré dès qu'il est traité (`AnalysisChunk`) : une reprise ne refait que ce qui manque.
4. Le site interroge `GET /api/analyses/:id` toutes les 2 s, puis charge `GET /api/analyses/:id/issues` (problèmes + texte des paragraphes concernés).
5. Chaque décision part en `PATCH /api/issues/:id`.

## Modèle de données (Prisma)

`User` (invité, prêt pour les comptes) → `Document` (fichier, expirations) → `DocumentContent` (structure JSON) et `Analysis` (statut, avancement, score, avertissements, jetons) → `AnalysisChunk` (un appel IA prévu, son état et son résultat) et `Issue` (catégorie, nature, gravité, confiance, localisation, extrait, suggestion, explication, emplacements liés, statut, empreinte unique).

## Représentation d'un document

`packages/shared/src/document-model.ts` : sections (arbre, chemin lisible), blocs dans l'ordre de lecture (titre, paragraphe, liste, cellule, légende, sommaire, note, en-tête, pied de page) avec phrases, page estimée et **ancre** vers les runs du XML d'origine — base du futur export `.docx` corrigé par modification ciblée du XML.

## Moteur et IA

- `ai/ai-provider.ts` : interface unique ; `OpenAiProvider` (Responses API, sortie JSON stricte, `store: false`) ; `FakeAiProvider` réservé aux tests.
- `engine/language/` : WordFix Language Engine, analyse linguistique déterministe et locale (répétitions, typographie, phrases longues) ; voir [`language-engine.md`](language-engine.md). `engine/rules/rules.ts` l'appelle et garde les règles portant sur le document entier (numérotation, sommaire, sigles, graphies).
- `engine/schemas.ts` : schémas zod des réponses, convertis en JSON Schema strict (`ai/strict-json-schema.ts`).
- `engine/prompts/prompts.v1.ts` : consignes versionnées (`PROMPT_VERSION` enregistrée sur chaque analyse).
- `engine/postprocess/` : ancrage des extraits (rejet si introuvable), nature décidée par le backend, formulation prudente imposée, localisation, déduplication.
- `engine/scoring.ts` : score transparent et configurable.

## Frontend

- `app/` : accueil, `analyses/[id]` (progression ou résultats selon le statut), `historique`, `confidentialite`.
- `components/upload` (import en deux temps), `components/analysis` (progression, échec), `components/results` (espace de relecture), `components/history`.
- `lib/api` (client typé, envoi avec progression), `lib/hooks` (suivi par interrogation, décisions optimistes), `lib/copy.ts` (textes validés).

## Évolutions préparées

- **Comptes** : `User.isGuest`, `email`, `role` ; garde de propriétaire déjà appliquée partout.
- **Export `.docx` corrigé** : ancres de runs + décisions enregistrées (`accepted`, `edited` avec texte).
- **Autres fournisseurs IA** : nouvelle implémentation de `AiProvider`.
- **Suivi en temps réel** : l'écran d'analyse ne dépend que de `AnalysisDto` ; un flux SSE pourrait remplacer l'interrogation.
