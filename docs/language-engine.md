# WordFix Language Engine

Le Language Engine est la partie **déterministe** de l'analyse linguistique de WordFix. Il relit le document extrait, paragraphe par paragraphe, et signale les problèmes qu'un programme détecte avec certitude, sans appel réseau ni IA. La grammaire est confiée à [Grammalecte](https://grammalecte.net), exécuté localement dans le worker (voir [Grammaire](#grammaire--grammaranalyzer-grammalecte)). Il est la fondation du futur correcteur français : de nouveaux analyseurs s'y ajouteront progressivement.

Code : `apps/api/src/engine/language/`.

## Place dans le pipeline

```
.docx → extraction (docx/parser) → DocumentModel
                                      │
        planification de l'analyse ───┤
                                      ├─► runRules() ─► Language Engine (langue)
                                      │              └► règles du document (numérotation, sommaire, sigles, graphies)
                                      │
                                      └─► étapes IA : locale → contextuelle → globale → vérification
                                                      │
               problèmes candidats (CandidateIssue) ◄─┘
                     │
                     ▼
     materialize : ancrage, nature décidée par le backend, formulation prudente, localisation
                     ▼
     Prisma (Issue) → finalisation : doublons entre étapes, plafond, score → API → Review Workbench
```

- Le moteur tourne pendant la planification : ses résultats sont enregistrés immédiatement, avant les appels IA.
- Juste avant, la planification fait vérifier la grammaire de tout le document par Grammalecte (processus Python unique du worker, lots de paragraphes) ; les erreurs obtenues sont transmises au moteur, qui reste synchrone. Si Grammalecte est désactivé ou indisponible, l'analyse continue sans vérification grammaticale.
- Ses problèmes ont la source `rules` (déterministe) ; `local`, `context`, `global` et `verify` désignent l'IA.
- Quand une règle et l'IA signalent le même endroit (même paragraphe, positions qui se chevauchent, même famille de problème), la finalisation n'en garde qu'un, le plus sûr ; à égalité, celui de la règle.
- Le moteur ne dépend d'aucun fournisseur d'IA : il fonctionne de la même façon avec OpenAI, Gemini (`AI_PROVIDER=gemini`) ou `AI_PROVIDER=fake`.

## Déterministe ou IA

|                   | Language Engine (déterministe)                                                             | Analyse IA                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Problèmes visés   | Ce qu'une règle détecte avec certitude : mot doublé, espace mal placée, phrase très longue | Ce qui demande du contexte ou du sens : accords ambigus, formulations, cohérence, contradictions |
| Coût, réseau      | Gratuit, local, instantané                                                                 | Appels OpenAI payants                                                                            |
| Reproductibilité  | Même document, mêmes résultats                                                             | Variable selon le modèle                                                                         |
| Règle de prudence | Un cas douteux n'est pas signalé                                                           | La nature est bornée par le backend                                                              |

Dans les deux cas, **la nature** (Erreur, Suggestion, À examiner, À vérifier) est décidée par le backend (`postprocess/nature-policy.ts`) à partir de la catégorie, de la confiance et de la présence d'une correction, jamais par l'analyseur lui-même.

## Analyseurs disponibles

| Analyseur            | Règle                       | Exemple                            | Catégorie / sous-type                                   | Confiance → nature                                                    |
| -------------------- | --------------------------- | ---------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| `RepetitionAnalyzer` | `repeated_word`             | « permet permet » → « permet »     | spelling / typo                                         | élevée + correction → Erreur                                          |
| `SpellingAnalyzer`   | `misspelling`               | « Informatiue » → « Informatique » | spelling / misspelling                                  | élevée → Erreur ; moyenne → Suggestion ; faible → rien                |
| `GrammarAnalyzer`    | `grammar`                   | « Les serveur » → « serveurs »     | grammar / gender_number, agreement, conjugation, syntax | élevée → Erreur ; moyenne → Suggestion ; sans correction → À vérifier |
| `TypographyAnalyzer` | `double_space`              | deux espaces entre deux mots       | punctuation / spacing                                   | élevée, sans correction → Suggestion                                  |
|                      | `space_before_punctuation`  | « serveur , » → « serveur, »       | punctuation / spacing                                   | élevée + correction → Erreur                                          |
|                      | `doubled_punctuation`       | « ,, » → « , »                     | punctuation / punctuation                               | élevée + correction → Erreur                                          |
|                      | `missing_space_after_comma` | « rouge,vert » → « rouge, vert »   | punctuation / spacing                                   | élevée + correction → Erreur                                          |
| `SentenceAnalyzer`   | `long_sentence`             | phrase de plus de 45 mots          | style / too_long                                        | moyenne → Suggestion                                                  |

### Langue des passages (detection.ts)

Un mémoire peut contenir un résumé, des citations ou des paragraphes en anglais. Chaque phrase reçoit une langue — `fr`, `en` ou `uncertain` — par une détection **locale, déterministe et linéaire** (aucun modèle, aucun réseau) :

1. indices forts : mots-outils propres à chaque langue (« les », « dans », « dont » / « the », « which », « were »), élisions françaises (« l’ », « qu’ »), contractions anglaises (« it’s », « don’t »), lettres accentuées (indice plus faible) ;
2. passage sans mots-outils (titre, mots-clés) : mots connus d'un seul des deux dictionnaires ;
3. une langue l'emporte si ses indices valent au moins le double de ceux de l'autre (2 indices minimum) ; sinon `uncertain`. Une phrase trop courte prend la langue de son paragraphe, puis celle du document (français par défaut).

| Langue      | Orthographe                                                                                                                                                                                                  | Grammalecte | Confusions d'accents |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | -------------------- |
| `fr`        | inchangée                                                                                                                                                                                                    | oui         | oui                  |
| `en`        | pas de dictionnaire français ; faute anglaise signalée seulement si **une seule** correction exacte du dictionnaire anglais est à une modification près, en **Suggestion** ; graphies britanniques acceptées | non         | non                  |
| `uncertain` | un mot anglais connu n'est jamais signalé ; aucune faute française n'est classée Erreur ; aucun cas confié à l'IA                                                                                            | oui         | non                  |

La typographie (espaces, ponctuation doublée), les répétitions et les phrases longues ne dépendent pas de la langue. Réglages : `language` dans `config.ts`.

### Garde-fous contre les faux positifs

- Titres, entrées de sommaire, en-têtes et pieds de page ne sont pas analysés.
- URL, adresses e-mail, chemins, noms de fichiers et identifiants techniques (`Node.js`, `config.json`, `src/app`) sont protégés.
- Répétitions : seulement deux mots identiques séparés par des espaces. Exceptions « nous nous » et « vous vous ». Ni répétition à travers une ponctuation (« oui, oui »), ni mots de même famille (« il permet de permettre »).
- Typographie : nombres (« 3,5 »), variables d'une lettre (« x,y ») et code (« f(a,b) ») exclus. Un signalement n'est émis que si le texte est continu dans le fichier Word : une image, un appel de note ou un champ invisible entre deux caractères suffit à l'annuler. L'espace avant la ponctuation n'est pas contrôlée dans un document contenant des équations (absentes du texte extrait).
- Phrases longues : énumérations (points-virgules) et phrases surtout numériques ignorées.
- Un même endroit n'est signalé qu'une fois ; chaque règle est plafonnée par document.

Non traité volontairement à ce stade : mots composés mal orthographiés, espaces avant « ; : ! ? » (conventions différentes selon les pays), guillemets et apostrophes.

## Orthographe : SpellingAnalyzer

Le `SpellingAnalyzer` signale les mots absents du dictionnaire français et propose une correction **seulement quand elle se détache nettement**. Aucune faute n'est inscrite dans le code : tout vient du dictionnaire général.

### Dictionnaires

| Paquet                                                                                        | Version | Rôle                                                                                                              | Licence                                                         |
| --------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [`nspell`](https://github.com/wooorm/nspell)                                                  | 2.1.5   | Moteur Hunspell en JavaScript (vérification, suggestions)                                                         | MIT (dépendance `is-buffer` : MIT)                              |
| [`dictionary-fr`](https://github.com/wooorm/dictionaries/tree/main/dictionaries/fr)           | 3.0.0   | Dictionnaire français « classique » v7.5 de [Grammalecte](https://grammalecte.net/) (Olivier R. et contributeurs) | Fichiers du dictionnaire : **MPL-2.0** ; code d'emballage : MIT |
| [`dictionary-en`](https://github.com/wooorm/dictionaries/tree/main/dictionaries/en)           | 4.0.0   | Formes anglaises (SCOWL, préfixes et suffixes Hunspell développés), pour les anglicismes et les passages anglais  | MIT AND BSD ; code d'emballage : MIT                            |
| `@types/nspell` (développement)                                                               | 2.1.6   | Types TypeScript                                                                                                  | MIT                                                             |
| [wordfreq](https://github.com/rspeer/wordfreq) (données, dans `apps/api/vendor/wordfreq-fr/`) | 3.1.1   | Fréquence d'usage de 122 589 mots français, pour classer les corrections                                          | Données : **CC BY-SA 4.0** (adaptation sous la même licence)    |

Les fichiers de dictionnaire sont installés par npm avec l'application : **aucun fichier de dictionnaire n'est copié dans le dépôt** et aucun n'est modifié. Seule la liste de fréquences est dans le dépôt (`apps/api/vendor/wordfreq-fr/`), avec sa provenance (paquet PyPI et SHA-256), sa méthode de construction et ses attributions : c'est une adaptation des données CC BY-SA 4.0 de wordfreq, distribuée sous la même licence ; elle ne contient que des mots du dictionnaire. La MPL-2.0 est un copyleft limité aux fichiers : les utiliser tels quels dans le service est libre ; une version modifiée de ces fichiers devrait être publiée sous la même licence si elle était distribuée. Aucun appel réseau : rien n'est téléchargé à l'exécution.

### Traitement d'un mot

1. Ignoré s'il est dans une zone protégée (URL, e-mail, chemin, code), s'il contient un chiffre, s'il fait moins de 4 ou plus de 30 lettres, s'il est en majuscules (sigle : API, VPN, SATI), s'il a une majuscule interne (GitHub, MongoDB, RESTful) ou un trait d'union.
2. Connu ? Dictionnaire français (avec les élisions : « qu’il », « l’informatique »), liste technique de départ (`spelling/technical-terms.ts`), dictionnaire utilisateur et noms propres (prévus, vides pour l'instant). Les **graphies rectifiées de 1990** sont acceptées quand la forme classique correspondante est connue (`spelling/rectifications.ts`) : circonflexe facultatif sur i et u (connaitre, maitrise, entrainement, boite), sauf au passé simple (vînmes) ; accent grave devant une syllabe muette (évènement, règlementaire) ; tréma déplacé (ambigüe). Une faute voisine (« mèthode ») reste signalée.
3. Élision : dans « l’informatiue », seul le mot est examiné. Si le mot seul est correct (« l’occasions »), ce n'est pas une faute d'orthographe mais d'accord : rien n'est signalé (futur analyseur grammatical).
4. Langue de la phrase (voir « Langue des passages ») : en anglais, la suite ne s'applique pas.
5. Nom propre après un titre ou des initiales (« M. Kouassi », « Mme Aya Koné », « Pr. Assi », « Dr Ehui », « J.-P. Brou », « Velasio de Paolis ») : jamais signalé (`followsTitleOrInitial`, `text.ts`). Le point d'une abréviation n'est plus pris pour une fin de phrase.
6. Anglicisme : un mot connu en anglais (« team », « online », « install », « queries ») n'est pas signalé, **sauf** s'il est en minuscules, dans une phrase sûrement française, et qu'il existe un mot français qui ne s'en distingue que par les accents (« evolution » → évolution, « region », « premiere », « problemes » ; `spelling/accents.ts`) : la correction est alors une Suggestion. Dans une phrase anglaise ou incertaine, « dissemination » n'est jamais corrigé.
7. Féminin en « -eure » d'un nom en « -eur » connu (`spelling/feminine.ts`) : jamais corrigé vers le masculin. Si le féminin régulier est connu (« chercheure » → chercheuse, forme recommandée par l'Office québécois de la langue française), il est proposé en Suggestion ; sinon, l'analyse ordinaire s'applique, sans jamais dépasser la Suggestion (« vainqueure » peut être voulu, « honneure » est une faute). Les formes que le dictionnaire connaît (professeure, autrice, docteure, ingénieure…) ne sont pas signalées.
8. Mot inconnu présent au moins 3 fois dans le document : considéré comme voulu (terme, nom), sauf s'il est en minuscules et à une faute légère (accent, lettre doublée : coût ≤ 0,5) d'un mot courant (Zipf ≥ 3,5) : c'est une faute systématique (« developpement » ×3), signalée en Suggestion à chaque occurrence. Un mot en majuscule répété (Yopougon) n'est jamais signalé.
9. Contrôle rapide (quelques ms) : existe-t-il un mot du dictionnaire à une faute près (ou à deux fautes légères : accent, lettre doublée) ? Sinon, aucune correction possible. Ce contrôle évite d'interroger nspell pour un nom propre, ce qui peut lui prendre plusieurs secondes.
10. Suggestions de nspell (au plus 8), sur la forme en minuscules : les noms propres sont écartés, la casse d'origine est rétablie (« Informatiue » → « Informatique »).
11. Classement et confiance (`spelling/ranking.ts`). Mot en majuscule en milieu de phrase : signalé seulement pour une faute légère (accent, lettre doublée : « Superieur » → Supérieur) ou vers un mot très courant (Zipf ≥ 3,5 : « Informatiue » → Informatique) ; sinon c'est plus souvent un nom propre (« Gagnoa », « Assinie »).

### Classement et confiance

Distance pondérée selon les fautes réelles en français : casse 0,1 · accent 0,3 · lettre doublée ou dédoublée 0,5 · touche voisine (AZERTY) 0,7 · deux lettres inversées 0,7 · lettre manquante ou en trop 1,0 · autre substitution 1,2. Le rang donné par nspell départage légèrement, puis la **fréquence d'usage** (`spelling/frequency.ts`, échelle Zipf : 0,15 point de score par unité) : entre deux candidats aussi proches, le mot courant passe devant (recu → reçu plutôt que revu ; buget → budget plutôt que auget). Un candidat beaucoup moins probable que le meilleur (écart de score > 0,8) ne compte plus comme concurrent. Les mots en majuscule (noms propres possibles) sont classés sans fréquence et doivent rester d'accord avec nspell.

| Confiance | Conditions                                                                                                                                                                                                                      | Résultat                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Élevée    | Écart ≥ 0,5 avec le deuxième, au plus 2 candidats plausibles, **et** : même premier choix que nspell, une seule modification élémentaire (coût ≤ 1), mot courant (Zipf ≥ 3), première lettre inchangée, aucun doute de contexte | **Erreur** avec correction                       |
| Moyenne   | Écart ≥ 0,15 (ou formes d'un même mot, ex. heureux / heureuse), au plus 3 candidats plausibles ; ou correction élevée mais incertaine (voir ci-dessous)                                                                         | **Suggestion**, l'explication cite l'autre forme |
| Faible    | Tout le reste                                                                                                                                                                                                                   | Aucun signalement                                |

**Aucune correction incertaine en Erreur.** Restent au plus en Suggestion : correction vers un mot rare ou absent de la liste de fréquences (« formassion » → formassions), correction qui change la première lettre (« ealement » → salement : une faute de frappe touche rarement la première lettre), correction de plus d'une modification, désaccord avec le premier choix de nspell, mot en majuscule en milieu de phrase, mot qui existe en anglais, faute répétée. Coût maximal : 1,3 (0,8 pour un mot de 5 lettres ou moins). Un mot simplement absent du dictionnaire n'est jamais présenté comme une faute certaine.

Exemples obtenus (tests) : developpeur → développeur, environement → environnement, acceuil → accueil, professionel → professionnel, systeme → système (Erreurs) ; Informatiue → Informatique, heureus → heureux (Suggestions). Volontairement non corrigés : « peris » (paris, péris, permis… aussi proches), « cadr » (cade, cadre, cadra…), « l’occasions » (accord).

### Mémoire et chargement

Mesures sur Node.js 22 (worker réel, fournisseur d'IA de test) :

| Mesure                                                                     | Valeur                                                                      |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Chargement (nspell + Grammalecte + liste anglaise + fréquences)            | **≈ 4 à 5 s**, une seule fois par processus (fréquences : ≈ 0,1 s, ≈ 10 Mo) |
| Tas JavaScript après chargement (après GC)                                 | **≈ 302 Mo** (dont liste anglaise ≈ 3 Mo)                                   |
| RSS du worker : avant → après chargement                                   | 170 Mo → ≈ 690 Mo au repos                                                  |
| RSS du worker après 2 petits documents, puis un document de 59 000 mots    | 725 → 737 → 761 Mo                                                          |
| RSS après 2 documents de 59 000 mots en parallèle (`WORKER_CONCURRENCY=2`) | ≈ 804 Mo (pic)                                                              |
| Tas minimal pour charger le dictionnaire                                   | ≈ 416 Mo (échec à 384 Mo)                                                   |

- **Une seule instance par processus** : `loadSpellingDictionaries()` mémorise le chargement (les appels simultanés partagent la même promesse) ; `dictionaryLoadStats().loads` reste à 1, vérifié par un test sur plusieurs documents. Le log « Dictionnaires orthographiques chargés » du worker donne la durée et la mémoire mesurées.
- **Worker uniquement** : préchargé au démarrage (`SpellingPreloadService`, déclaré dans `WorkerModule`), et attendu par le moteur avant chaque analyse. L'API ne l'importe jamais (≈ 200 Mo de RSS, inchangé).
- **Risque d'OOM** : `start:worker` fixe `--max-old-space-size=1024`, pour ne pas dépendre de la limite par défaut de Node (calculée d'après la mémoire de la machine, parfois inférieure à 416 Mo dans un petit conteneur). Prévoir **au moins 1 Go de mémoire pour le processus worker**. Les documents sont plafonnés (20 Mo, 60 000 mots) et les caches de mots sont bornés : la consommation reste stable d'un document à l'autre.

### Performance

- 60 000 mots de texte réel varié : ≈ 10,6 s à froid pour l'orthographe, ≈ 0,15 s à chaud (caches). Avec du texte répété (test), moins de 0,5 s.
- Plafonds proportionnels à la longueur (`caps`, `capsPerThousandWords`) : 60 signalements d'orthographe et 80 de grammaire au moins, puis 5 pour 1 000 mots (300 pour 60 000 mots) ; mots inconnus interrogés : 200 au moins, puis 10 pour 1 000 mots (600 pour 60 000 mots). Les autres règles suivent la même logique (0,5 à 1 pour 1 000 mots).

## Grammaire : GrammarAnalyzer (Grammalecte)

Code : `analyzers/grammar.analyzer.ts`, `grammar/` ; moteur : `apps/api/vendor/grammalecte/` (provenance, construction et empreintes dans son [README](../apps/api/vendor/grammalecte/README.md)).

### Fonctionnement

```
worker (Node.js)                                   processus Python (GPL-3.0)
GrammarPreloadService ── lancement au démarrage ──► bridge.py + grammalecte-2.3.0.zip (règles chargées une fois)
AnalysisRunner.plan()
  └ checkDocumentGrammar : lots de ≈ 40 000 caractères ──JSON stdin──► Grammalecte (options de grammaire seules)
                           erreurs par paragraphe     ◄─JSON stdout──
  └ runRules(model, { grammar }) → GrammarAnalyzer : filtrage, confiance → LanguageIssue
```

- **Une seule instance par worker**, lancée au démarrage (≈ 1 s) et réutilisée pour tous les documents ; les lots sont traités l'un après l'autre (file d'attente), jamais par plusieurs processus.
- **Jamais phrase par phrase** : les paragraphes rédigés (paragraphes, puces, notes) sont envoyés par lots ; un document de 60 000 mots représente une dizaine de requêtes.
- **Aucun appel réseau** ; le texte n'est ni écrit sur disque ni journalisé ; le processus Python reçoit un environnement minimal (aucun secret du worker).
- **Positions exactes** : Grammalecte compte en points de code ; le pont convertit en unités UTF-16 (comme les chaînes JavaScript), et chaque position est revérifiée dans le texte du paragraphe avant d'être retenue.
- **Robustesse** : délai maximal par lot (60 s) ; en cas de dépassement ou d'arrêt, le processus est relancé à la demande suivante. Si Python est absent, le worker démarre quand même (erreur journalisée) et les analyses se font sans grammaire.
- Réglages : `GRAMMAR_ENGINE=grammalecte|off` et `GRAMMALECTE_PYTHON` (interpréteur, `python3` par défaut ; `python` sous Windows).

### Filtrage (faux positifs)

| Retenu (options Grammalecte → sous-type WordFix)                                                                          | Jamais remonté                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gn` → gender_number ; `ppas` → agreement ; `conj`, `infi`, `imp`, `vmode` → conjugation ; `conf`, `loc`, `inte` → syntax | orthographe (`SPELL`, traitée par le SpellingAnalyzer), typographie (apostrophes droites, espaces insécables, majuscules…), style, règles sans type |

Seules les options retenues sont activées dans Grammalecte (plus rapide). Ensuite :

- un passage d'**un seul mot** qui ressemble à un nom propre, un sigle ou un terme technique (Kouassi, Ouattara en milieu de phrase, REST, VLAN, GitHub, TypeScript, mot avec chiffre, terme de la liste technique) n'est jamais signalé ; sans correction proposée, un passage qui en contient un est écarté ;
- une « correction » qui ne change que la typographie (apostrophe, espace, tiret) est écartée ;
- zones protégées (URL, e-mails, chemins) respectées ;
- **doublons** : même zone et même sous-type → une seule remarque ; les corrections alternatives d'une même règle (« Ils a » → « ont » ou « Il ») sont regroupées en une remarque qui cite l'autre possibilité ; une faute déjà signalée au même endroit par l'orthographe n'est pas doublée.

### Confiance → nature

La nature reste décidée par la politique centrale (`nature-policy.ts`) :

| Cas                                                                                                  | Confiance | Nature     |
| ---------------------------------------------------------------------------------------------------- | --------- | ---------- |
| Une seule correction, règle d'accord ou de conjugaison (`gn`, `ppas`, `conj`, `infi`)                | élevée    | Erreur     |
| Plusieurs corrections, confusion (a/à…), locution, mode, ou faute voisine d'un homophone (son/sont…) | moyenne   | Suggestion |
| Aucune correction proposée (« une belle projet »)                                                    | faible    | À vérifier |

« Les serveur » → Erreur ; « on terminé » (termine ? terminait ? a terminé ?) → Suggestion ; « il va a Paris » → Suggestion.

### Mémoire et performance

| Mesure (Linux, Python 3.12)                 | Valeur                                 |
| ------------------------------------------- | -------------------------------------- |
| Lancement (chargement des règles)           | ≈ 0,8 à 1 s, une fois par worker       |
| Mémoire du processus Python après lancement | ≈ 80 Mo                                |
| Après un premier document de 60 000 mots    | ≈ 310 Mo, stable ensuite (4 documents) |
| Vérification de 60 000 mots                 | ≈ 11 à 14 s (≈ 12,6 s dans le test)    |

Le processus Python s'ajoute au worker Node.js : prévoir **≈ 1,2 Go par worker** au total. Le cache de formes de Grammalecte est vidé au-delà de 100 000 formes.

### Licence de Grammalecte (GPL-3.0)

Grammalecte est distribué sous **GNU GPL v3** (pas l'AGPL). Conséquences pour WordFix :

- **Service en ligne (SaaS)** : faire tourner Grammalecte sur nos serveurs pour analyser les documents des utilisateurs n'est pas une « transmission » (_convey_) au sens de la GPL v3 : aucune obligation de publier le code de WordFix. La GPL v3, contrairement à l'AGPL, ne s'applique pas à l'usage via le réseau. **Aucun blocage pour le service actuel.**
- **Séparation** : Grammalecte n'est pas chargé dans le processus Node.js. Il tourne dans un programme distinct (`bridge.py`, lui-même sous GPL-3.0-or-later), qui échange uniquement des messages JSON par entrée/sortie standard — une communication « à distance » entre programmes séparés, et non une liaison dans un même programme. Le code TypeScript de WordFix reste sous sa propre licence.
- **Le dépôt** contient l'archive de Grammalecte, son texte de licence, sa provenance et sa méthode de construction (dossier `vendor/grammalecte/`). Aucun fichier de Grammalecte n'est modifié.
- **Si WordFix était un jour distribué** (version installable, sur site, application de bureau, image Docker remise à un client) : il faudrait fournir Grammalecte et `bridge.py` avec la licence GPL v3 et leur code source correspondant (ou une offre écrite), et ne pas restreindre les droits du destinataire sur ces composants. La séparation en processus distinct permet de garder le reste de WordFix hors de la GPL, sous réserve de l'analyse d'un juriste au moment de la distribution.
- Rien de Grammalecte n'est envoyé au navigateur.

Ce point est une analyse technique, pas un avis juridique : à faire valider avant toute distribution du logiciel (hors SaaS).

## Cas ambigus : l'IA départage (étape C)

Code : `ambiguity/` (cas, budget, résolution), `analyzers/accent-confusion.analyzer.ts`, `spelling/phonetic.ts` ; consignes `AMBIGUITY_INSTRUCTIONS` (`prompts.v1.ts`, version v1.1), schéma `ambiguityResolutionSchema` (`schemas.ts`).

Le moteur déterministe reste le premier juge. Il ne confie à l'IA que les cas qu'il ne peut pas trancher, avec **ses propres candidats** :

| Cas                                                           | Exemple                               | Options (déterministes)                                                                   | Sans décision de l'IA                                                        |
| ------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Mot inconnu, plusieurs corrections proches (confiance faible) | « peris » → permis ? péris ? paris ?  | suggestions nspell classées (coût ≤ 1,3, mots assez courants), 5 au plus                  | **À vérifier** si une option est à une faute légère (coût ≤ 0,7), sinon rien |
| Suggestion avec d'autres formes proches                       | « heureus » → heureux / heureuse      | la suggestion et ses alternatives                                                         | la Suggestion déterministe                                                   |
| Mot très déformé (aucun mot à une faute près)                 | « comunikation », « akeuil »          | mots du dictionnaire de même **clé phonétique**, courants                                 | rien                                                                         |
| Accent oublié sur un mot qui en forme un autre                | « les taches qui m'ont été confiées » | variante plus accentuée, au moins aussi fréquente (jamais un participe : décide / décidé) | rien                                                                         |
| Grammaire à plusieurs corrections (confiance moyenne)         | « on terminé », « Ils a »             | corrections de Grammalecte (et alternatives)                                              | la Suggestion déterministe                                                   |

Jamais de cas pour : une correction sûre (Erreur), un mot en majuscule (nom propre possible), un sigle, un terme technique, un mot anglais, un mot répété dans le document, une zone protégée.

**Ce qui est envoyé** : pour chaque cas, le mot, sa phrase (300 caractères au plus, fenêtre autour du mot), une information linguistique en une phrase et les options. Jamais le document entier ni les autres paragraphes. Un même mot dans la même phrase (paragraphe recopié) n'est envoyé qu'une fois.

**Réponse** (JSON validé par Zod) : pour chaque cas, `caseId`, `decision` (`correct` | `keep` | `verify`), `correction` (une option recopiée, ou null), `justification` courte, `confidence`.

**Règles de sécurité** (`ambiguity/resolve.ts`) :

- une correction absente des options est refusée ; le cas garde son repli ;
- une décision de l'IA n'est **jamais une Erreur** : au mieux une Suggestion (confiance moyenne), quelle que soit la confiance annoncée ; une confiance « faible » vaut « verify » ;
- `keep` (le mot écrit est juste) retire un mot inconnu ou une confusion, mais une faute de Grammalecte n'est jamais effacée : elle devient À vérifier ;
- `verify` : À vérifier (sans correction) ; pour une confusion d'accents, rien ;
- IA indisponible, réponse hors schéma, plafond quotidien de jetons atteint : chaque cas garde son repli, l'analyse continue.

**Budget par analyse** (`LANGUAGE_ENGINE_CONFIG.ambiguity.ai`) : 3 lots au plus, 20 cas par lot (60 cas), 300 caractères de contexte par cas, 4 000 jetons de sortie par lot. Priorité : mots inconnus, mots déformés, grammaire, accents. Les cas hors budget gardent leur repli. Les lots sont des morceaux de l'étape « verify » (index ≥ 100) : reprenables, jamais payés deux fois, jetons enregistrés sur le morceau et l'analyse. Logs : « Cas ambigus du moteur de langue » (cas, envoyés, lots, hors budget) et « Cas ambigus résolus » (décisions, jetons).

Coût mesuré (jetons d'entrée et de sortie visibles, tokenizer o200k ; les jetons de raisonnement du modèle s'y ajoutent) : ≈ 0,5 k + 0,1 k pour 1 000 mots, ≈ 2,7 k + 0,8 k pour 10 000 mots, ≈ 5,9 k + 2,0 k pour 60 000 mots (plafond atteint).

## Configuration

Tous les seuils sont dans `engine/language/config.ts` (`LANGUAGE_ENGINE_CONFIG`, dont `ambiguity` pour les cas ambigus et le budget IA) : types de paragraphes analysés, plafonds par règle, exceptions de répétition, seuil de phrase longue, détection des énumérations, pour l'orthographe (`spelling`) longueurs de mots, nombre de suggestions examinées, budget de recherches, seuil de répétition, coûts et écarts de confiance, et pour la grammaire (`grammar`) options Grammalecte retenues et leur sous-type, options à confiance élevée, homophones, taille des lots. Un moteur avec d'autres réglages s'obtient par `createLanguageEngine(config)`.

## Ajouter un analyseur

1. Créer `engine/language/analyzers/<nom>.analyzer.ts` qui implémente `LanguageAnalyzer` :
   - `id` : nom court ;
   - `blockKinds(config)` : types de paragraphes acceptés ;
   - `analyze(block, context)` : renvoie des `LanguageIssue` avec `rule`, `category`, `subtype` (de la taxonomie partagée), `range` exacte dans `block.text`, `original` égal au texte de cette plage, `suggestion` ou `null`, `confidence`, `severity`, `source: 'rules'`.
2. Ajouter l'identifiant de règle dans `LANGUAGE_RULE_IDS` et son plafond dans `LANGUAGE_ENGINE_CONFIG.caps`.
3. L'enregistrer dans `createLanguageEngine()` (`language-engine.ts`).
4. Respecter les règles du moteur : linéaire sur la longueur du paragraphe, aucun appel réseau, aucune correction propre à un document particulier, zones protégées (`context.protectedRanges`) respectées, et confiance élevée réservée aux cas certains. Un cas douteux n'est pas signalé, ou l'est avec une confiance faible.
5. Ajouter les tests : cas détectés, faux positifs évités, puis vérifier que le corpus (`pnpm test:integration`) ne produit toujours aucune « erreur » sur les documents propres.

## Tester

```bash
pnpm --filter @wordfix/api exec vitest run --project unit src/engine   # moteur et règles
pnpm test:integration                                                   # pipeline complet + corpus de 13 documents
```

`analyzers/spelling.analyzer.spec.ts` couvre l'orthographe (mots corrects, fautes inconnues, noms propres, sigles, URL, e-mails, chemins, termes techniques, casse, accents, plusieurs fautes, doublons, 60 000 mots, chargement unique du dictionnaire). Les tests qui utilisent le moteur chargent les dictionnaires une fois par fichier (≈ 5 s). Le bloc « calibration » couvre la fréquence, les accents oubliés face aux anglicismes, les noms après un titre, les graphies rectifiées, les fautes répétées, les règles de confiance et le budget proportionnel ; `spelling/calibration.spec.ts` teste chaque règle isolément (liste de fréquences, rectifications, accents, titres et initiales, plafonds). `ambiguity/ambiguity.spec.ts` couvre l'étape C avec le faux fournisseur (peris, cadr, taches/tâches, mot déformé, aucun candidat, nom propre, terme technique, aucun appel pour les cas sûrs, budget, réponse invalide, IA indisponible) ; `test/ambiguity.e2e-spec.ts` la chaîne complète. `ambiguity/ambiguity-gemini.spec.ts` rejoue l'étape C avec `GeminiAiProvider` (SDK réel, réponses HTTP simulées, aucun appel réseau) : mêmes règles de sécurité qu'avec OpenAI (correction inventée refusée, jamais d'Erreur, repli en cas de quota ou de réponse hors schéma).

`analyzers/grammar.analyzer.spec.ts` lance le vrai Grammalecte (Python 3 requis) : « Les serveur », « on terminé », a/à, « une belle projet », participes, accords sujet-verbe, alternatives regroupées, homophones, positions exactes (y compris après un emoji), aucun faux positif sur noms propres et termes techniques, apostrophes droites, document propre, compatibilité avec le pipeline et 60 000 mots. `grammar/mapping.spec.ts` teste le filtrage seul, `grammar/grammalecte-client.spec.ts` le processus (lancement unique, délai dépassé et relance, Python absent), `grammar/check-document.spec.ts` le découpage en lots. `test/grammar.e2e-spec.ts` couvre la chaîne complète DOCX → extraction → Grammalecte → remarques de l'API.

`detection.spec.ts` couvre la détection de langue (français, anglais, alternance par phrase, citation, titres, mots-clés) ; `language-detection.spec.ts` les faux positifs linguistiques avec les vrais dictionnaires (fautes françaises conservées, anglais correct sans remarque, Grammalecte ignoré sur l'anglais, document bilingue, villes, établissements et sigles, féminins en « -eure », fautes anglaises évidentes) ; `spelling/english-words.spec.ts` et `spelling/feminine.spec.ts` leurs outils ; `test/language-detection.e2e-spec.ts` la chaîne complète sur un document bilingue.

`language-engine.spec.ts` couvre les répétitions, les phrases longues, la typographie, les garde-fous, la localisation multi-paragraphes, les plafonds, la compatibilité avec le pipeline (nature décidée par le backend) et la performance sur 60 000 mots.
