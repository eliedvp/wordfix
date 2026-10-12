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

## Tout corriger

- Règle unique, partagée par l'API et le site : `packages/shared/src/corrections.ts` (`isReliableCorrection`). Sont acceptés d'un coup les seuls points encore à traiter (`open`), d'orthographe, de grammaire ou de ponctuation, de nature « erreur », en confiance élevée, avec une proposition utilisable (présente, différente du passage, sur une ligne). Points incertains (« à examiner », « à vérifier », confiance moyenne ou faible, style, cohérence, structure) et décisions de l'utilisateur (acceptées, modifiées, ignorées, vérifiées) : jamais modifiés.
- `POST /api/analyses/:id/issues/accept-reliable` : acceptation en une transaction, renvoie les points acceptés et l'avancement recompté. Analyse non terminée : `ANALYSIS_NOT_READY`.
- `POST /api/analyses/:id/issues/undo-accept` (`{ issueIds }`, 1 000 au plus) : seuls les points encore acceptés redeviennent « à traiter » ; une décision prise depuis est conservée.
- Interface : carte « Correction rapide » du panneau « Corriger » (`components/results/quick-fix.tsx`), bouton « Tout corriger (n) », annulation. Les points du dernier « Tout corriger » sont gardés dans l'onglet (`lib/bulk-batch.ts`), y compris quand il est lancé par « Télécharger les modifications » (case « Inclure les corrections fiables »). Le fichier Word n'est modifié qu'au téléchargement du document corrigé.

## Embellir mon document (« Mise en forme »)

Dans l'interface : panneau « Mise en forme », options « Typographie française » et « Harmonisation de la présentation » (`components/results/formatting-panel.tsx`).

- Options de l'export (`POST /api/analyses/:id/exports` avec `{ typography?, layout? }`), appliquées dans le processus enfant **après** les corrections, à la copie (`docx/writer/beautify.ts`) :
  - **typographie française** (usage de France) : espace insécable avant « ; : ! ? » et à l'intérieur des guillemets « », espaces doubles réduites ; zones techniques (adresses web, e-mails, fichiers, code) et passages non continus laissés tels quels ; chaque modification passe par le moteur de corrections ciblées (mêmes garde-fous que les corrections) ;
  - **mise en page harmonisée** des paragraphes de texte courant du corps (ni titres, listes, tableaux, sommaire, en-têtes, pieds de page, notes, paragraphes centrés ou à droite, révisions de mise en forme) : texte justifié, interligne 1,15 et 6 pt après le paragraphe s'il n'a pas d'espacement propre ; éléments insérés dans l'ordre du schéma WordprocessingML.
- Contrôle final : même nombre et même nature de blocs, et dans chaque bloc les mêmes caractères une fois les espaces retirés ; sinon `beautify_verification_failed`, aucun fichier (`EXPORT_FAILED`). Le texte de chaque paragraphe est aussi contrôlé identique après la mise en page.
- Rien n'a changé (document déjà conforme, sans correction demandée) : `EXPORT_UNCHANGED`, aucun fichier. Options et corrections forment l'empreinte d'un export (`editsHash`) : d'autres options produisent un nouvel export. `ExportDto.options` et `ExportDto.beautified` (nombre de modifications) en rendent compte.

## Document corrigé (export)

