-- ==========================================
-- Migration 008 : Email notifications tracking
-- Date : 2026-04-24
-- Description : Track which reminders/alerts also sent an email (anti-doublon)
-- ==========================================

ALTER TABLE reminder_log
  ADD COLUMN IF NOT EXISTS email_sent_at DATETIME NULL COMMENT 'When email was sent (NULL = no email)';

ALTER TABLE alert_log
  ADD COLUMN IF NOT EXISTS email_sent_at DATETIME NULL COMMENT 'When email was sent (NULL = no email)';

INSERT IGNORE INTO schema_migrations (version, description) 
  VALUES ('008', 'Email notifications: track email_sent_at on reminder_log and alert_log');

SELECT '✅ Migration 008 appliquée' AS status;
