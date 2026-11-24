-- Part Category / Part Group / Part Master fields, Die Cut Master.
-- The old free-text materials.category becomes Part Category rows (kind OTHER).

-- CreateTable
CREATE TABLE `part_categories` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `kind` ENUM('LABEL_STOCK', 'FILM', 'PAPER', 'LAMINATE', 'ADHESIVE', 'INK', 'VARNISH', 'FOIL', 'RIBBON', 'CORE', 'PLATE', 'PACKAGING', 'OTHER') NOT NULL DEFAULT 'OTHER',
    `description` VARCHAR(255) NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    UNIQUE INDEX `part_categories_code_key`(`code`),
    UNIQUE INDEX `part_categories_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `part_groups` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `category_id` CHAR(36) NOT NULL,
    `description` VARCHAR(255) NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    UNIQUE INDEX `part_groups_code_key`(`code`),
    UNIQUE INDEX `part_groups_category_id_name_key`(`category_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `die_cuts` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(30) NOT NULL,
    `description` VARCHAR(255) NOT NULL,
    `die_type` ENUM('ROTARY_SOLID', 'FLEXIBLE', 'FLATBED') NOT NULL,
    `cut_type` ENUM('KISS_CUT', 'THROUGH_CUT', 'PERFORATION') NOT NULL DEFAULT 'KISS_CUT',
    `shape` ENUM('RECTANGLE', 'ROUNDED_RECTANGLE', 'CIRCLE', 'OVAL', 'SPECIAL') NOT NULL DEFAULT 'RECTANGLE',
    `label_width_mm` DECIMAL(10, 2) NOT NULL,
    `label_height_mm` DECIMAL(10, 2) NOT NULL,
    `corner_radius_mm` DECIMAL(6, 2) NULL,
    `across` INTEGER NOT NULL,
    `around` INTEGER NOT NULL DEFAULT 1,
    `gap_across_mm` DECIMAL(6, 2) NULL,
    `gap_around_mm` DECIMAL(6, 2) NULL,
    `gear_teeth` INTEGER NULL,
    `repeat_mm` DECIMAL(8, 3) NULL,
    `condition` ENUM('GOOD', 'WORN', 'DAMAGED') NOT NULL DEFAULT 'GOOD',
    `location` VARCHAR(60) NULL,
    `supplier_name` VARCHAR(120) NULL,
    `remarks` VARCHAR(500) NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    UNIQUE INDEX `die_cuts_code_key`(`code`),
    INDEX `die_cuts_label_width_mm_label_height_mm_idx`(`label_width_mm`, `label_height_mm`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- (tables above)

-- AlterTable
ALTER TABLE `materials` ADD COLUMN `adhesive` VARCHAR(80) NULL,
    ADD COLUMN `category_id` CHAR(36) NULL,
    ADD COLUMN `certifications` VARCHAR(120) NULL,
    ADD COLUMN `colour` VARCHAR(60) NULL,
    ADD COLUMN `core_id_mm` DECIMAL(6, 1) NULL,
    ADD COLUMN `face_finish` VARCHAR(80) NULL,
    ADD COLUMN `group_id` CHAR(36) NULL,
    ADD COLUMN `gsm` DECIMAL(8, 1) NULL,
    ADD COLUMN `length_m` DECIMAL(12, 2) NULL,
    ADD COLUMN `liner` VARCHAR(80) NULL,
    ADD COLUMN `shelf_life_days` INTEGER NULL,
    ADD COLUMN `stock_form` ENUM('ROLL', 'SHEET', 'FANFOLD', 'UNIT') NULL,
    ADD COLUMN `supplier_name` VARCHAR(120) NULL,
    ADD COLUMN `supplier_part_no` VARCHAR(60) NULL,
    ADD COLUMN `system` VARCHAR(40) NULL,
    ADD COLUMN `thickness_micron` DECIMAL(8, 1) NULL,
    ADD COLUMN `width_mm` DECIMAL(10, 2) NULL;

-- Old free-text categories -> Part Category rows, then link the parts.
INSERT INTO `part_categories` (`id`, `code`, `name`, `kind`, `updated_at`)
SELECT UUID(), CONCAT('CAT-', LPAD(ROW_NUMBER() OVER (ORDER BY c.category), 3, '0')), c.category, 'OTHER', CURRENT_TIMESTAMP(3)
FROM (SELECT DISTINCT TRIM(`category`) AS category FROM `materials` WHERE `category` IS NOT NULL AND TRIM(`category`) <> '') c;
UPDATE `materials` m JOIN `part_categories` pc ON pc.`name` = TRIM(m.`category`) SET m.`category_id` = pc.`id`;
ALTER TABLE `materials` DROP COLUMN `category`;

-- CreateIndex
CREATE INDEX `materials_category_id_idx` ON `materials`(`category_id`);

-- CreateIndex
CREATE INDEX `materials_group_id_idx` ON `materials`(`group_id`);

-- AddForeignKey
ALTER TABLE `part_groups` ADD CONSTRAINT `part_groups_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `part_categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `materials` ADD CONSTRAINT `materials_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `part_categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `materials` ADD CONSTRAINT `materials_group_id_fkey` FOREIGN KEY (`group_id`) REFERENCES `part_groups`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

