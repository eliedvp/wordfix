# Décisions d'architecture — WordFix MVP

Ce fichier est la référence des décisions validées. Toute décision qui change ce qui est écrit ici doit être validée avant d'être implémentée, puis consignée ci-dessous.

Le dossier de conception complet (architecture, moteur d'analyse, traitement DOCX, UX, sécurité, tests, plan) a servi de base à ces décisions.

## Décisions validées (D1 à D11)

| ID  | Décision               | Choix                                                                                                       | Pourquoi                                                                                                                                                                                            |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Lecture du `.docx`     | Lecture ciblée du XML Word (ZIP lu de façon sûre, parseur XML sans entités externes) ; Mammoth en repli     | Mammoth ne garde ni lien vers le XML d'origine ni marques de pagination : sans ce lien, pas de localisation fine ni de futur `.docx` corrigé fidèle. Écart volontaire avec « ne parse pas le XML ». |
| D2  | Rôle de `docx`         | Générer les documents de test, plus tard un rapport de correction ; jamais réécrire le document utilisateur | `docx` crée des fichiers neufs et ne modifie pas un fichier existant.                                                                                                                               |
| D3  | Accès sans compte      | Cookie de session anonyme `httpOnly`, relié à un utilisateur invité en base                                 | Historique et protection des analyses exigés sans inscription. Les comptes reprendront l'utilisateur invité.                                                                                        |
| D4  | Un seul domaine        | Le navigateur n'appelle que le site ; `/api/*` est relayé vers NestJS                                       | Pas de CORS ouvert, cookie simple, API jamais exposée directement.                                                                                                                                  |
| D5  | Suivi de l'analyse     | Interrogation toutes les 2 s, arrêt automatique en fin d'analyse                                            | Simple et fiable derrière tout proxy.                                                                                                                                                               |
| D6  | Conservation           | Fichier : 24 h max. Texte extrait et résultats : 7 jours. Bouton « Supprimer maintenant »                   | Garder le minimum nécessaire pour finir la relecture.                                                                                                                                               |
| D7  | Langue                 | Français validé et testé ; autres langues sans garantie, avec avertissement                                 | Prompts, règles et corpus en français.                                                                                                                                                              |
| D8  | Limites                | 20 Mo · 60 000 mots · 3 analyses/h par session · 10/jour par IP · plafond de dépense IA quotidien           | Maîtrise du coût et de la charge. Valeurs configurables.                                                                                                                                            |
| D9  | Bouton « Accepter »    | Enregistre la décision et copie la correction ; le `.docx` n'est pas modifié, l'interface le dit            | Modification du fichier hors MVP.                                                                                                                                                                   |
| D10 | Organisation du code   | Monorepo pnpm + Turborepo ; un seul paquet `shared`                                                         | Types, constantes et codes d'erreur définis à un seul endroit.                                                                                                                                      |
| D11 | Bibliothèques ajoutées | zod, TanStack Query, nestjs-pino, Playwright, yauzl, fast-xml-parser, helmet, @nestjs/throttler             | Chacune répond à un besoin précis (schémas IA, suivi, logs, tests navigateur, D1, sécurité).                                                                                                        |

## Réponses validées (P1 à P5)

### P1 — Textes de confidentialité

Les seuls textes de confidentialité autorisés dans l'interface sont les cinq suivants. Chacun correspond à un mécanisme réellement implémenté, vérifié par un test automatisé avant d'être affiché.

| Texte affiché                                                                                                 | Mécanisme qui le garantit                                                          | Étape            |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------- |
| « Connexion chiffrée (HTTPS). »                                                                               | HTTPS obligatoire en production (reverse proxy, HSTS)                              | 14 / déploiement |
| « Votre fichier est supprimé au plus tard 24 h après l'import. »                                              | Purge horaire du stockage (`SOURCE_FILE_RETENTION_HOURS`)                          | 14               |
| « Le texte extrait et les résultats sont supprimés après 7 jours. Vous pouvez tout supprimer immédiatement. » | Purge des contenus (`CONTENT_RETENTION_DAYS`) + suppression manuelle               | 13 / 14          |
| « Vos analyses ne sont accessibles que depuis ce navigateur. Aucun lien public n'est créé. »                  | Session anonyme + vérification du propriétaire sur chaque requête ; stockage privé | 6                |
| « Pour l'analyse, le texte de votre document est envoyé à OpenAI. »                                           | Fait : l'analyse IA passe par l'API OpenAI                                         | 10               |

Règles associées :

- Aucune promesse marketing ou juridique non garantie techniquement (pas de « chiffrement de bout en bout », pas de « certifié », pas de mention réglementaire non vérifiée).
- Rien n'est affirmé sur ce qu'OpenAI conserve de son côté.
- **Les sauvegardes de la base sont conservées 7 jours maximum** (`BACKUP_RETENTION_DAYS`), pour que la promesse « supprimés après 7 jours » soit vraie aussi pour les sauvegardes.

### P2 — Hébergement

Choix de l'hébergement de production reporté. Développement local avec Docker Compose (PostgreSQL, Redis).

### P3 — Clé OpenAI

Fournie uniquement dans le `.env` local de chaque environnement. Jamais commitée, jamais dans le code, jamais dans les logs (masquage pino des champs `apiKey`, `token`, `password`).

### P4 — Fonctionnement Git

Une branche et une Pull Request par étape importante. Validation par le propriétaire du projet avant toute fusion dans `main`.

### P5 — Nom

« WordFix » est le nom de travail du MVP, utilisé dans le code et l'interface. Vérification du nom, du domaine et de la marque avant commercialisation.

## Choix techniques de l'étape 1

Versions choisies à l'installation (octobre 2026), avec la raison quand la version la plus récente n'a pas été prise.

| Sujet        | Choix                                                              | Raison                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| NestJS       | 12.x, en modules ES (ESM)                                          | Version stable actuelle ; NestJS 12 est publié en ESM uniquement. Conséquence : les imports relatifs de l'API portent l'extension `.js`.                                       |
| TypeScript   | 6.0.x (pas 7.0)                                                    | typescript-eslint et l'outillage de tests ne prennent pas encore en charge TypeScript 7.                                                                                       |
| Prisma       | 7.10 (pas 8.0)                                                     | La 8.0 n'est encore qu'en version candidate (`rc`). Prisma 7 se connecte via l'adaptateur `@prisma/adapter-pg`.                                                                |
| ESLint       | 10 pour l'API et `shared` ; 9 pour le site                         | Les plugins fournis par Next.js 16 (`eslint-config-next`) ne déclarent pas encore la compatibilité avec ESLint 10 ; c'est la version installée par le modèle officiel Next.js. |
| Polices      | Inter et Plus Jakarta Sans auto-hébergées (`@fontsource-variable`) | Aucune requête vers un service tiers, et un build qui fonctionne sans accès réseau.                                                                                            |
| API en local | Écoute sur `127.0.0.1:4000` par défaut                             | Conforme à D4 : seul le site est exposé.                                                                                                                                       |

## Décision à prendre avant l'étape 2

**D12 — Outil de tests unitaires et d'intégration.** Le cahier des charges cite Jest. NestJS 12 étant en ESM, Jest ne le prend en charge qu'en mode expérimental (`--experimental-vm-modules`), et le modèle officiel NestJS 12 utilise désormais Vitest, dont l'API est compatible avec celle de Jest (`describe`, `it`, `expect`, mocks).

- Option A (recommandée) : **Vitest** pour l'API, `shared` et le site ; Playwright pour les parcours navigateur.
- Option B : **Jest** en mode ESM expérimental, avec un risque de configuration fragile.
