# Exploitation — WordFix

L'hébergement de production n'est pas encore choisi (P2). Ce document liste ce dont WordFix a besoin, quel que soit l'hébergeur.

## Processus à faire tourner

| Processus                             | Commande (après `pnpm install --frozen-lockfile` et `pnpm build`)    | Exposé                               |
| ------------------------------------- | -------------------------------------------------------------------- | ------------------------------------ |
| Site                                  | `pnpm --filter @wordfix/web start` (port 3000)                       | Oui, derrière le reverse proxy HTTPS |
| API                                   | `pnpm --filter @wordfix/api start` (port 4000, `API_HOST=127.0.0.1`) | Non                                  |
| Worker                                | `pnpm --filter @wordfix/api start:worker`                            | Non                                  |
| Service d'export                      | `pnpm --filter @wordfix/api start:export-worker`                     | Non                                  |
| PostgreSQL 17, Redis 7 (`noeviction`) | services gérés ou conteneurs                                         | Non                                  |

- `API_INTERNAL_URL` doit être défini **avant** `pnpm build` si l'API n'est pas sur `http://127.0.0.1:4000`.
- Plusieurs workers peuvent tourner en parallèle (BullMQ répartit les jobs ; la purge horaire n'est planifiée qu'une fois).
- **Mémoire du worker** : le dictionnaire orthographique français est chargé au démarrage (≈ 5 s, ≈ 300 Mo de tas, RSS ≈ 700 à 800 Mo en charge). `start:worker` fixe `--max-old-space-size=1024`. L'API n'est pas concernée. Détail : [`language-engine.md`](language-engine.md#mémoire-et-chargement).
- **Python 3 (≥ 3.9) sur la machine du worker** : la vérification grammaticale (Grammalecte) tourne dans un processus Python lancé par chaque worker (≈ 80 Mo au démarrage, ≈ 310 Mo après un gros document). Aucune bibliothèque à installer ; interpréteur réglable par `GRAMMALECTE_PYTHON`, désactivation possible par `GRAMMAR_ENGINE=off`. Avec l'orthographe, prévoir **≈ 1,2 Go par worker**. Sans Python, le worker démarre et journalise « Grammalecte indisponible » : les analyses se font alors sans grammaire. Détail : [`language-engine.md`](language-engine.md#grammaire--grammaranalyzer-grammalecte).

### Service d'export : mémoire et limites

Le service d'export (documents corrigés) est un processus **séparé du worker d'analyse** ; en production, il doit tourner dans **son propre conteneur** (ou sa propre unité systemd). Il ne traite qu'un export à la fois, chacun dans un processus enfant éphémère.

| Protection                                                                                                           | Valeur                                            | Ce qu'elle garantit                                                                                                                                                                                                      | Limites                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Limite mémoire de l'environnement** (cgroup : `mem_limit` Docker, `limits.memory` Kubernetes, `MemoryMax` systemd) | **1,5 Gio** pour le conteneur du service d'export | Seul plafond réel de toute la mémoire (tas JavaScript, Buffers, zlib). Au dépassement, le noyau arrête le plus gros processus du conteneur, en pratique l'enfant de l'export ; le service enregistre `EXPORT_TOO_LARGE`. | **À configurer et vérifier sur l'hébergement avant la mise en production** (non vérifiable dans l'environnement de développement actuel, sans démon Docker ni systemd). Si le parent est tué à la place de l'enfant, l'export est repris par BullMQ (verrou de 180 s) ou passe `FAILED` à la récupération (15 min). |
| Surveillance applicative (`EXPORT_MEMORY_LIMIT_MB`)                                                                  | 1 280 Mo de mémoire résidente                     | L'enfant est arrêté (SIGKILL) au-delà ; l'export passe `FAILED` (`EXPORT_TOO_LARGE`).                                                                                                                                    | Linux uniquement (`/proc`) ; mesure toutes les 200 ms : un pic plus bref peut passer. Ce n'est pas un plafond garanti.                                                                                                                                                                                              |
| Plafond du tas de l'enfant                                                                                           | `--max-old-space-size=1024`                       | Échec net si le tas JavaScript déborde (`EXPORT_TOO_LARGE`).                                                                                                                                                             | Ne compte pas les Buffers ni la mémoire native.                                                                                                                                                                                                                                                                     |
| Délai (`EXPORT_TIMEOUT_MS`)                                                                                          | 120 s                                             | L'enfant est arrêté au-delà (`EXPORT_TIMEOUT`).                                                                                                                                                                          | —                                                                                                                                                                                                                                                                                                                   |
| Récupération                                                                                                         | 15 min                                            | Un export bloqué (service arrêté, job perdu) passe `FAILED` au redémarrage du service, puis toutes les 5 min, et à la purge horaire.                                                                                     | —                                                                                                                                                                                                                                                                                                                   |

**Arrêts et reprise.** Enfant arrêté (mémoire, délai, noyau, plantage) : résultat enregistré aussitôt, le service continue. Service d'export arrêté pendant un export : l'enfant se termine dès que le canal avec le parent se ferme (il ne peut pas être interrompu au milieu d'une étape de calcul synchrone, mais son travail reste borné) ; BullMQ relance l'export après expiration du verrou (180 s, plus long que le délai de 120 s) sur la même ligne et la même clé de fichier, sans doublon ; sinon la récupération le passe `FAILED` (15 min ; au plus 1 h par la purge horaire si le service d'export reste arrêté). Aucun export ne reste `QUEUED` ou `RUNNING` indéfiniment.

**À vérifier sur l'hébergement avant la mise en production** (rien dans le dépôt n'impose encore la limite de 1,5 Gio : pas de Dockerfile ni de configuration de déploiement ; `docker-compose.yml` ne décrit que PostgreSQL et Redis) :

1. Conteneur dédié au service d'export avec une limite mémoire de 1,5 Gio : `docker inspect --format '{{.HostConfig.Memory}}' <conteneur>` doit afficher `1610612736` (ou équivalent Kubernetes `resources.limits.memory: 1536Mi`, systemd `MemoryMax=1536M`).
2. Dans le conteneur : `cat /sys/fs/cgroup/memory.max` (cgroup v2) ou `/sys/fs/cgroup/memory/memory.limit_in_bytes` (v1) affiche `1610612736`.
3. `/proc` disponible (surveillance) : aucun log « Surveillance mémoire des exports indisponible » au démarrage.
4. Arrêt par le noyau : provoquer un dépassement (par exemple `EXPORT_MEMORY_LIMIT_MB` relevé au-dessus de la limite du conteneur, sur un gros document de test non confidentiel) et vérifier que seul l'enfant est tué (`dmesg` ou événement `OOMKilled` du conteneur absent, log « Export arrêté (mémoire) » avec `killed`, service toujours actif).
5. Arrêt du service pendant un export (`docker kill`) : l'export reprend ou passe `FAILED`, sans export ni fichier en double.

L'enfant ne reçoit aucune variable d'environnement (ni secret, ni `NODE_OPTIONS`, qui pourrait changer ses limites). Mesures de référence : 0,6 à 0,8 Go de pic pour un vrai document de 46 600 mots, environ 0,2 Go pour les documents courants. Un `worker_thread` n'est pas utilisé : sa limite ne porte que sur le tas JavaScript et il partage la mémoire du processus.

## Mise à jour

1. `pnpm install --frozen-lockfile && pnpm build`
2. `pnpm db:deploy` (migrations)
3. Redémarrer API, worker puis site. Un worker arrêté pendant une analyse la reprend au redémarrage, sans refaire les morceaux terminés.

## Surveillance

- `GET /api/health` : 200 si PostgreSQL et Redis répondent, 503 sinon.
- Logs JSON (pino) : chaque requête porte `requestId` ; le worker journalise `analysisId`, étape, durée et jetons de chaque appel IA. Aucun texte de document.
- Mode IA : journalisé au démarrage du worker (« Mode IA : … ») et exposé sans secret par `GET /api/ai-mode`. Par défaut `none` : aucune IA, analyses marquées `AI_DISABLED`.
- Consommation IA : colonnes `tokensIn` / `tokensOut` de chaque analyse ; plafond quotidien `AI_DAILY_TOKEN_BUDGET` (0 = aucun appel IA autorisé, jamais « illimité »).
- Log « Nettoyage terminé » toutes les heures (purge), avec `exportsDeleted` et `staleExports`.
- Service d'export : « Document corrigé prêt », « Aucune correction applicable », « Export arrêté (mémoire) » (avec la cause : `memory`, `heap`, `killed`), « Export arrêté (délai dépassé) », « Export en échec » (code de problème). Uniquement identifiants, nombres, durées et codes : aucun texte de document. Une hausse de « Export arrêté (mémoire) » avec `killed` signale la limite du conteneur.
- Au démarrage du worker : log « Grammalecte prêt » (version, durée de chargement). Une alerte sur « Grammalecte indisponible » ou « Vérification grammaticale impossible » signale des analyses sans grammaire.

## Sauvegardes

Sauvegarde quotidienne de PostgreSQL, **conservée 7 jours au maximum** (décision P1). Redis ne contient que des files et compteurs : pas de sauvegarde nécessaire. Le stockage des fichiers n'est pas sauvegardé (fichiers temporaires, 24 h).

Voir aussi la checklist de mise en production dans [`security.md`](security.md).
