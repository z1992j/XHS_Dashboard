-- 自定义模板云端化。
--
-- 之前模板只存在浏览器 localStorage 里：清一次站点数据、换一台设备，
-- 用户攒下来的模板就全没了。这张表让它变成可迁移的资产。
--
-- id 沿用前端生成的 custom_<timestamp>，两边同一个 id，不需要做映射。
-- 前端仍把 localStorage 当渲染缓存，这张表是持久副本。
--
-- 应用方式（后端无需重启，代码每 5 分钟会重新探测这张表）：
--   mysql -u root -p broadband < db/migrations/003_add_templates.sql
--
-- 未执行本迁移时模板依旧只存本地，功能可用，只是不会同步。

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
