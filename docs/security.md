# Sécurité et confidentialité — WordFix MVP

Les documents importés sont des données privées. Ce document décrit les protections réellement en place, le cycle de vie des fichiers et la checklist à valider avant la mise en production.

## Protections en place

| Risque                                      | Protection                                                                                                                                                                                                                                                                                                                                   | Où                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Fichier malveillant (macros, contenu actif) | Aucun code du document n'est exécuté : seul le XML est lu. `.docm` et `vbaProject.bin` refusés. Liens externes jamais suivis, images non décompressées.                                                                                                                                                                                      | `docx/docx-validator.ts`, `docx/package-reader.ts` |
| Bombe ZIP                                   | Répertoire lu avant décompression ; 2 000 entrées, 100 Mo décompressés, taux de compression borné, chaque lecture plafonnée (30 Mo pour le corps).                                                                                                                                                                                           | `docx/zip-reader.ts`                               |
| XML piégé (XXE, expansion d'entités)        | Tout XML contenant `<!DOCTYPE` ou `<!ENTITY` est refusé avant analyse.                                                                                                                                                                                                                                                                       | `docx/parser/xml.ts`                               |
| Fichier corrompu, vide, trop long           | Codes `CORRUPTED_FILE`, `EMPTY_DOCUMENT`, `DOCUMENT_TOO_LONG`, sans détail technique pour l'utilisateur.                                                                                                                                                                                                                                     | validateur + catalogue d'erreurs                   |
| Fichier trop volumineux                     | Refus dans le navigateur, puis coupure de l'envoi à 20 Mo par Multer (le fichier n'est jamais lu en entier). Prévoir aussi la limite au reverse proxy.                                                                                                                                                                                       | `documents.controller.ts`                          |
| Extension ou type falsifiés                 | Signature binaire (ZIP / OLE), types de contenu Word, partie principale ; `.doc` et `.docx` chiffré reconnus. Le type MIME du navigateur est ignoré.                                                                                                                                                                                         | validateur                                         |
| Path traversal                              | Clé de stockage générée `documents/{id}/source.docx` ; le nom d'origine n'est qu'affiché, nettoyé (200 caractères, sans dossier ni caractère de contrôle).                                                                                                                                                                                   | `storage/file-storage.ts`, `common/filename.ts`    |
| Injection SQL                               | Requêtes Prisma paramétrées uniquement.                                                                                                                                                                                                                                                                                                      | —                                                  |
| Injection de prompt                         | Texte encadré comme donnée, balises neutralisées, modèle sans outil, sortie JSON validée, extraits vérifiés dans le texte réel, nature décidée par le backend.                                                                                                                                                                               | `engine/`                                          |
| XSS                                         | Contenu et sorties IA affichés comme texte par React ; aucun `dangerouslySetInnerHTML` ; CSP stricte (`default-src 'self'`).                                                                                                                                                                                                                 | `apps/web`                                         |
| CSRF                                        | Cookie `SameSite=Lax` ; toute requête qui modifie des données doit venir de `WEB_ORIGIN` (en-têtes `Origin` et `Sec-Fetch-Site` contrôlés).                                                                                                                                                                                                  | `security/origin.guard.ts`                         |
| Abus, coût IA                               | Limiteur global (120 requêtes/min/IP, stockage Redis) ; 20 imports/h/IP ; 3 analyses/h/session ; 10 analyses/jour/IP ; plafond quotidien de jetons IA. Aucun appel IA payant par défaut (`AI_PROVIDER=none`) ; `openai`/`gemini` exigent `AI_PAID_CALLS_ENABLED=true` et `AI_DAILY_TOKEN_BUDGET` > 0 ; un budget à 0 interdit tout appel IA. | `security/`, `ai/usage.service.ts`                 |
| Accès non autorisé                          | Identifiants aléatoires (≈103 bits) ; propriétaire vérifié à chaque requête ; ressource d'une autre session → 404.                                                                                                                                                                                                                           | services documents / analyses / issues             |
| Exposition de fichiers                      | Stockage privé, aucune URL publique ni signée.                                                                                                                                                                                                                                                                                               | `storage/`                                         |
| Fuite de clés                               | Secrets uniquement dans les variables d'environnement du backend ; aucune variable `NEXT_PUBLIC_` ; `.env` ignoré par Git ; les clés OpenAI et Gemini : lues par le worker.                                                                                                                                                                  | `.gitignore`, `ai/ai.module.ts`                    |
| Composant tiers (Grammalecte, Python)       | Processus séparé, lancé en mode isolé (`-I`) avec un environnement minimal : aucun secret du worker transmis. Aucun accès réseau, aucun fichier écrit, texte jamais journalisé.                                                                                                                                                              | `engine/language/grammar/`                         |
| Fuite par les logs                          | Masquage des cookies, en-têtes d'autorisation, champs `apiKey`/`token`/`password` ; aucun texte de document ni prompt journalisé.                                                                                                                                                                                                            | `config/logger.config.ts`                          |
| Mise en cache                               | `Cache-Control: no-store` sur toutes les réponses de l'API.                                                                                                                                                                                                                                                                                  | `app.setup.ts`                                     |
| En-têtes HTTP                               | API : Helmet. Site : CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS en production.                                                                                                                                                                                                                   | `app.setup.ts`, `next.config.ts`                   |

