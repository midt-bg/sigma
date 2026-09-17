import { useId, type ReactNode } from 'react';
import type { OwnershipKind } from '@sigma/api-contract';
import { pct } from '@sigma/shared';

// Small editorial primitives shared across pages. Class definitions live in app.css (ported verbatim
// from the mock); these just emit the markup.

// `tone` weights a chip by signal strength: 'strong' for the strongest conflict signal (own-institution),
// 'window' for the declared-stake overlap. Omit for a neutral chip (the default everywhere else).
const CHIP_HELP: Record<string, string> = {
  'дял на свързано лице':
    'Деклараторът е посочил участие на друго свързано с него лице. Това не е твърдение за негов собствен дял или лична роля в дружеството.',
  'свързано лице':
    'Участието е декларирано за друго лице, свързано с декларатора. Не означава собствен дял на човека, чието име е показано.',
  'собствен и свързан дял':
    'Налични са сведения както за собствен дял на декларатора, така и за дял на друго свързано лице. Подробностите са в конкретните декларации.',
  'съвпадение по години':
    'Има договор, подписан между първата и последната положителна декларационна година за участието. Това не доказва непрекъсната собственост или нарушение.',
  'в декларирания период':
    'Годината на подписване попада в декларирания диапазон. Декларациите дават съпоставка по години, не точни дати на собственост.',
  'от собствената институция':
    'Възложителят съвпада с институция, посочена в декларациите на лицето. Това само по себе си не доказва длъжност към датата на договора или нарушение.',
  'предходно участие':
    'Документът съобщава за участие преди релевантния момент. Годината на документа не е автоматично година на самото участие.',
  'предходно управление':
    'Декларирано е предходно управление. Точният му период се установява отделно от регистърните данни.',
  'прехвърлен дял':
    'Документът съдържа сведение за прехвърляне. Датата на подаване не е непременно датата на прехвърлянето.',
  'лична роля в тр':
    'Договорът е подписан през доказан вписан период на самото лице. Отворените роли се проверяват до последната успешна справка.',
  'деклариран собствен дял':
    'Делът е деклариран като собствен на лицето. Времето се отчита по наличните декларации.',
  'собствен дял': 'Участието е посочено като собствено в тази декларация.',
  'управление по търговския регистър':
    'Търговският регистър вписва лицето като управител на частното дружество, а публикуван деклариран интерес в него няма.',
  'декларирано управление':
    'Лицето е декларирало, че управлява това частно дружество. Управителят се показва наравно със собственика; времето се отчита по наличните декларации.',
  'без еик':
    'Няма потвърден публичен ЕИК. Наименованието не е достатъчно за доказване на самоличност или правна форма.',
  'съвместни изпълнители':
    'Участниците са посочени заедно в източника. Това не доказва отделно юридическо лице или разпределение на стойността между тях.',
  обединение:
    'Група изпълнители, посочени заедно в източника. Самият списък не доказва отделно юридическо лице.',
  'непотвърден тотал':
    'Стойността не е потвърдена като обща стойност на договора. Виж източника и обяснението към анекса.',
  'коригиран тотал': 'Общата стойност е коригирана въз основа на проследимите договорни документи.',
};

/** Native top-layer popover: works with touch/keyboard, closes with Escape or outside click. */
export function Explanation({
  text,
  label = 'Какво означава',
  trigger = '?',
  triggerClassName = 'help-trigger',
}: {
  text: ReactNode;
  label?: string;
  trigger?: ReactNode;
  triggerClassName?: string;
}) {
  const id = useId();
  return (
    <span className="inline-help">
      <button
        type="button"
        className={triggerClassName}
        popoverTarget={id}
        aria-label={label}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect(),
            panel = document.getElementById(id);
          if (panel) {
            panel.style.left = `${Math.max(12, Math.min(box.left, window.innerWidth - 332))}px`;
            panel.style.top = `${Math.max(12, Math.min(box.bottom + 8, window.innerHeight - 180))}px`;
          }
        }}
      >
        {trigger}
      </button>
      <span
        id={id}
        popover="auto"
        className="help-popover"
        onToggle={(event) => {
          if (event.newState !== 'open') return;
          const panel = event.currentTarget;
          const box = panel.getBoundingClientRect();
          panel.style.top = `${Math.max(12, Math.min(box.top, window.innerHeight - box.height - 12))}px`;
        }}
      >
        {text}
      </span>
    </span>
  );
}
export function Chip({
  children,
  tone,
  explain = true,
}: {
  children: ReactNode;
  tone?: 'strong' | 'window';
  explain?: boolean;
}) {
  const help = typeof children === 'string' ? CHIP_HELP[children.toLowerCase()] : undefined;
  const className = `chip${tone ? ` chip-${tone}` : ''}`;
  return help && explain ? (
    <Explanation
      text={help}
      label={`Какво означава „${children}“`}
      trigger={children}
      triggerClassName={`${className} chip-trigger`}
    />
  ) : (
    <span className={className}>{children}</span>
  );
}

