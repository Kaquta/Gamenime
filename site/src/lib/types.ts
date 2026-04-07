export type ContentItem = {
  id: number | string;
  title: string;
  cover: string | null;
  genre: string | null;
  platform: string | null;
  releaseDate: string | null;
  isRecentlyReleased: boolean | number;
  trailerUrl?: string | null;
};
