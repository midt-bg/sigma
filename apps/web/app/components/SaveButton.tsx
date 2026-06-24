import { useEffect, useState } from 'react';
import { useWatchlist, type WatchlistItemKind } from '../hooks/useWatchlist';

export function SaveButton({
  id,
  kind,
  title,
  subtitle,
  href,
}: {
  id: string;
  kind: WatchlistItemKind;
  title: string;
  subtitle: string;
  href: string;
}) {
  const { isSaved, toggleItem } = useWatchlist();

  const saved = isSaved(kind, id);

  return (
    <button
      type="button"
      onClick={() => toggleItem({ id, kind, title, subtitle, href })}
      className={`save-btn ${saved ? 'is-saved' : ''}`}
      aria-label={saved ? 'Премахни от запазени' : 'Добави в запазени'}
      title={saved ? 'Премахни от запазени' : 'Добави в запазени'}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill={saved ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
      <span className="save-btn-text">{saved ? 'Запазено' : 'Запази'}</span>
    </button>
  );
}
