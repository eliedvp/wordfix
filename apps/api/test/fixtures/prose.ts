/**
 * Paragraphes rédigés dans un français correct, pour construire des documents
 * réalistes (au lieu de texte de remplissage). Ils servent de base « sans faute »
 * au corpus de tests et au script d'évaluation de la qualité.
 */
export const CLEAN_PARAGRAPHS: string[] = [
  'L’entreprise d’accueil est une société de services numériques implantée à Lyon depuis une quinzaine d’années. Elle accompagne des clients du secteur de la santé dans la gestion de leurs systèmes d’information et compte aujourd’hui une soixantaine de collaborateurs répartis entre le développement, l’infrastructure et le support.',
  'Le service dans lequel j’ai effectué mon stage est chargé de l’exploitation des serveurs et du réseau. Il assure la disponibilité des applications utilisées par les clients, planifie les mises à jour et intervient en cas d’incident, y compris en dehors des heures ouvrées grâce à un système d’astreinte.',
  'La mission qui m’a été confiée consistait à automatiser le déploiement des serveurs de test. Jusqu’alors, chaque installation était réalisée à la main, ce qui prenait plusieurs heures et produisait des configurations légèrement différentes d’une machine à l’autre.',
  'Pour mener à bien ce projet, j’ai d’abord étudié les procédures existantes et interrogé les administrateurs qui les appliquaient. Ces entretiens m’ont permis d’identifier les étapes répétitives, les erreurs fréquentes et les informations qui n’étaient écrites nulle part.',
  'J’ai ensuite comparé plusieurs outils d’automatisation en fonction de critères définis avec mon tuteur : la facilité de prise en main, la compatibilité avec les systèmes déjà en place et la qualité de la documentation disponible. L’outil retenu offrait le meilleur compromis pour une équipe de petite taille.',
  'La phase de réalisation s’est déroulée en plusieurs itérations. À chaque étape, je présentais l’avancement à l’équipe, qui testait les scripts sur un environnement isolé avant de valider leur utilisation sur les serveurs partagés.',
  'Les premiers résultats ont rapidement montré l’intérêt de la démarche. Le temps nécessaire pour préparer un serveur de test est passé de trois heures à une vingtaine de minutes, et les écarts de configuration ont pratiquement disparu.',
  'Ce projet m’a également confronté à des difficultés. Certains serveurs anciens ne prenaient pas en charge les versions récentes des outils, ce qui m’a obligé à prévoir des cas particuliers et à documenter précisément leurs limites.',
  'Au-delà de l’aspect technique, ce stage m’a appris à organiser mon travail sur plusieurs semaines. J’ai tenu un journal de bord dans lequel je notais les décisions prises, les problèmes rencontrés et les solutions envisagées, ce qui m’a beaucoup aidé lors de la rédaction de ce rapport.',
  'La communication avec les utilisateurs a joué un rôle essentiel. Une solution technique n’est utile que si elle est comprise par ceux qui l’utilisent ; j’ai donc rédigé un guide court, illustré d’exemples, que l’équipe consulte désormais avant chaque déploiement.',
  'Sur le plan personnel, cette expérience a confirmé mon intérêt pour les métiers de l’infrastructure. J’ai apprécié la diversité des tâches et la nécessité de trouver des solutions fiables dans des délais souvent courts.',
  'En conclusion, les objectifs fixés au début du stage ont été atteints. L’automatisation est utilisée au quotidien par l’équipe, et plusieurs pistes d’amélioration ont été identifiées pour la suite, notamment l’extension du dispositif aux serveurs de production.',
];

/**
 * Fautes injectées, chacune avec sa forme correcte, sa catégorie attendue et
 * un contexte de phrase naturel. Utilisées par le corpus et l'évaluation.
 */
export interface InjectedError {
  wrong: string;
  right: string;
  category: 'spelling' | 'grammar' | 'punctuation';
  sentence: string;
}

export const INJECTED_ERRORS: InjectedError[] = [
  {
    wrong: 'serveurs informatique',
    right: 'serveurs informatiques',
    category: 'grammar',
    sentence: 'L’équipe administre plusieurs serveurs informatique répartis sur deux sites.',
  },
  {
    wrong: 'il ont',
    right: 'ils ont',
    category: 'grammar',
    sentence: 'Les techniciens étaient débordés : il ont donc demandé de l’aide.',
  },
  {
    wrong: 'nous avons réalisés',
    right: 'nous avons réalisé',
    category: 'grammar',
    sentence: 'Ensuite, nous avons réalisés une démonstration pour les utilisateurs.',
  },
  {
    wrong: 'les résultat',
    right: 'les résultats',
    category: 'grammar',
    sentence: 'Nous avons présenté les résultat obtenus à la direction.',
  },
  {
    wrong: 'environement',
    right: 'environnement',
    category: 'spelling',
    sentence: 'Chaque script est testé dans un environement isolé.',
  },
  {
    wrong: 'dévelopement',
    right: 'développement',
    category: 'spelling',
    sentence: 'Le service de dévelopement compte douze personnes.',
  },
  {
    wrong: 'malgrés',
    right: 'malgré',
    category: 'spelling',
    sentence: 'Le projet a abouti malgrés les retards de livraison.',
  },
  {
    wrong: 'quelques soit',
    right: 'quel que soit',
    category: 'grammar',
    sentence: 'La procédure s’applique quelques soit le type de serveur.',
  },
  {
    wrong: 'a été effectuer',
    right: 'a été effectuée',
    category: 'grammar',
    sentence: 'La migration a été effectuer pendant le week-end.',
  },
  {
    wrong: 'Cependant le',
    right: 'Cependant, le',
    category: 'punctuation',
    sentence: 'Cependant le budget initial ne prévoyait pas cette dépense.',
  },
];
