-- ==========================================
-- Migration 002 : Reminder System
-- Date : 2026-04-21
-- Description : Table de log des rappels pour éviter doublons
-- ==========================================

CREATE TABLE IF NOT EXISTS reminder_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  item_type ENUM('anime', 'game') NOT NULL,
  item_id INT NOT NULL,
  day_offset INT NOT NULL COMMENT '7 = J-7, 1 = J-1, 0 = jour J',
  release_date DATE NOT NULL,
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_reminder (user_id, item_type, item_id, day_offset),
  INDEX idx_user_sent (user_id, sent_at DESC),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT IGNORE INTO schema_migrations (version, description) 
  VALUES ('002', 'Reminder system: log table for J-7/J-1/J0 reminders');

SELECT '✅ Migration 002 appliquée' AS status;
