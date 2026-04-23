-- ==========================================
-- Migration 004 : Delivery Priority (Premium first)
-- Date : 2026-04-23
-- Description : Ajoute deliver_at pour priorité Premium (6h delay Free)
-- ==========================================

ALTER TABLE user_notifications
  ADD COLUMN IF NOT EXISTS deliver_at DATETIME NULL COMMENT 'NULL = immédiat (Premium). Sinon délai de livraison (Free).';

CREATE INDEX IF NOT EXISTS idx_deliver_at 
  ON user_notifications (user_id, deliver_at, is_read);

INSERT IGNORE INTO schema_migrations (version, description) 
  VALUES ('004', 'Delivery priority: deliver_at for Premium-first delivery (6h delay for Free)');

SELECT '✅ Migration 004 appliquée' AS status;
