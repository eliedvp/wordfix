# Architecture — WordFix MVP

Ce document décrit le code tel qu'il est. Les choix et leurs raisons sont dans [`decisions.md`](decisions.md).

## Processus

| Processus | Point d'entrée                  | Rôle                                                                                    |
| --------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| Site      | `apps/web` (`next start`)       | Pages, appels `/api/*` relayés vers l'API (réécritures)                                 |
| API       | `apps/api/src/main.ts`          | Import, validation, documents, analyses, décisions ; n'écoute qu'en local               |
| Worker    | `apps/api/src/worker.ts`        | File `analysis` (moteur d'analyse) et file `maintenance` (purge horaire)                |
| Export    | `apps/api/src/export-worker.ts` | File `export` (documents corrigés), une tâche à la fois, un processus enfant par export |

L'API et le worker partagent le même code (`infrastructureImports` dans `app.module.ts`) mais tournent séparément : une analyse longue ne bloque jamais une requête HTTP, et un arrêt du worker n'arrête pas le site.

## Document corrigé (export)

1. `POST /api/analyses/:id/exports` (API) : propriété vérifiée, quota (`QUOTA_EXPORTS_PER_HOUR`, 10 par session et par heure), analyse terminée, fichier d'origine présent. Les corrections sont **figées** : points `accepted` (suggestion) et `edited` (texte de l'utilisateur), avec positions et texte du paragraphe tel qu'analysé. Aucun point : `EXPORT_NOTHING_TO_APPLY`, aucun export. Mêmes corrections qu'un export encore valide : celui-ci est renvoyé. Expiration = celle du fichier d'origine (24 h après l'import au plus).
2. Service d'export (`export-worker.ts`, processus séparé du worker d'analyse) : file `export`, **une tâche à la fois**. Chaque export s'exécute dans un **processus enfant éphémère** (`exports/export-child.ts`) qui applique `applyTextEdits` à une copie de l'original ; l'original n'est jamais modifié. Fichier produit : `documents/{id}/exports/{exportId}.docx`.
3. Aucune correction applicable : export `FAILED` (`EXPORT_NO_APPLICABLE`) avec les motifs, aucun fichier (jamais l'original à sa place). Mémoire dépassée (surveillance, tas, arrêt par le noyau) : `EXPORT_TOO_LARGE`. Délai dépassé : `EXPORT_TIMEOUT`. Panne inattendue (lancement, échange avec l'enfant, sortie anormale, vérification finale) : `EXPORT_FAILED`. `READY` n'est posé qu'après réception du message complet de l'enfant (fichier déjà relu et vérifié) **et** enregistrement réussi du fichier.
4. `GET /api/exports/:id` (état, compte rendu) ; `GET /api/exports/:id/download` (pièce jointe « Nom (corrigé).docx », jamais mise en cache, refusée après expiration).
5. Exports bloqués depuis plus de 15 min : marqués en échec par le service d'export (au démarrage puis toutes les 5 min) et par la purge horaire. Reprise sans doublon : une même ligne d'export, une clé de fichier déterministe ; une exécution en double ne supprime jamais un fichier déjà publié. Fichiers produits supprimés (par leur clé déterministe, y compris un fichier jamais publié) à expiration, avec leur document ou son fichier d'origine.
6. Interface (`components/results/export-panel.tsx`, dans l'espace de relecture) : panneau « Document corrigé ». Génération seulement s'il y a au moins un point accepté (avec proposition) ou modifié, et si le fichier d'origine est encore disponible ; suivi de l'état (interrogé toutes les 1,5 s : en attente, génération), téléchargement **uniquement** d'un export `READY` non expiré, par la route d'export (jamais le fichier d'origine), avec message clair en cas d'erreur. Compte rendu : corrections appliquées / demandées, corrections non appliquées avec le passage, la correction choisie et le motif. Si les choix changent après la génération, le document est signalé comme périmé et une nouvelle version est proposée. Aucune route ne liste les exports d'une analyse : le dernier export demandé est retrouvé après rechargement grâce à son identifiant gardé dans le stockage de session de l'onglet. Un nouvel essai n'est proposé que s'il peut aboutir (panne, délai) ou si les choix ont changé : chaque demande compte dans le quota.

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
5. Chaque décision part en `PATCH /api/issues/:id`. La réponse contient le problème enregistré et le compteur « points traités » de l'analyse (statut différent de `open`), recompté dans la même transaction que la décision. Le site écrit ce compteur directement dans son cache, sans dépendre d'une seconde requête :
   - une réponse ancienne arrivée en retard est ignorée ;
   - en cas d'échec, seul le point concerné est rétabli ;
   - l'analyse est ensuite relue, et une relecture refusée (limite de débit, coupure) est retentée toutes les 5 s jusqu'à réussir.

## Modèle de données (Prisma)

`User` (invité, prêt pour les comptes) → `Document` (fichier, expirations) → `DocumentContent` (structure JSON) et `Analysis` (statut, avancement, score, avertissements, jetons) → `AnalysisChunk` (un appel IA prévu, son état et son résultat) et `Issue` (catégorie, nature, gravité, confiance, localisation, extrait, suggestion, explication, emplacements liés, statut, empreinte unique).

## Représentation d'un document

`packages/shared/src/document-model.ts` : sections (arbre, chemin lisible), blocs dans l'ordre de lecture (titre, paragraphe, liste, cellule, légende, sommaire, note, en-tête, pied de page) avec phrases, page estimée et **ancre** vers les runs du XML d'origine — base du futur export `.docx` corrigé par modification ciblée du XML.

Écriture d'un `.docx` existant (socle, pas encore utilisé par l'API) : `docx/writer/rewrite-docx.ts`. Sans modification, les octets d'origine sont renvoyés tels quels. Sinon, seules les parties XML demandées sont réécrites (`docx/writer/xml-writer.ts`, relecture obligatoire de l'arbre produit) ; les autres entrées du paquet sont recopiées à l'identique, dans le même ordre et avec la même compression, puis l'archive produite est relue et vérifiée. Les paragraphes et runs à modifier sont retrouvés par le même parcours que la lecture (`docx/parser/parts.ts`), donc avec les mêmes numéros que les ancres du modèle. Commentaires XML, instructions de traitement, encodages autres que UTF-8 et archives dont deux entrées portent le même nom (à la casse près) sont refusés plutôt que perdus ou modifiés en silence.

