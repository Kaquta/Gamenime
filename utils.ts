import type { ContentItem } from "./types";

export function formatDate(value: string | null): string {
  if (!value) return "Date inconnue";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(date);
}

export function isUpcoming(value: string | null): boolean {
  if (!value) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;

  return date >= today;
}

export function sortByDateDesc(items: ContentItem[]): ContentItem[] {
  return [...items].sort((a, b) => {
    const aTime = a.releaseDate ? new Date(a.releaseDate).getTime() : 0;
    const bTime = b.releaseDate ? new Date(b.releaseDate).getTime() : 0;
    return bTime - aTime;
  });
}

export function getStatusLabel(item: ContentItem): string {
  if (!item.releaseDate) return "À surveiller";

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const release = new Date(item.releaseDate);
  release.setHours(0, 0, 0, 0);

  const diffDays = Math.round(
    (release.getTime() - now.getTime()) / 86_400_000,
  );

  if (diffDays === 0) return "Aujourd'hui";
  if (diffDays > 0) return "À venir";
  if (item.isRecentlyReleased) return "Récent";
  return "Sorti";
}
