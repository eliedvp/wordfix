# WordFix

Assistant de relecture intelligent pour documents Word longs (rapports de stage, mémoires, thèses, rapports professionnels). WordFix agit comme un **deuxième regard** : il signale ce qui mérite l'attention de l'auteur, en distinguant clairement les erreurs certaines, les suggestions et les points à vérifier.

> **État : MVP en construction — étape 1 (fondation technique).** Aucune fonctionnalité métier n'est encore disponible : l'import `.docx`, l'analyse et les résultats arrivent dans les étapes suivantes.

## Architecture

| Dossier              | Rôle                                  | Technologies                                      |
| -------------------- | ------------------------------------- | ------------------------------------------------- |
| `apps/web`           | Interface utilisateur                 | Next.js 16 (App Router), React 19, Tailwind CSS 4 |
| `apps/api`           | API REST, puis worker d'analyse       | NestJS 12 (ESM), Prisma 7, pino                   |
| `packages/shared`    | Constantes, types et schémas partagés | TypeScript                                        |
| `docker-compose.yml` | Infrastructure locale                 | PostgreSQL 17, Redis 7                            |

Le navigateur ne parle qu'au site : les appels `/api/*` sont relayés par Next.js vers l'API NestJS, qui n'écoute qu'en local (décision D4). Les décisions d'architecture validées sont dans [`docs/decisions.md`](docs/decisions.md).

## Prérequis

- **Node.js 22.12 ou plus récent** (voir `.nvmrc`)
- **pnpm 10** via Corepack : `corepack enable`
- **Docker** avec Docker Compose v2

## Démarrage

```bash
# 1. Installer les dépendances
corepack enable
pnpm install

# 2. Créer votre fichier de configuration local (jamais commité)
cp .env.example .env
#    puis changez au moins POSTGRES_PASSWORD (et DATABASE_URL en conséquence)

# 3. Démarrer PostgreSQL et Redis (attend qu'ils soient prêts)
pnpm infra:up

# 4. Vérifier la configuration Prisma et la connexion à la base
pnpm db:validate
pnpm db:check

# 5. Lancer le site et l'API en mode développement
pnpm dev
```

Puis ouvrez :

- le site : <http://localhost:3000>
- l'état de l'API, via le site : <http://localhost:3000/api/health>

## Commandes utiles

| Commande           | Effet                                                                           |
| ------------------ | ------------------------------------------------------------------------------- |
| `pnpm dev`         | Lance `shared` (compilation continue), l'API (port 4000) et le site (port 3000) |
| `pnpm build`       | Compile tous les paquets                                                        |
| `pnpm typecheck`   | Vérifie les types TypeScript (mode strict)                                      |
| `pnpm lint`        | ESLint sur tous les paquets                                                     |
| `pnpm format`      | Formate le code avec Prettier                                                   |
| `pnpm check`       | Types + lint + vérification du formatage (à lancer avant chaque PR)             |
| `pnpm infra:up`    | Démarre PostgreSQL et Redis et attend qu'ils soient sains                       |
| `pnpm infra:down`  | Arrête l'infrastructure (les données sont conservées dans les volumes)          |
| `pnpm db:validate` | Valide le schéma Prisma                                                         |
| `pnpm db:generate` | Génère le client Prisma (utile à partir de l'étape 5)                           |
| `pnpm db:check`    | Exécute `SELECT 1` sur la base configurée dans `DATABASE_URL`                   |

Pour lancer un seul paquet : `pnpm --filter @wordfix/api dev` ou `pnpm --filter @wordfix/web dev`.

## Configuration

Un seul fichier `.env`, à la racine, lu par Docker Compose, l'API et la CLI Prisma. Toutes les variables sont décrites dans [`.env.example`](.env.example).

- L'API **refuse de démarrer** si une variable obligatoire manque ou est invalide, avec un message qui la nomme.
- Les variables réelles de l'environnement sont prioritaires sur le fichier `.env` (utile en production).
- Aucune variable n'est exposée au navigateur. N'utilisez jamais le préfixe `NEXT_PUBLIC_` pour un secret.
- La clé OpenAI (à partir de l'étape 10) ne doit exister que dans votre `.env` local : jamais dans le code, un commit ou un log.

## Règles du projet

- Chaque étape du plan est développée sur sa propre branche et fusionnée dans `main` par Pull Request, après validation.
- Aucune fonctionnalité simulée : ce qui est affiché est réellement relié au backend, ou explicitement marqué comme non disponible.
- Les textes de confidentialité affichés dans l'interface correspondent strictement à ce que le système fait (voir `docs/decisions.md`, P1).
- Les logs ne contiennent jamais de texte de document, de cookie ni de clé.

## Dépannage

- **Le port 5432 ou 6379 est déjà pris** : changez `POSTGRES_PORT` / `REDIS_PORT` dans `.env`, et mettez à jour `DATABASE_URL` / `REDIS_URL`.
- **« Configuration invalide » au démarrage de l'API** : le message liste les variables à corriger dans `.env`.
- **`pnpm install` signale des scripts ignorés** : seuls les paquets listés dans `onlyBuiltDependencies` (`pnpm-workspace.yaml`) peuvent exécuter un script d'installation.
