-- 素材图集：一条笔记最多 9 张配图（小红书自身的上限）。
--
-- 在此之前 xhs_materials 只有单个 image_url，而提取接口其实会下载多达 9 张图，
-- 多余的图既不展示也不清理。这一列把整组图存下来，image_url 继续作为封面。
--
-- 应用方式（后端无需重启，代码每 5 分钟会重新探测这一列）：
--   mysql -u root -p broadband < db/migrations/001_add_images.sql
--
-- 未执行本迁移时后端会自动降级为单图模式，不会报错。

ALTER TABLE xhs_materials
  ADD COLUMN images JSON NULL COMMENT '图集，最多 9 张 /api/xhs/uploads/ 路径' AFTER image_url;
