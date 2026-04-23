-- ==========================================
-- Migration 003 : Alert System (préférences match)
-- Date : 2026-04-22
-- Description : Table de log des alertes pour éviter doublons
-- ==========================================

CREATE TABLE IF NOT EXISTS alert_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  item_type ENUM('anime', 'game') NOT NULL,
  item_id INT NOT NULL,
  match_type VARCHAR(20) NOT NULL COMMENT 'genre | platform',
  match_value VARCHAR(100) NOT NULL COMMENT 'Le genre/plateforme qui a matché',
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_alert (user_id, item_type, item_id),
  INDEX idx_user_sent (user_id, sent_at DESC),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT IGNORE INTO schema_migrations (version, description) 
  VALUES ('003', 'Alert system: log table for genre/platform alert matches');

SELECT '✅ Migration 003 appliquée' AS status;
