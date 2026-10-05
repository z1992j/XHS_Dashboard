-- 风格画像缓存：从素材库蒸馏出的写作风格特征。
--
-- 单行表（id 恒为 1）。之所以不每次生成时现算：蒸馏要读几十篇文案并调一次
-- 大模型，成本远高于一次普通生成，而风格本身变化很慢。
--
-- profile 是人可读的 JSON，用户可以在设置页直接看到并手工修改 ——
-- 比让人对着黑盒抱怨"生成的不像我"要好得多。
--
-- 应用方式（后端无需重启，代码每 5 分钟会重新探测这张表）：
--   mysql -u root -p broadband < db/migrations/002_add_style_profile.sql
--
-- 未执行本迁移时，风格画像无法缓存，「我的风格」会退回到直接用样例的方案，
-- 不会报错。

CREATE TABLE IF NOT EXISTS xhs_style_profile (
  id TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '单行表，恒为 1',
  profile JSON NOT NULL COMMENT '风格特征，人可读可编辑',
  sample_count INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '蒸馏时读了多少篇；手工覆盖时为 0',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