## Cycle de vie d'un document

| Étape                     | Ce qui existe                                                                                                                                          | Durée maximale     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| Envoi                     | Fichier en mémoire dans l'API, validé avant toute écriture                                                                                             | quelques secondes  |
| Stockage                  | `source.docx` dans le stockage privé                                                                                                                   | 24 h               |
| Analyse                   | Fichier lu en mémoire par le worker ; sans IA (`none`, par défaut) rien n'est envoyé à l'extérieur ; avec `openai`, texte envoyé à OpenAI par morceaux | durée de l'analyse |
| Résultats                 | Structure extraite + problèmes en base                                                                                                                 | 7 jours            |
| Purge (toutes les heures) | Fichier supprimé à 24 h ; document, texte, analyses et résultats supprimés à 7 jours                                                                   | —                  |
| Suppression manuelle      | « Supprimer » : fichier, texte et résultats effacés immédiatement                                                                                      | immédiat           |

La purge est un job BullMQ planifié (`maintenance`) exécuté par le worker (`maintenance/cleanup.service.ts`). Elle marque aussi en échec les analyses restées actives plus de 2 h (job perdu) et oublie les sessions invitées sans document inactives depuis 30 jours.

## Session et futurs comptes

- Cookie `wf_sid` : 32 octets aléatoires, `httpOnly`, `SameSite=Lax`, `Secure` en production, 30 jours. Seule l'empreinte SHA-256 est stockée.
- Le modèle `User` prévoit `email`, `isGuest` et `role` : l'inscription transformera l'invité en compte sans perdre son historique.
- À ajouter avec les comptes : mots de passe Argon2id (ou lien magique), limitation des tentatives de connexion, rotation du jeton à la connexion, vérification de l'e-mail, suppression du compte et de toutes ses données.

## Exigences de déploiement

- **HTTPS obligatoire** devant le site (le texte « Connexion chiffrée (HTTPS) » en dépend).
- Un **reverse proxy** devant Next.js doit ajouter `X-Forwarded-For` : sans lui, toutes les requêtes semblent venir de la même adresse et les quotas par IP deviennent globaux. Ajuster `TRUST_PROXY` si l'API n'est pas joignable seulement depuis la même machine.
- L'API (port 4000) ne doit jamais être exposée publiquement : seul Next.js l'appelle.
- **Sauvegardes de la base conservées 7 jours au maximum** (décision P1).
- PostgreSQL et Redis non exposés sur Internet ; Redis en `maxmemory-policy noeviction`.
- Bucket R2 privé, clés d'accès limitées à ce bucket.

## Checklist avant mise en production

- [ ] HTTPS partout, HSTS actif, reverse proxy qui ajoute `X-Forwarded-For` et limite le corps des requêtes à ~21 Mo
- [ ] `NODE_ENV=production`, `WEB_ORIGIN` égal au domaine public
- [ ] Aucun secret dans le dépôt ni dans le bundle du navigateur (`grep` du build `.next/static`)
- [ ] Clé OpenAI de production distincte, plafond de dépense configuré chez OpenAI, `AI_DAILY_TOKEN_BUDGET` ajusté
- [ ] Modèles `AI_MODEL_FAST` / `AI_MODEL_SMART` validés sur le corpus de test (script d'évaluation)
- [ ] PostgreSQL et Redis non exposés, mots de passe forts, Redis `noeviction`
- [ ] Bucket privé, `STORAGE_DRIVER=s3`, accès limité au bucket
- [ ] Sauvegardes PostgreSQL configurées, conservées 7 jours au plus, restauration testée
- [ ] Worker démarré avec la purge horaire (vérifier le log « Nettoyage terminé »)
- [ ] Tests unitaires, d'intégration et E2E verts en CI
- [ ] `pnpm audit` sans vulnérabilité haute ou critique
- [ ] Logs relus : aucun texte de document, cookie ou clé
- [ ] Conditions d'utilisation de l'API OpenAI relues ; page Confidentialité conforme à la configuration réelle
