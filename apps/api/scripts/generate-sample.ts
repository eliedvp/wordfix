/**
 * Génère le rapport de stage d'exemple proposé sur la page d'accueil
 * (apps/web/public/exemple/rapport-de-stage-exemple.docx).
 *
 * C'est un vrai document Word, analysé par le vrai pipeline : il contient
 * volontairement quelques fautes, une incohérence et une numérotation fautive.
 * Usage : pnpm --filter @wordfix/api sample:generate
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDocx } from '../test/fixtures/builders.js';

const target = fileURLToPath(
  new URL('../../web/public/exemple/rapport-de-stage-exemple.docx', import.meta.url),
);

const buffer = await buildDocx(
  [
    { h: 1, text: 'Remerciements' },
    {
      p: 'Je tiens à remercier l’ensemble de l’équipe informatique de la société Médilog pour son accueil chaleureux et sa disponibilité tout au long de ce stage. Je remercie particulièrement mon maître de stage, qui m’a accordé sa confiance dès les premiers jours.',
    },
    { h: 1, text: '1. Introduction' },
    {
      p: 'Ce rapport présente le stage de fin d’études que j’ai effectué au sein du service informatique de Médilog, une entreprise spécialisée dans la distribution de matériel médical. La durée du stage est de quatre mois, du 3 mars au 27 juin 2026.',
    },
    {
      p: 'L’objectif principal de ce stage était de participer à la modernisation de l’infrastructure réseau de l’entreprise, qui reposait jusqu’alors sur des équipements vieillissants et difficiles à superviser.',
    },
    { h: 2, text: '1.1 Présentation de l’entreprise' },
    {
      p: 'Médilog emploie environ 120 personnes réparties sur deux sites. L’entreprise dispose de plusieurs serveurs informatique hébergés dans une salle technique située au siège. Le service informatique compte cinq personnes, dont un administrateur réseau et deux techniciens de proximité.',
    },
    {
      p: 'Les équipes utilisent quotidiennement un logiciel de gestion des stocks, une messagerie interne et un outil de suivi des commandes, ce qui rend la disponibilité du réseau essentielle pour l’activité de l’entreprise et pour la satisfaction des clients qui attendent des livraisons rapides et fiables chaque jour de la semaine sans exception.',
    },
    { h: 2, text: '1.3 Problématique' },
    {
      p: 'Comment moderniser le réseau de l’entreprise sans interrompre le travail des équipes ? Cette question a guidé l’ensemble de mes missions. Les utilisateurs signalaient régulièrement des coupures, et les les techniciens manquaient d’outils pour en identifier l’origine.',
    },
    { h: 1, text: '2. Missions réalisées' },
    {
      p: 'Ma première mission a consisté à réaliser un inventaire complet des équipements réseau. J’ai recensé les commutateurs, les bornes Wi-Fi et les routeurs, puis j’ai documenté leur configuration dans un tableau partagé avec l’équipe.',
    },
    {
      table: [
        ['Équipement', 'Quantité', 'État'],
        ['Commutateurs', '14', 'À remplacer'],
        ['Bornes wifi', '9', 'Correct'],
        ['Routeurs', '2', 'Correct'],
      ],
    },
    {
      p: 'J’ai ensuite mis en place un outil de supervision qui permet à l’administrateur système de recevoir une alerte dès qu’un équipement ne répond plus. Grâce à cet outil, les coupures sont désormais détectées en quelques minutes.',
    },
    {
      p: 'Ensuite, le budget. Le remplacement des commutateurs a été chiffré à 18 000 euros, une somme validée par la direction après la présentation de mon étude.',
    },
    { h: 1, text: '3. Bilan' },
    {
      p: 'Au terme de ces six mois de stage, le réseau de Médilog est mieux connu, mieux documenté et surveillé en permanence. Ce stage m’a permis de mettre en pratique mes connaissances et de découvrir le fonctionnement réel d’un service informatique.',
    },
    {
      p: 'Je retiens surtout l’importance de la communication avec les utilisateurs : une solution technique n’est utile que si elle est comprise et adoptée par ceux qui l’utilisent au quotidien.',
    },
  ],
  { title: 'Rapport de stage — Modernisation du réseau de Médilog' },
);

writeFileSync(target, buffer);
// eslint-disable-next-line no-console -- script en ligne de commande
console.log(`Exemple généré : ${target} (${buffer.length} octets)`);
