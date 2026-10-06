# WordFix

Assistant de relecture pour documents Word longs (rapports de stage, mémoires, thèses, rapports professionnels). WordFix agit comme un **deuxième regard** : il signale ce qui mérite l'attention de l'auteur et distingue clairement les **erreurs**, les **suggestions**, les points **à examiner** et les points **à vérifier**. L'auteur garde toujours le dernier mot.

> **État : MVP complet, en attente de validation locale.** Pas encore déployé en production.

## Fonctionnement

```
Navigateur ──► Site Next.js ──/api/*──► API NestJS ──► PostgreSQL
                                           │  └─────► Stockage privé (disque / R2)
                                           ▼
                                     Redis (BullMQ)
                                           ▼
                                   Worker NestJS ──► OpenAI
```

1. **Import en deux temps** : le fichier est vérifié (structure, taille, sécurité), WordFix affiche son nombre de pages, puis l'utilisateur lance l'analyse.
2. **Analyse asynchrone** (worker) : lecture structurée du `.docx`, règles déterministes et orthographe française ([Language Engine](docs/language-engine.md), dictionnaire Grammalecte, sans appel réseau), relecture IA paragraphe par paragraphe, puis par section, puis cohérence du document entier, vérification des contradictions.
3. **Relecture** : chaque point est localisé (section, paragraphe, page estimée), expliqué, et peut être appliqué (copié), modifié, ignoré ou marqué comme vérifié.

| Dossier              | Rôle                                         | Technologies                         |
| -------------------- | -------------------------------------------- | ------------------------------------ |
| `apps/web`           | Interface                                    | Next.js 16, React 19, Tailwind CSS 4 |
| `apps/api`           | API REST (`main.ts`) et worker (`worker.ts`) | NestJS 12, Prisma 7, BullMQ, OpenAI  |
| `packages/shared`    | Types, constantes, erreurs, taxonomie        | TypeScript                           |
| `docker-compose.yml` | Infrastructure locale                        | PostgreSQL 17, Redis 7               |

Documentation : [décisions](docs/decisions.md) · [architecture](docs/architecture.md) · [sécurité](docs/security.md) · [tests](docs/testing.md) · [exploitation](docs/operations.md).

## Prérequis

- **Node.js 22.12 ou plus récent** (voir `.nvmrc`) et **pnpm 10** via Corepack : `corepack enable`
- **Docker** avec Docker Compose v2
- Une **clé API OpenAI** pour lancer de vraies analyses

## Démarrage

```bash
# 1. Dépendances
corepack enable
pnpm install

# 2. Configuration locale (jamais commitée)
cp .env.example .env
#    - changez POSTGRES_PASSWORD (et DATABASE_URL en conséquence)
#    - renseignez OPENAI_API_KEY

# 3. PostgreSQL et Redis (attend qu'ils soient prêts)
pnpm infra:up

# 4. Vérifier Prisma et créer les tables
pnpm db:validate
pnpm db:check
pnpm db:deploy

# 5. Site, API et worker en mode développement
pnpm dev
```

Ouvrez <http://localhost:3000> et cliquez sur « Essayer avec un rapport de stage d'exemple ». L'état de l'API est visible sur <http://localhost:3000/api/health>.

## Commandes

| Commande                                       | Effet                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm dev`                                     | `shared` en continu, API (port 4000), worker, site (port 3000)            |
| `pnpm build`                                   | Compile tous les paquets                                                  |
| `pnpm check`                                   | Types + lint + formatage (à lancer avant chaque PR)                       |
| `pnpm test`                                    | Tests unitaires (API, moteur, site)                                       |
| `pnpm test:integration`                        | API + file + worker + moteur contre PostgreSQL et Redis réels             |
| `pnpm test:e2e`                                | Parcours complets dans Chromium (après `pnpm build`, API arrêtée)         |
| `pnpm infra:up` / `pnpm infra:down`            | Démarre / arrête PostgreSQL et Redis                                      |
| `pnpm db:validate` / `db:check` / `db:deploy`  | Schéma Prisma, connexion à la base, application des migrations            |
| `pnpm db:migrate`                              | Crée une migration après une modification du schéma (développement)       |
| `pnpm --filter @wordfix/api fixtures:generate` | Écrit le corpus de test (13 types de documents) dans `apps/api/fixtures/` |
| `pnpm --filter @wordfix/api eval:quality`      | Mesure la qualité de l'IA réelle sur des fautes connues (stack démarrée)  |
| `pnpm --filter @wordfix/api sample:generate`   | Régénère le rapport d'exemple de la page d'accueil                        |

## Configuration

Un seul fichier `.env` à la racine, lu par Docker Compose, l'API, le worker et Prisma ; toutes les variables sont décrites dans [`.env.example`](.env.example).

- L'API et le worker **refusent de démarrer** si une variable est invalide, en la nommant.
- Les variables d'environnement réelles sont prioritaires sur `.env`.
- Aucun secret n'est exposé au navigateur ; la clé OpenAI n'est lue que par le worker.
- `API_INTERNAL_URL` (adresse de l'API vue par Next.js) est figée **au moment du build** du site.

## Règles du projet

- `main` est protégée : chaque étape passe par une branche et une Pull Request validée.
- Aucune fonctionnalité simulée : le fournisseur IA déterministe `fake` n'existe que pour les tests automatisés et est refusé hors `NODE_ENV=test`.
- Les textes de confidentialité affichés correspondent strictement au comportement du système ([P1](docs/decisions.md)).
- Les logs ne contiennent jamais de texte de document, de cookie ni de clé.

## Dépannage

- **Port 5432 ou 6379 déjà pris** : changez `POSTGRES_PORT` / `REDIS_PORT` dans `.env` et mettez à jour `DATABASE_URL` / `REDIS_URL`.
- **« Configuration invalide »** : le message liste les variables à corriger.
- **Le worker s'arrête avec « OPENAI_API_KEY est vide »** : renseignez la clé dans `.env`.
- **Les analyses restent « En attente »** : le worker n'est pas lancé (`pnpm dev` le démarre ; sinon `pnpm --filter @wordfix/api dev:worker`).