Remplacements de texte ciblés (socle, pas encore utilisé par l'API) : `docx/writer/text-edits.ts`. Chaque correction désigne un passage d'un bloc ; le fichier actuel est relu et la correction n'est appliquée que si le texte du paragraphe et le passage sont identiques à ceux de l'analyse, et seulement dans du texte simple (`w:t`) : jamais dans une tabulation ou un saut de ligne, un résultat de champ, un contrôle de contenu, une insertion ou une mise en forme suivies, une entrée de sommaire, ni à cheval sur des runs non voisins ou de mises en forme différentes, ni en insertion à la frontière de deux mises en forme différentes ; un texte d'en-tête ou de pied de page présent à plusieurs endroits (le modèle n'en garde qu'une occurrence) n'est jamais corrigé. Toute correction écartée l'est avec un motif. Après réécriture, l'arbre relu doit donner le texte attendu pour les paragraphes corrigés (structure inchangée hors texte) et des paragraphes non ciblés strictement identiques (empreintes) ; sinon aucun fichier n'est produit. Coût mesuré sur un document limite (59 000 mots, `document.xml` de 23 Mo) : environ 0,7 Go de pic mémoire et 12 s ; l'export devra passer par une file dédiée du worker, un export à la fois (T3).

## Moteur et IA

- **Mode IA** (`AI_PROVIDER`) : `none` par défaut, aucune IA. Le worker démarre sans clé, aucun SDK n'est chargé, aucun morceau IA n'est planifié et l'analyse est marquée `AI_DISABLED` (étapes IA « sautées », score présenté comme « sans IA »). `openai`/`gemini` : appels payants, refusés au démarrage sans `AI_PAID_CALLS_ENABLED=true` et `AI_DAILY_TOKEN_BUDGET` > 0. `GET /api/ai-mode` expose le mode, sans secret, pour la page Confidentialité.
- `ai/ai-provider.ts` : interface unique ; `OpenAiProvider` (Responses API, sortie JSON stricte, `store: false`) ; `GeminiAiProvider` (SDK officiel `@google/genai`, `generateContent` sans état, sortie JSON contrainte par `responseJsonSchema`, `AI_PROVIDER=gemini`, modèles `GEMINI_MODEL_*`) pour les essais ; `FakeAiProvider` réservé aux tests. Les règles de l'étape C (option parmi les candidats, jamais d'Erreur) sont dans le moteur, communes à tous les fournisseurs.
- **Débit et pannes de l'IA** :
  - `ai/rate-limiter.ts` : limiteur partagé par tous les appels Gemini du worker (toutes analyses et tous morceaux confondus). Les requêtes partent au plus `GEMINI_REQUESTS_PER_MINUTE` fois par minute (5 par défaut, offre gratuite de `gemini-3.8-flash`), espacées régulièrement et dans l'ordre des demandes. Portée : un processus ; plusieurs workers sur la même clé doivent se répartir le quota.
  - 429 par minute : le délai indiqué par Google (`retryDelay`) devient une **pause commune**, et plus aucune requête ne part avant sa fin. Sans délai indiqué, l'attente croît (2 s, 4 s, 8 s…, 60 s au plus). Au plus `AI_MAX_RETRIES` nouveaux essais, et au-delà de 90 s d'attente demandée, l'appel abandonne (`unavailable`). Le quota quotidien épuisé donne `quota`, sans nouvel essai ni pause.
  - `engine/ai-guard.ts` : coupe-circuit par analyse, inchangé. Il coupe aussitôt sur `quota` ou `config`, et après 3 échecs temporaires consécutifs.
  - IA indisponible : l'analyse se termine avec le moteur déterministe (avertissement `AI_CHECKS_SKIPPED`). `skippedAiChecks` (`engine/skipped-ai-checks.ts`) détaille ce qui n'a pas été vérifié : passages de la relecture locale, groupes de sections, vérifications globales, cas ambigus.
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
