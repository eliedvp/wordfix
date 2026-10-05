import type { Metadata } from 'next';
import { PRIVACY_STATEMENTS } from '@/lib/copy';

export const metadata: Metadata = { title: 'Confidentialité' };

/**
 * Chaque phrase de cette page correspond à un mécanisme réellement en place.
 * Toute modification doit être validée (voir docs/decisions.md, P1).
 */
const DETAILS: string[] = [
  'Le site n’est accessible que par une connexion chiffrée : ce que vous envoyez ne circule pas en clair sur le réseau.',
  'Le fichier Word que vous importez est conservé dans un espace de stockage privé, sans adresse publique, le temps de lancer et éventuellement de relancer l’analyse. Il est effacé automatiquement au bout de 24 heures.',
  'Le texte extrait de votre document et les points relevés restent disponibles 7 jours pour terminer votre relecture, puis sont effacés automatiquement. Le bouton « Supprimer » de la page Mes documents efface tout immédiatement.',
  'Aucun compte n’est nécessaire : un cookie de session, inaccessible aux scripts de la page, relie vos documents à ce navigateur. Une analyse ne peut pas être consultée depuis un autre navigateur, et aucun lien de partage n’existe.',
  'L’analyse s’appuie sur le service d’intelligence artificielle d’OpenAI : le texte du document lui est envoyé par morceaux. Le fichier Word lui-même ne lui est pas transmis.',
];

export default function PrivacyPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="font-display text-ink text-3xl font-semibold tracking-tight">
        Confidentialité
      </h1>
      <p className="text-ink-muted mt-3 text-lg">
        Vos rapports et mémoires peuvent contenir des informations personnelles ou professionnelles.
        Voici exactement ce que WordFix en fait.
      </p>
      <ol className="mt-10 space-y-8">
        {PRIVACY_STATEMENTS.map((statement, index) => (
          <li key={statement} className="border-brand border-l-[3px] pl-5">
            <h2 className="text-ink font-semibold">{statement}</h2>
            <p className="text-ink-muted mt-2 leading-relaxed">{DETAILS[index]}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
