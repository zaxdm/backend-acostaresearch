-- Cuántas veces se vació cada proyecto con «empezar de cero». Todos empiezan
-- en cero: los reinicios de antes no se contaban.

-- AlterTable
ALTER TABLE `projects` ADD COLUMN `reinicios` INTEGER NOT NULL DEFAULT 0;
