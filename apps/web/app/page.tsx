import {
  BookOpenCheck,
  FileSearch,
  GraduationCap,
  Layers,
  ShieldCheck,
  Briefcase,
  ScrollText,
  ListChecks,
} from 'lucide-react';
import Link from 'next/link';
import { AnnotatedSpecimen } from '@/components/home/annotated-specimen';
import { UploadPanel } from '@/components/upload/upload-panel';
import { getAiMode } from '@/lib/ai-mode';
import { PRIVACY_STATEMENTS, privacyStatements } from '@/lib/copy';
import { NATURE_ORDER, NATURES } from '@/lib/nature';
import { cn } from '@/lib/utils';

const STEPS = [
  {
    title: 'Importez votre .docx',
    text: 'Le fichier est vérifié, puis WordFix vous indique son nombre de pages avant toute analyse.',
  },
  {
    title: 'WordFix relit tout le document',
    text: 'Phrase par phrase, section par section, puis le document entier pour repérer les incohérences entre les parties.',
  },
  {
    title: 'Vous décidez, point par point',
    text: 'Chaque remarque est localisée et expliquée. Vous l’appliquez, l’ignorez ou la vérifiez.',
  },
];

const CHECKS = [
  {
    icon: BookOpenCheck,
    title: 'Les fautes qui échappent',
    text: 'Orthographe, accords, conjugaison, ponctuation, mots doublés.',
  },
  {
    icon: FileSearch,
    title: 'Les phrases à retravailler',
    text: 'Formulations lourdes, phrases trop longues, registre trop familier.',
  },
  {
    icon: Layers,
    title: 'La cohérence entre chapitres',
    text: 'Informations contradictoires, termes qui changent, temps qui varient.',
  },
  {
    icon: ListChecks,
    title: 'La structure',
    text: 'Numérotation des titres, sommaire périmé, transitions et paragraphes à vérifier.',
  },
];

const AUDIENCES = [
  {
    icon: Briefcase,
    title: 'Rapport de stage',
    text: 'Le vocabulaire de l’entreprise reste le même du début à la fin.',
  },
  {
    icon: GraduationCap,
    title: 'Mémoire',
    text: 'Les chiffres et définitions concordent d’un chapitre à l’autre.',
  },
  {
    icon: ScrollText,
    title: 'Thèse',
    text: 'Les sigles sont définis et les titres bien numérotés.',
  },
  {
    icon: BookOpenCheck,
    title: 'Rapport professionnel',
    text: 'Un texte clair, sans faute, prêt à être transmis.',
  },
];

export default async function HomePage() {
  // Engagements affichés : le dernier dépend du mode IA réellement configuré.
  const statements = privacyStatements(await getAiMode());
  return (
    <>
      <section className="mx-auto grid w-full max-w-6xl gap-10 px-4 pt-10 pb-16 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:items-start lg:gap-14 lg:pt-16">
        <div>
          <h1 className="font-display text-ink text-[2rem] leading-tight font-bold tracking-tight sm:text-[2.6rem]">
            Perfectionnez vos documents Word en quelques instants.
          </h1>
          <p className="text-ink-muted mt-4 max-w-xl text-lg leading-relaxed">
            Analysez vos rapports, mémoires et documents longs pour détecter les fautes,
            incohérences, formulations maladroites et passages qui méritent votre attention.
          </p>
          <div className="mt-8">
            <UploadPanel />
          </div>
          <p className="text-ink-subtle mt-6 flex items-start gap-2 text-sm">
            <ShieldCheck className="text-brand mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              {PRIVACY_STATEMENTS[1]}{' '}
              <Link href="/confidentialite" className="text-ink underline underline-offset-4">
                Comment vos documents sont traités
              </Link>
            </span>
          </p>
        </div>
        <div className="lg:pt-2">
          <AnnotatedSpecimen />
          <ul className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3">
            {NATURE_ORDER.map((key) => {
              const nature = NATURES[key];
              const Icon = nature.icon;
              return (
                <li key={key} className="flex items-start gap-2 text-sm">
                  <Icon className={cn('mt-0.5 size-4 shrink-0', nature.text)} aria-hidden />
                  <span>
                    <span className="text-ink font-semibold">{nature.label}</span>
                    <span className="text-ink-subtle block">{nature.help}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section id="fonctionnement" className="bg-surface border-hairline border-y">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="font-display text-ink text-2xl font-semibold tracking-tight">
            Comment ça marche
          </h2>
          <ol className="mt-8 grid gap-8 md:grid-cols-3">
            {STEPS.map((step, index) => (
              <li key={step.title}>
                <span className="font-display text-brand text-3xl font-bold" aria-hidden>
                  {index + 1}
                </span>
                <h3 className="text-ink mt-2 font-semibold">{step.title}</h3>
                <p className="text-ink-muted mt-2 leading-relaxed">{step.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 className="font-display text-ink text-2xl font-semibold tracking-tight">
          Ce que WordFix regarde pour vous
        </h2>
        <div className="mt-8 grid gap-x-10 gap-y-8 md:grid-cols-2">
          {CHECKS.map(({ icon: Icon, title, text }) => (
            <div key={title} className="flex gap-4">
              <Icon className="text-brand mt-1 size-5 shrink-0" aria-hidden />
              <div>
                <h3 className="text-ink font-semibold">{title}</h3>
                <p className="text-ink-muted mt-1 leading-relaxed">{text}</p>
              </div>
            </div>
          ))}
        </div>

        <h2 className="font-display text-ink mt-16 text-2xl font-semibold tracking-tight">
          Pensé pour vos écrits longs
        </h2>
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {AUDIENCES.map(({ icon: Icon, title, text }) => (
            <li key={title} className="border-hairline bg-surface rounded-card border p-5">
              <Icon className="text-brand size-5" aria-hidden />
              <h3 className="text-ink mt-3 font-semibold">{title}</h3>
              <p className="text-ink-muted mt-1 text-sm leading-relaxed">{text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="bg-brand-soft">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
          <h2 className="font-display text-brand-deep text-xl font-semibold">
            Vos documents restent privés
          </h2>
          <ul className="text-ink-muted mt-4 grid gap-2 md:grid-cols-2">
            {statements.map((statement) => (
              <li key={statement} className="flex gap-2">
                <ShieldCheck className="text-brand mt-1 size-4 shrink-0" aria-hidden />
                {statement}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
