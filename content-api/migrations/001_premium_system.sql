-- ==========================================
-- Migration 001 : Premium System
-- Date : 2026-04-20
-- Description : Ajoute le système freemium
-- ==========================================

-- 1) Colonnes Premium sur users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_premium TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS premium_plan VARCHAR(20) NULL COMMENT 'monthly | yearly | lifetime',
  ADD COLUMN IF NOT EXISTS premium_started_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS premium_expires_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(100) NULL;

-- Index pour perf sur les checks premium
CREATE INDEX IF NOT EXISTS idx_users_premium 
  ON users (is_premium, premium_expires_at);

-- 2) Historique des changements d'abonnement (audit log)
CREATE TABLE IF NOT EXISTS premium_audit_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  action VARCHAR(30) NOT NULL COMMENT 'upgrade | downgrade | renew | expire | cancel | manual_set',
  old_plan VARCHAR(20) NULL,
  new_plan VARCHAR(20) NULL,
  old_expires_at DATETIME NULL,
  new_expires_at DATETIME NULL,
  reason VARCHAR(255) NULL,
  actor VARCHAR(50) NULL COMMENT 'stripe_webhook | admin | user | cron',
  metadata JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_date (user_id, created_at DESC),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 3) Préférences d'alertes Premium
CREATE TABLE IF NOT EXISTS user_alert_preferences (
  user_id INT UNSIGNED PRIMARY KEY,
  alert_genres JSON NULL COMMENT 'Liste de genres préférés',
  alert_platforms JSON NULL COMMENT 'Liste de plateformes préférées',
  reminder_days_before JSON NULL COMMENT '[7, 1, 0] par défaut',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 4) Table de suivi des migrations
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(20) PRIMARY KEY,
  description VARCHAR(255) NOT NULL,
  applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Marquer cette migration comme appliquée
INSERT IGNORE INTO schema_migrations (version, description) 
  VALUES ('001', 'Premium system: flags, audit log, alert preferences');

-- 5) Vérifications
SELECT '✅ Migration 001 appliquée' AS status;
SELECT COUNT(*) AS total_users, SUM(is_premium) AS premium_users FROM users;
SHOW TABLES LIKE '%premium%';
SHOW TABLES LIKE '%alert%';
