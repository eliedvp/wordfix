# Déploiement — WordFix MVP

Ce document rassemble ce qu'il faut pour mettre WordFix en ligne. L'hébergeur n'est pas encore choisi : rien ici ne suppose un fournisseur particulier. Détails d'exploitation : [`operations.md`](operations.md) ; sécurité et checklist : [`security.md`](security.md).

> ⚠️ **Exigence bloquante avant la production : limite mémoire réelle de 1,5 Gio pour le service d'export, à configurer puis vérifier sur l'hébergement.** Elle n'est appliquée par rien dans ce dépôt (aucun Dockerfile ni configuration de déploiement). Les protections applicatives (surveillance du pic sous Linux, plafond du tas, délai) ne sont pas un plafond garanti. Procédure de vérification : [§ 5](#5-vérifications-obligatoires-avant-ouverture).

## 1. Services à faire tourner

| Service              | Commande (après `pnpm install --frozen-lockfile` et `pnpm build`)     | Exposé                               | Mémoire à prévoir                                                                       |
| -------------------- | --------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------- |
| Site (Next.js)       | `pnpm --filter @wordfix/web start` (port 3000)                        | Oui, derrière un reverse proxy HTTPS | quelques centaines de Mo (estimation, à mesurer)                                        |
| API (NestJS)         | `pnpm --filter @wordfix/api start` (port 4000, `API_HOST=127.0.0.1`)  | **Non**                              | quelques centaines de Mo (estimation, à mesurer)                                        |
| Worker d'analyse     | `pnpm --filter @wordfix/api start:worker`                             | Non                                  | **≈ 1,2 Go** (dictionnaire + Grammalecte) ; Python 3 ≥ 3.9 requis                       |
| Service d'export     | `pnpm --filter @wordfix/api start:export-worker`                      | Non                                  | **Conteneur dédié limité à 1,5 Gio** (un export à la fois, processus enfant par export) |
| PostgreSQL 17        | service géré ou conteneur                                             | Non                                  | selon l'hébergeur                                                                       |
| Redis 7              | service géré ou conteneur, `maxmemory-policy noeviction`              | Non                                  | faible (files et compteurs)                                                             |
| Stockage de fichiers | bucket S3 compatible privé (Cloudflare R2 prévu), `STORAGE_DRIVER=s3` | Non                                  | —                                                                                       |

- Node.js 22 sur toutes les machines applicatives ; Linux recommandé (la surveillance mémoire des exports lit `/proc`, absente sous Windows et macOS).
- Le site appelle l'API par `API_INTERNAL_URL`, **figé au moment de `pnpm build`** : à définir avant le build si l'API n'est pas sur `http://127.0.0.1:4000`.
- Le service d'export doit être **séparé du worker d'analyse** (processus et, en production, conteneur), pour qu'un export volumineux ne prive jamais l'analyse de mémoire.
- Ordre de démarrage conseillé : PostgreSQL et Redis → `pnpm db:deploy` (migrations) → API → worker → service d'export → site.

## 2. Variables d'environnement

Toutes sont validées au démarrage (`apps/api/src/config/env.schema.ts`) : une valeur invalide empêche le démarrage avec un message explicite. Modèle complet : `.env.example`. **Les secrets (marqués 🔒) ne doivent jamais apparaître dans le dépôt, les journaux ni le site** : le navigateur n'en reçoit aucun.

### Socle

