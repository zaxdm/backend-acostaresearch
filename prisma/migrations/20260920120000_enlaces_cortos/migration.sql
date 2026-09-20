-- Enlaces cortos para los que reparte el conector.
--
-- El asistente tiene que reproducir en la conversación un JWT de unos 400
-- caracteres, y el 20-sep-2026 se comprobó que ChatGPT no lo copia: lo vuelve a
-- escribir y se equivoca en uno. Con ocho caracteres no se equivoca.
--
-- El destino se guarda entero, con su token dentro, para que sirva a los nueve
-- enlaces del conector sin saber de qué tipo es cada uno.
--
-- Las filas caducadas NO se borran al vencer: se quedan para poder decirle al
-- tesista «venció» en vez de «llegó incompleto», que no es lo mismo.

-- CreateTable
CREATE TABLE `enlaces_cortos` (
    `codigo` VARCHAR(16) NOT NULL,
    `destino` VARCHAR(2000) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `enlaces_cortos_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`codigo`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
