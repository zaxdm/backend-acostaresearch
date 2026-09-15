-- Plan «en prueba»: los correos que son los únicos que lo ven. Nulo = plan
-- normal, que es lo que quedan todos los planes que ya existen.

-- AlterTable
ALTER TABLE `plans` ADD COLUMN `soloPara` VARCHAR(1000) NULL;