| Variable                            | Défaut                  | Production                                                                      |
| ----------------------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| `NODE_ENV`                          | `development`           | `production`                                                                    |
| `API_HOST` / `API_PORT`             | `127.0.0.1` / `4000`    | API jamais exposée publiquement                                                 |
| `WEB_ORIGIN`                        | `http://localhost:3000` | domaine public exact (contrôle d'origine des requêtes)                          |
| `TRUST_PROXY`                       | `loopback`              | à ajuster selon le reverse proxy (adresse réelle des visiteurs pour les quotas) |
| `LOG_LEVEL`                         | `info`                  | `info` (aucun texte de document n'est journalisé)                               |
| `DATABASE_URL` 🔒                   | — (obligatoire)         | `postgresql://…`                                                                |
| `REDIS_URL` 🔒                      | — (obligatoire)         | `redis://…` ou `rediss://…`                                                     |
| `API_INTERNAL_URL` (site, au build) | `http://127.0.0.1:4000` | adresse interne de l'API                                                        |

### Stockage des fichiers

| Variable                                               | Défaut      | Production                |
| ------------------------------------------------------ | ----------- | ------------------------- |
| `STORAGE_DRIVER`                                       | `local`     | `s3`                      |
| `STORAGE_LOCAL_DIR`                                    | `./storage` | inutilisé avec `s3`       |
| `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET` | —           | bucket privé dédié        |
| `STORAGE_ACCESS_KEY` 🔒, `STORAGE_SECRET_KEY` 🔒       | —           | clés limitées à ce bucket |

### Limites et quotas

| Variable                        | Défaut   | Rôle                                                                                     |
| ------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `RATE_LIMIT_PER_MINUTE`         | `120`    | requêtes par minute et par adresse                                                       |
| `QUOTA_ANALYSES_PER_HOUR`       | `3`      | analyses par session et par heure                                                        |
| `QUOTA_ANALYSES_PER_IP_PER_DAY` | `10`     | analyses par adresse et par jour                                                         |
| `QUOTA_UPLOADS_PER_IP_PER_HOUR` | `20`     | imports par adresse et par heure                                                         |
| `QUOTA_EXPORTS_PER_HOUR`        | `10`     | demandes de document corrigé par session et par heure                                    |
| `WORKER_CONCURRENCY`            | `2`      | analyses simultanées par worker                                                          |
| `EXPORT_MEMORY_LIMIT_MB`        | `1280`   | surveillance applicative du pic mémoire d'un export (Linux) — **pas** un plafond garanti |
| `EXPORT_TIMEOUT_MS`             | `120000` | durée maximale d'un export                                                               |

### Moteur de langue et IA

| Variable                                                                                                                                                                               | Défaut              | Rôle                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GRAMMAR_ENGINE`                                                                                                                                                                       | `grammalecte`       | `off` pour désactiver la grammaire                                                                                                          |
| `GRAMMALECTE_PYTHON`                                                                                                                                                                   | `python3`           | interpréteur Python du worker                                                                                                               |
| `AI_PROVIDER`                                                                                                                                                                          | `none`              | `none` : aucune IA, aucun appel réseau ; `openai` / `gemini` : appels **payants** ; `fake` : tests uniquement (refusé hors `NODE_ENV=test`) |
| `AI_PAID_CALLS_ENABLED`                                                                                                                                                                | `false`             | doit valoir `true` pour `openai` / `gemini`                                                                                                 |
| `AI_DAILY_TOKEN_BUDGET`                                                                                                                                                                | `0`                 | `0` = aucun appel IA ; strictement positif exigé avec un fournisseur payant                                                                 |
| `OPENAI_API_KEY` 🔒, `GEMINI_API_KEY` 🔒                                                                                                                                               | —                   | seulement si le fournisseur correspondant est activé                                                                                        |
| `AI_MODEL_FAST`, `AI_MODEL_SMART`, `GEMINI_MODEL_FAST`, `GEMINI_MODEL_SMART`, `GEMINI_REQUESTS_PER_MINUTE`, `AI_REASONING_EFFORT`, `AI_TIMEOUT_MS`, `AI_MAX_RETRIES`, `AI_CONCURRENCY` | voir `.env.example` | réglages fins des appels IA                                                                                                                 |

**Configuration recommandée pour l'ouverture du MVP : `AI_PROVIDER=none`.** Toutes les fonctionnalités du MVP fonctionnent sans IA : analyse (orthographe, grammaire Grammalecte, règles), « Tout corriger », « Embellir » et document corrigé. L'activation d'un fournisseur payant est une décision séparée (budget, conditions d'utilisation, page Confidentialité).

## 3. Exigences d'hébergement

- **HTTPS obligatoire** devant le site, HSTS actif ; reverse proxy qui transmet `X-Forwarded-For` et limite le corps des requêtes à ~21 Mo (fichiers de 20 Mo au plus).
- API, PostgreSQL, Redis et stockage **jamais exposés sur Internet**.
- **Service d'export dans un conteneur limité à 1,5 Gio** (cgroup : `mem_limit` Docker, `resources.limits.memory: 1536Mi` Kubernetes, `MemoryMax=1536M` systemd). Au dépassement, le noyau arrête le processus enfant de l'export ; le service enregistre `EXPORT_TOO_LARGE` et continue.
- Worker d'analyse : ≈ 1,2 Go par instance, Python 3 ≥ 3.9 installé.
- Sauvegardes PostgreSQL quotidiennes, **conservées 7 jours au plus** ; le stockage des fichiers n'est pas sauvegardé (fichiers temporaires, 24 h).
- Horloge système synchronisée (expirations à 24 h et 7 jours).

## 4. Procédure de mise en ligne

1. Provisionner PostgreSQL 17, Redis 7 (`noeviction`), un bucket privé et ses clés.
2. Définir les variables (§ 2) dans le gestionnaire de secrets de l'hébergeur ; `API_INTERNAL_URL` avant le build.
3. `pnpm install --frozen-lockfile && pnpm build`.
4. `pnpm db:deploy` (migrations, dont `20261012100000_export_beautify`).
5. Démarrer API, worker, service d'export (conteneur limité à 1,5 Gio), puis le site.
6. Contrôler `GET /api/health` (200), les logs « Worker WordFix démarré », « Grammalecte prêt » et « Service d'export WordFix démarré », et l'absence du log « Surveillance mémoire des exports indisponible ».
7. Dérouler les vérifications du § 5, puis la checklist de [`security.md`](security.md#checklist-avant-mise-en-production).

## 5. Vérifications obligatoires avant ouverture

**Limite mémoire du service d'export (non vérifiable dans l'environnement de développement actuel) :**

1. `docker inspect --format '{{.HostConfig.Memory}}' <conteneur>` affiche `1610612736` (ou équivalent Kubernetes / systemd).
2. Dans le conteneur : `cat /sys/fs/cgroup/memory.max` (cgroup v2) ou `/sys/fs/cgroup/memory/memory.limit_in_bytes` (v1) affiche `1610612736`.
3. Arrêt par le noyau : relever temporairement `EXPORT_MEMORY_LIMIT_MB` au-dessus de 1 536, exporter un gros document de test non confidentiel, et vérifier que seul l'enfant est tué (log « Export arrêté (mémoire) » avec `killed`, service toujours actif, aucun `OOMKilled` du conteneur). Remettre ensuite `EXPORT_MEMORY_LIMIT_MB=1280`.
4. `docker kill` du service pendant un export : l'export reprend ou passe `FAILED`, sans doublon ni fichier orphelin.

**Parcours fonctionnel en production (document de test non confidentiel) :** import → analyse → « Tout corriger » puis annulation → « Embellir » (les deux options) → génération → téléchargement d'un fichier « (corrigé).docx » distinct de l'original, ouvert dans Word ; suppression du document depuis « Mes documents ».

**Mesures de référence (développement, Linux) :** document de 59 000 mots et 1 478 corrections : export en 18 s (24 s avec « Embellir »), pic mémoire de l'enfant inférieur à 700 Mo. À confirmer sur l'hébergement choisi.

## 6. Ce que ce dépôt ne fournit pas encore

- Aucun Dockerfile, manifeste Kubernetes ni configuration d'hébergeur : à écrire une fois l'hébergeur choisi, puis à vérifier avec le § 5.
- Aucune supervision externe (alertes) : les logs JSON et `GET /api/health` sont prêts à être branchés.