const REGISTRY_URL = 'https://portal.registryagency.bg/CR/bg/Reports/ActiveConditionTabResult';

/** The public Търговски регистър report for one ЕИК — the partida's current state. */
export function registryUrl(eik: string): string {
  return `${REGISTRY_URL}?uic=${encodeURIComponent(eik)}`;
}

// The profile header's way to the entity's official record: a labelled action in the page header, the same
// `.source-cta` the contract page uses for „Виж документите в ЦАИС ЕОП" (with its :visited guard). The bare
// icon link below stays for dense blocks; in a header the meaning has to be readable without a mouse.
export function RegistryCta({ eik }: { eik: string }) {
  return (
    <a className="source-cta" href={registryUrl(eik)} target="_blank" rel="noopener noreferrer">
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        aria-hidden="true"
      >
        <path d="M2 5.25 8 1.75l6 3.5z" />
        <path d="M3.5 6.5v5.5M6.5 6.5v5.5M9.5 6.5v5.5M12.5 6.5v5.5" />
        <path d="M2.5 14.25h11" />
      </svg>
      Виж в Търговския регистър
      <span className="sr-only"> (в нов раздел)</span>
      <span className="cta-ext" aria-hidden="true">
        ↗
      </span>
    </a>
  );
}

export function ExternalEikLink({ eik, className }: { eik: string; className?: string }) {
  return (
    <a
      href={registryUrl(eik)}
      target="_blank"
      rel="noopener noreferrer"
      className={`external-eik-link${className ? ` ${className}` : ''}`}
      aria-label={`Отвори ЕИК ${eik} в Търговския регистър (в нов раздел)`}
      title="Отвори в Търговския регистър (в нов раздел)"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
    </a>
  );
}

const OWNERSHIP_LABELS: Record<OwnershipKind, string> = {
  state: 'държавно',
  municipal: 'общинско',
  mixed: 'държавно-общинско',
};

export function OwnershipChip({ kind }: { kind: OwnershipKind | null | undefined }) {
  if (!kind) return null;
  return <Chip>{OWNERSHIP_LABELS[kind]}</Chip>;
}

export function Flag({
  children,
  variant,
}: {
  children: ReactNode;
  variant?: 'soft' | 'info' | 'neutral';
}) {
  return <span className={`flag${variant ? ` ${variant}` : ''}`}>{children}</span>;
}

// Inline percentage bar. `warn` paints the fill in the accent red (e.g. a dominant share).
export function ShareBar({ ratio, warn }: { ratio: number; warn?: boolean }) {
  const width = `${Math.min(100, Math.max(0, ratio * 100)).toFixed(1)}%`;
  return (
    <span className="share">
      <span className={`share-bar${warn ? ' warn' : ''}`} aria-hidden="true">
        <i style={{ width }} />
      </span>
      <span className="share-num">
        {pct(ratio)}
        {warn && <span className="sr-only"> — висок дял</span>}
      </span>
    </span>
  );
}

export function Callout({
  title,
  titleAs = 'h3',
  variant,
  children,
}: {
  title?: ReactNode;
  // Heading level for the title. Defaults to h3 (a callout nested under a section's h2). Pass 'h2' when the
  // callout sits at the TOP of a page — directly under the page h1 — so the outline doesn't skip h1→h3→h2.
  titleAs?: 'h2' | 'h3';
  variant?: 'warning';
  children: ReactNode;
}) {
  const Heading = titleAs;
  return (
    <div className={`callout${variant ? ` ${variant}` : ''}`}>
      {title != null && <Heading>{title}</Heading>}
      {children}
    </div>
  );
}

// A titled content section (ink-rule h2 + optional hint). The title may carry an <em> accent.
export function Section({
  id,
  title,
  hint,
  children,
}: {
  id: string;
  title: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {hint != null && <p className="section-hint">{hint}</p>}
      {children}
    </section>
  );
}
