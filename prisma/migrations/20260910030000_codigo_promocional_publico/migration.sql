-- Qué códigos se anuncian en la página de precios.
--
-- Hasta ahora todos los códigos eran iguales: uno de campaña que se reparte en
-- TikTok y uno negociado con una persona concreta se guardaban igual y se
-- resolvían igual. Enseñarlos todos en la web filtraría los segundos, así que
-- hace falta que el administrador lo diga expresamente.
--
-- Por defecto NO. Un código nace privado y se publica a propósito: al revés,
-- cualquier código creado con prisa acabaría en la portada.

ALTER TABLE `discount_codes`
  ADD COLUMN `publico` BOOLEAN NOT NULL DEFAULT false;

-- Los dos de TikTok, que son los que se querían anunciar. Se hace aquí y no a
-- mano para que el despliegue los deje ya publicados; cualquier otro se marca
-- desde el panel.
UPDATE `discount_codes` SET `publico` = true WHERE `code` IN ('TESIS11', 'ARTICULO10');
