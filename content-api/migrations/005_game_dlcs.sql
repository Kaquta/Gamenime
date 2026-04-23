-- ==========================================
-- Migration 005 : Game DLCs tracking
-- Date : 2026-04-23
-- Description : Ajoute colonne dlcs JSON pour stocker les DLCs
-- ==========================================

ALTER TABLE game_items
  ADD COLUMN IF NOT EXISTS dlcs LONGTEXT NULL COMMENT 'JSON array of DLCs: [{name, releaseDate, description}]';

INSERT IGNORE INTO schema_migrations (version, description) 
  VALUES ('005', 'Game DLCs: JSON field for tracking DLC releases');

SELECT '✅ Migration 005 appliquée' AS status;