1. `POST /api/analyses/:id/exports` (API) : propriété vérifiée, quota (`QUOTA_EXPORTS_PER_HOUR`, 10 par session et par heure), analyse terminée, fichier d'origine présent. Les corrections sont **figées** : points `accepted` (suggestion) et `edited` (texte de l'utilisateur), avec positions et texte du paragraphe tel qu'analysé. Ni point ni option « Embellir » : `EXPORT_NOTHING_TO_APPLY`, aucun export. Mêmes corrections et options qu'un export encore valide : celui-ci est renvoyé. Expiration = celle du fichier d'origine (24 h après l'import au plus).
2. Service d'export (`export-worker.ts`, processus séparé du worker d'analyse) : file `export`, **une tâche à la fois**. Chaque export s'exécute dans un **processus enfant éphémère** (`exports/export-child.ts`) qui applique `applyTextEdits` à une copie de l'original ; l'original n'est jamais modifié. Fichier produit : `documents/{id}/exports/{exportId}.docx`.
3. Aucune correction applicable : export `FAILED` (`EXPORT_NO_APPLICABLE`) avec les motifs, aucun fichier (jamais l'original à sa place). Mémoire dépassée (surveillance périodique du pic à partir de 25 ms, contrôle du pic complet après réception de la réponse, tas, arrêt par le noyau) : `EXPORT_TOO_LARGE`. Délai dépassé : `EXPORT_TIMEOUT`. Panne inattendue (lancement, échange avec l'enfant, sortie anormale, vérification finale) : `EXPORT_FAILED`. `READY` n'est posé qu'après réception du message complet de l'enfant (fichier déjà relu et vérifié) **et** enregistrement réussi du fichier.
4. `GET /api/exports/:id` (état, compte rendu) ; `GET /api/exports/:id/download` (pièce jointe « Nom (corrigé).docx », jamais mise en cache, refusée après expiration).
5. Exports bloqués depuis plus de 15 min : marqués en échec par le service d'export (au démarrage puis toutes les 5 min) et par la purge horaire. Reprise sans doublon : une même ligne d'export, une clé de fichier déterministe ; une exécution en double ne supprime jamais un fichier déjà publié. Fichiers produits supprimés (par leur clé déterministe, y compris un fichier jamais publié) à expiration, avec leur document ou son fichier d'origine.
6. Interface (`components/results/export-panel.tsx`) : panneau « Télécharger les modifications », un seul bouton. Récapitulatif (corrections acceptées ou modifiées, corrections fiables encore à traiter, mise en forme) et avis non bloquant sur les points à vérifier manuellement (« À examiner », « À vérifier » : jamais appliqués d'office). Case « Inclure les corrections fiables » cochée par défaut : « Tout corriger » est exécuté juste avant la demande (même règle, statuts visibles, annulable dans « Corriger »). Un clic demande l'export (seulement s'il y a au moins un point accepté (avec proposition) ou modifié, une correction fiable incluse ou une mise en forme choisie, et si le fichier d'origine est encore disponible), suit son état (interrogé toutes les 1,5 s) et télécharge automatiquement le fichier dès qu'il est `READY`, une seule fois et seulement si les choix affichés sont toujours ceux de la demande ; le même bouton relance ensuite le téléchargement si le navigateur l'a bloqué. Téléchargement **uniquement** d'un export `READY` non expiré, par la route d'export (jamais le fichier d'origine), avec message clair en cas d'erreur. Compte rendu : corrections appliquées / demandées, corrections non appliquées avec le passage, la correction choisie et le motif. Si les choix changent après la génération, le document est signalé comme périmé : le bouton prépare une nouvelle version et « Télécharger la version précédente » reste proposé. Aucune route ne liste les exports d'une analyse : le dernier export demandé est retrouvé après rechargement grâce à son identifiant gardé dans le stockage de session de l'onglet. Un nouvel essai n'est proposé que s'il peut aboutir (panne, délai) ou si les choix ont changé : chaque demande compte dans le quota.

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
   - La même réponse porte `structure` (`DocumentStructureDto`, `engine/structure.ts`) : présence des éléments de structure (titres, titres déduits de leur apparence, titres numérotés dans le texte et ceux dont le numéro est comparé au précédent du même niveau, entrées de sommaire Word et entrées comparables, origine du nombre de pages), calculée à partir du contenu extrait déjà chargé pour cette réponse, sans IA ni requête supplémentaire. Critères partagés avec les règles (`engine/rules/structure-criteria.ts`, sans dépendance au moteur de langue) : un titre compté comme numéroté ou une entrée comptée comme comparable est exactement ce que la règle contrôle. Elle dit ce qui existe, pas sa conformité (donnée par les points relevés). `null` si le contenu extrait n'est plus disponible ; absente d'une API antérieure : le site affiche alors « Non déterminé ».
5. Chaque décision part en `PATCH /api/issues/:id`. La réponse contient le problème enregistré et le compteur « points traités » de l'analyse (statut différent de `open`), recompté dans la même transaction que la décision. Le site écrit ce compteur directement dans son cache, sans dépendre d'une seconde requête :
   - une réponse ancienne arrivée en retard est ignorée ;
   - en cas d'échec, seul le point concerné est rétabli ;
   - l'analyse est ensuite relue, et une relecture refusée (limite de débit, coupure) est retentée toutes les 5 s jusqu'à réussir.

## Modèle de données (Prisma)

`User` (invité, prêt pour les comptes) → `Document` (fichier, expirations) → `DocumentContent` (structure JSON) et `Analysis` (statut, avancement, score, avertissements, jetons) → `AnalysisChunk` (un appel IA prévu, son état et son résultat) et `Issue` (catégorie, nature, gravité, confiance, localisation, extrait, suggestion, explication, emplacements liés, statut, empreinte unique).

## Représentation d'un document

`packages/shared/src/document-model.ts` : sections (arbre, chemin lisible), blocs dans l'ordre de lecture (titre, paragraphe, liste, cellule, légende, sommaire, note, en-tête, pied de page) avec phrases, page estimée et **ancre** vers les runs du XML d'origine — base du futur export `.docx` corrigé par modification ciblée du XML.

Écriture d'un `.docx` existant (utilisée par le service d'export : corrections et « Embellir ») : `docx/writer/rewrite-docx.ts`. Sans modification, les octets d'origine sont renvoyés tels quels. Sinon, seules les parties XML demandées sont réécrites (`docx/writer/xml-writer.ts`, relecture obligatoire de l'arbre produit) ; les autres entrées du paquet sont recopiées à l'identique, dans le même ordre et avec la même compression, puis l'archive produite est relue et vérifiée. Les paragraphes et runs à modifier sont retrouvés par le même parcours que la lecture (`docx/parser/parts.ts`), donc avec les mêmes numéros que les ancres du modèle. Commentaires XML, instructions de traitement, encodages autres que UTF-8 et archives dont deux entrées portent le même nom (à la casse près) sont refusés plutôt que perdus ou modifiés en silence.

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
- `components/upload` (import en deux temps), `components/analysis` (progression, échec), `components/results` (écran des résultats), `components/history`.
- Écran des résultats (`components/results/workbench.tsx`) : partie supérieure (`summary-band.tsx` : score, document, compteurs par nature — qui filtrent les points et ouvrent « Corriger » —, progression), puis quatre actions ; un panneau à la fois sous la rangée, aucun au chargement ; panneau (`?panneau=`), filtres et point ouvert gardés dans l'adresse ; panneaux fermés montés mais masqués (un export en cours n'est pas interrompu).
  - **Informations sur l'analyse** (`analysis-info-panel.tsx`) : avertissements (`AnalysisWarnings`, sortis de la partie supérieure), problèmes détectés par type et par catégorie, avec accès aux points.
  - **Corriger** : « Tout corriger », puis vérification point par point (filtres, liste, détail ; panneau du bas sur mobile). Accepter ne copie plus rien : action « Copier » séparée. Après une décision, le point suivant est sélectionné sans changer de panneau : si l'utilisateur en a ouvert un autre avant la réponse du serveur, il y reste.
  - **Mise en forme** (`formatting-panel.tsx`) : options de l'export et vérification de la structure, en séparant la présence (résumé `structure`) de la conformité (points relevés). Numérotation saisie des titres : « Contrôlé » (avec ou sans écart) si au moins un numéro est comparé au précédent du même niveau ou si un écart est relevé, « Non applicable » sinon (le premier numéro de chaque niveau n'est jamais contrôlé). Sommaire : « Non applicable » sans sommaire Word (un sommaire tapé à la main n'est pas reconnu), « Non vérifié » sans titre ou sans entrée comparable, « Contrôlé » sinon, numéros de page du sommaire jamais vérifiés. Styles de titre : « Non applicable » sans titre, « À revoir » si des titres sont déduits de leur apparence, « Contrôlé » sinon. Lecture simplifiée : « Non vérifié ». Structure inconnue : « Non déterminé ». Pagination : toujours « Non vérifiée » (numéros estimés, jamais recalculés). Contrôles par IA : « Non vérifié » sans IA ou si l'IA n'a pas abouti ; contrôles que seul Word peut faire listés à part.
  - **Télécharger les modifications** (`export-panel.tsx`) : voir « Document corrigé (export) ».
- `lib/api` (client typé, envoi avec progression), `lib/hooks` (suivi par interrogation, décisions optimistes), `lib/copy.ts` (textes validés).

## Évolutions préparées

- **Comptes** : `User.isGuest`, `email`, `role` ; garde de propriétaire déjà appliquée partout.
- **Autres fournisseurs IA** : nouvelle implémentation de `AiProvider`.
- **Suivi en temps réel** : l'écran d'analyse ne dépend que de `AnalysisDto` ; un flux SSE pourrait remplacer l'interrogation.
