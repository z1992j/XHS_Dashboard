-- 红薯助手 数据库结构
-- 导出依据：apps/server/src/xhs-writer.js 全部 SQL 语句反推
-- 使用：mysql -u root -p broadband < db/schema.sql

CREATE DATABASE IF NOT EXISTS broadband DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE broadband;

-- 素材表
CREATE TABLE IF NOT EXISTS xhs_materials (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  tags JSON NULL,
  image_url VARCHAR(512) NULL COMMENT '封面图，等于 images[0]',
  images JSON NULL COMMENT '图集，最多 9 张 /api/xhs/uploads/ 路径',
  image_data MEDIUMTEXT NULL COMMENT '历史遗留 base64 字段，新数据不再写入',
  prompt TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 仿写历史表
CREATE TABLE IF NOT EXISTS xhs_rewrite_history (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  prompt TEXT NOT NULL,
  source_url VARCHAR(1024) NULL,
  results JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 风格画像（单行表），详见 db/migrations/002_add_style_profile.sql
CREATE TABLE IF NOT EXISTS xhs_style_profile (
  id TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '单行表，恒为 1',
  profile JSON NOT NULL COMMENT '风格特征，人可读可编辑',
  sample_count INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '蒸馏时读了多少篇；手工覆盖时为 0',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 自定义模板（云端副本），详见 db/migrations/003_add_templates.sql
CREATE TABLE IF NOT EXISTS xhs_templates (
  id VARCHAR(64) NOT NULL COMMENT '与前端一致的 custom_<timestamp>',
  name VARCHAR(60) NOT NULL,
  icon VARCHAR(8) NULL DEFAULT '📝',
  description VARCHAR(200) NULL,
  system_prompt TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
