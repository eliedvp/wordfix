# Exploitation — WordFix

L'hébergement de production n'est pas encore choisi (P2). Ce document liste ce dont WordFix a besoin, quel que soit l'hébergeur.

## Processus à faire tourner

| Processus                             | Commande (après `pnpm install --frozen-lockfile` et `pnpm build`)    | Exposé                               |
| ------------------------------------- | -------------------------------------------------------------------- | ------------------------------------ |
| Site                                  | `pnpm --filter @wordfix/web start` (port 3000)                       | Oui, derrière le reverse proxy HTTPS |
| API                                   | `pnpm --filter @wordfix/api start` (port 4000, `API_HOST=127.0.0.1`) | Non                                  |
| Worker                                | `pnpm --filter @wordfix/api start:worker`                            | Non                                  |
| PostgreSQL 17, Redis 7 (`noeviction`) | services gérés ou conteneurs                                         | Non                                  |

- `API_INTERNAL_URL` doit être défini **avant** `pnpm build` si l'API n'est pas sur `http://127.0.0.1:4000`.
- Plusieurs workers peuvent tourner en parallèle (BullMQ répartit les jobs ; la purge horaire n'est planifiée qu'une fois).
- **Mémoire du worker** : le dictionnaire orthographique français est chargé au démarrage (≈ 5 s, ≈ 300 Mo de tas, RSS ≈ 700 à 800 Mo en charge). `start:worker` fixe `--max-old-space-size=1024`. L'API n'est pas concernée. Détail : [`language-engine.md`](language-engine.md#mémoire-et-chargement).
- **Python 3 (≥ 3.9) sur la machine du worker** : la vérification grammaticale (Grammalecte) tourne dans un processus Python lancé par chaque worker (≈ 80 Mo au démarrage, ≈ 310 Mo après un gros document). Aucune bibliothèque à installer ; interpréteur réglable par `GRAMMALECTE_PYTHON`, désactivation possible par `GRAMMAR_ENGINE=off`. Avec l'orthographe, prévoir **≈ 1,2 Go par worker**. Sans Python, le worker démarre et journalise « Grammalecte indisponible » : les analyses se font alors sans grammaire. Détail : [`language-engine.md`](language-engine.md#grammaire--grammaranalyzer-grammalecte).

## Mise à jour

1. `pnpm install --frozen-lockfile && pnpm build`
2. `pnpm db:deploy` (migrations)
3. Redémarrer API, worker puis site. Un worker arrêté pendant une analyse la reprend au redémarrage, sans refaire les morceaux terminés.

## Surveillance

- `GET /api/health` : 200 si PostgreSQL et Redis répondent, 503 sinon.
- Logs JSON (pino) : chaque requête porte `requestId` ; le worker journalise `analysisId`, étape, durée et jetons de chaque appel IA. Aucun texte de document.
- Consommation IA : colonnes `tokensIn` / `tokensOut` de chaque analyse ; plafond quotidien `AI_DAILY_TOKEN_BUDGET`.
- Log « Nettoyage terminé » toutes les heures (purge).
- Au démarrage du worker : log « Grammalecte prêt » (version, durée de chargement). Une alerte sur « Grammalecte indisponible » ou « Vérification grammaticale impossible » signale des analyses sans grammaire.

## Sauvegardes

Sauvegarde quotidienne de PostgreSQL, **conservée 7 jours au maximum** (décision P1). Redis ne contient que des files et compteurs : pas de sauvegarde nécessaire. Le stockage des fichiers n'est pas sauvegardé (fichiers temporaires, 24 h).

Voir aussi la checklist de mise en production dans [`security.md`](security.md).
