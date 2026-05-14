-- Migration 010 : ajout rating_score (note qualitative 0-100, normalisée par les workflows)
-- Distinct de :
--   - popularity (signal social, nb de fans/votes/userCount)
--   - rating (PEGI/ESRB, varchar texte)
-- NULL = note inconnue → core.ts dégrade en popularity-only.

ALTER TABLE anime_items
  ADD COLUMN rating_score INT DEFAULT NULL AFTER rating;

ALTER TABLE game_items
  ADD COLUMN rating_score INT DEFAULT NULL AFTER rating;

CREATE INDEX idx_anime_rating_score ON anime_items(rating_score);
CREATE INDEX idx_games_rating_score ON game_items(rating_score);
