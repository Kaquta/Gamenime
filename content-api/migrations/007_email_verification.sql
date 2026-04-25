-- ==========================================
-- Migration 007 : Email verification
-- Date : 2026-04-23
-- Description : Track email verification status + tokens
-- ==========================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 if email confirmed via link',
  ADD COLUMN IF NOT EXISTS email_verified_at DATETIME NULL COMMENT 'When the email was confirmed';

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  token_hash VARCHAR(64) NOT NULL COMMENT 'SHA-256 hash of the token',
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_token_hash (token_hash),
  INDEX idx_user_created (user_id, created_at DESC),
  INDEX idx_expires (expires_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT IGNORE INTO schema_migrations (version, description) 
  VALUES ('007', 'Email verification: users.email_verified + verification tokens table');

SELECT '✅ Migration 007 appliquée' AS status;
