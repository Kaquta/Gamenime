-- ==========================================
-- Migration 006 : Password reset tokens
-- Date : 2026-04-23
-- Description : Secure token storage for password reset flow
-- ==========================================

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  token_hash VARCHAR(64) NOT NULL COMMENT 'SHA-256 hash of the token (never store plain)',
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL COMMENT 'Set when token is consumed',
  ip_address VARCHAR(45) NULL COMMENT 'IP that requested reset (audit)',
  user_agent VARCHAR(255) NULL COMMENT 'User-Agent at request time (audit)',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_token_hash (token_hash),
  INDEX idx_user_created (user_id, created_at DESC),
  INDEX idx_expires (expires_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT IGNORE INTO schema_migrations (version, description) 
  VALUES ('006', 'Password reset tokens: secure storage with hash, expiry, audit');

SELECT '✅ Migration 006 appliquée' AS status;
