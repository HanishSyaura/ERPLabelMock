-- AlterTable
ALTER TABLE `materials` ADD COLUMN `bom_id` CHAR(36) NULL,
    ADD COLUMN `cartons_per_pallet` INTEGER NULL,
    ADD COLUMN `control_point` VARCHAR(60) NULL,
    ADD COLUMN `custom_code` VARCHAR(30) NULL,
    ADD COLUMN `decision_cost` DECIMAL(18, 4) NULL,
    ADD COLUMN `image_file_id` CHAR(36) NULL,
    ADD COLUMN `lead_time_days` INTEGER NULL,
    ADD COLUMN `material_type` VARCHAR(60) NULL,
    ADD COLUMN `max_qty` DECIMAL(18, 4) NULL,
    ADD COLUMN `measure_h_mm` DECIMAL(10, 2) NULL,
    ADD COLUMN `measure_l_mm` DECIMAL(10, 2) NULL,
    ADD COLUMN `measure_w_mm` DECIMAL(10, 2) NULL,
    ADD COLUMN `nmi_no` VARCHAR(40) NULL,
    ADD COLUMN `obsolete` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `obsolete_at` DATETIME(3) NULL,
    ADD COLUMN `obsolete_by` CHAR(36) NULL,
    ADD COLUMN `over_receive_pct` DECIMAL(5, 2) NULL,
    ADD COLUMN `pack_qty` DECIMAL(18, 4) NULL,
    ADD COLUMN `part_type` ENUM('RAW_MATERIAL', 'FINISHED_GOOD', 'SEMI_FINISHED', 'PACKAGING', 'CONSUMABLE') NOT NULL DEFAULT 'RAW_MATERIAL',
    ADD COLUMN `pcs_per_roll` DECIMAL(18, 4) NULL,
    ADD COLUMN `reorder_level` DECIMAL(18, 4) NULL,
    ADD COLUMN `reorder_qty` DECIMAL(18, 4) NULL,
    ADD COLUMN `require_iqc` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `revised_at` DATETIME(3) NULL,
    ADD COLUMN `revision_no` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `source` VARCHAR(40) NULL,
    ADD COLUMN `specification` VARCHAR(1000) NULL,
    ADD COLUMN `tariff_code` VARCHAR(30) NULL;

-- AlterTable
ALTER TABLE `products` ADD COLUMN `part_id` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `part_uom_conversions` (
    `id` CHAR(36) NOT NULL,
    `part_id` CHAR(36) NOT NULL,
    `uom` VARCHAR(10) NOT NULL,
    `factor` DECIMAL(18, 6) NOT NULL,
    `remark` VARCHAR(120) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `part_uom_conversions_part_id_uom_key`(`part_id`, `uom`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `part_locations` (
    `id` CHAR(36) NOT NULL,
    `part_id` CHAR(36) NOT NULL,
    `warehouse_code` VARCHAR(20) NOT NULL,
    `location_code` VARCHAR(30) NOT NULL,
    `shelf_location` VARCHAR(30) NULL,
    `lot_no` VARCHAR(60) NULL,
    `do_hold_qty` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `qty` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` CHAR(36) NOT NULL,

    INDEX `part_locations_part_id_idx`(`part_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `materials_bom_id_key` ON `materials`(`bom_id`);

-- CreateIndex
CREATE UNIQUE INDEX `materials_nmi_no_key` ON `materials`(`nmi_no`);

-- CreateIndex
CREATE INDEX `materials_part_type_idx` ON `materials`(`part_type`);

-- CreateIndex
-- Existing products become finished-good parts (same code), then link.
INSERT INTO `materials` (`id`, `code`, `description`, `uom`, `part_type`, `bom_id`, `status`, `created_at`, `updated_at`, `created_by`, `updated_by`)
SELECT UUID(), p.`product_code`, p.`name`, p.`uom`, 'FINISHED_GOOD', p.`bom_id`, p.`status`, p.`created_at`, CURRENT_TIMESTAMP(3), p.`created_by`, p.`updated_by`
FROM `products` p WHERE NOT EXISTS (SELECT 1 FROM `materials` m WHERE m.`code` = p.`product_code`);
UPDATE `materials` m JOIN `products` p ON p.`product_code` = m.`code` SET m.`part_type` = 'FINISHED_GOOD', m.`bom_id` = p.`bom_id` WHERE m.`bom_id` IS NULL;
UPDATE `products` p JOIN `materials` m ON m.`code` = p.`product_code` SET p.`part_id` = m.`id`;
ALTER TABLE `products` MODIFY `part_id` CHAR(36) NOT NULL;

CREATE UNIQUE INDEX `products_part_id_key` ON `products`(`part_id`);

-- AddForeignKey
ALTER TABLE `materials` ADD CONSTRAINT `materials_bom_id_fkey` FOREIGN KEY (`bom_id`) REFERENCES `boms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `materials` ADD CONSTRAINT `materials_image_file_id_fkey` FOREIGN KEY (`image_file_id`) REFERENCES `stored_files`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `part_uom_conversions` ADD CONSTRAINT `part_uom_conversions_part_id_fkey` FOREIGN KEY (`part_id`) REFERENCES `materials`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `part_locations` ADD CONSTRAINT `part_locations_part_id_fkey` FOREIGN KEY (`part_id`) REFERENCES `materials`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_part_id_fkey` FOREIGN KEY (`part_id`) REFERENCES `materials`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

