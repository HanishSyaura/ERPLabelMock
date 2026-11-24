-- AlterTable
ALTER TABLE `production_job_orders` ADD COLUMN `master_card_revision_id` CHAR(36) NULL,
    ADD COLUMN `product_id` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `products` (
    `id` CHAR(36) NOT NULL,
    `product_code` VARCHAR(40) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `customer_name` VARCHAR(200) NULL,
    `customer_part_no` VARCHAR(80) NULL,
    `uom` VARCHAR(10) NOT NULL,
    `bom_id` CHAR(36) NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `current_card_rev_no` INTEGER NOT NULL DEFAULT 0,
    `remarks` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NOT NULL,
    `updated_by` CHAR(36) NOT NULL,

    UNIQUE INDEX `products_product_code_key`(`product_code`),
    UNIQUE INDEX `products_bom_id_key`(`bom_id`),
    INDEX `products_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `master_card_revisions` (
    `id` CHAR(36) NOT NULL,
    `product_id` CHAR(36) NOT NULL,
    `revision_no` INTEGER NOT NULL,
    `status` ENUM('DRAFT', 'RELEASED', 'SUPERSEDED') NOT NULL DEFAULT 'DRAFT',
    `artwork_revision_id` CHAR(36) NOT NULL,
    `component_revision_id` CHAR(36) NULL,
    `routine_id` CHAR(36) NULL,
    `spec` JSON NOT NULL,
    `change_note` VARCHAR(500) NULL,
    `created_by` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `released_by` CHAR(36) NULL,
    `released_at` DATETIME(3) NULL,
    `superseded_at` DATETIME(3) NULL,

    INDEX `master_card_revisions_product_id_status_idx`(`product_id`, `status`),
    UNIQUE INDEX `master_card_revisions_product_id_revision_no_key`(`product_id`, `revision_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `production_job_orders` ADD CONSTRAINT `production_job_orders_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_job_orders` ADD CONSTRAINT `production_job_orders_master_card_revision_id_fkey` FOREIGN KEY (`master_card_revision_id`) REFERENCES `master_card_revisions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_bom_id_fkey` FOREIGN KEY (`bom_id`) REFERENCES `boms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `master_card_revisions` ADD CONSTRAINT `master_card_revisions_product_id_fkey` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `master_card_revisions` ADD CONSTRAINT `master_card_revisions_artwork_revision_id_fkey` FOREIGN KEY (`artwork_revision_id`) REFERENCES `bom_artwork_revisions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `master_card_revisions` ADD CONSTRAINT `master_card_revisions_component_revision_id_fkey` FOREIGN KEY (`component_revision_id`) REFERENCES `bom_component_revisions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `master_card_revisions` ADD CONSTRAINT `master_card_revisions_routine_id_fkey` FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Released and superseded Master Card revisions never change. A released one
-- may only move to SUPERSEDED (status and its timestamp); nothing leaves SUPERSEDED.
CREATE TRIGGER master_card_revisions_frozen BEFORE UPDATE ON master_card_revisions
FOR EACH ROW
BEGIN
  IF OLD.status <> 'DRAFT' AND (
       NOT (OLD.artwork_revision_id <=> NEW.artwork_revision_id)
    OR NOT (OLD.component_revision_id <=> NEW.component_revision_id)
    OR NOT (OLD.routine_id <=> NEW.routine_id)
    OR NOT (OLD.spec <=> NEW.spec)
    OR NOT (OLD.revision_no <=> NEW.revision_no)
    OR NOT (OLD.product_id <=> NEW.product_id)
    OR NOT (OLD.change_note <=> NEW.change_note)
    OR (OLD.status = 'SUPERSEDED' AND NOT (NEW.status <=> 'SUPERSEDED'))
    OR (OLD.status = 'RELEASED' AND NEW.status = 'DRAFT')
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'released Master Card revisions are immutable';
  END IF;
END;

CREATE TRIGGER master_card_revisions_no_delete BEFORE DELETE ON master_card_revisions
FOR EACH ROW
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'released Master Card revisions are never deleted';
  END IF;
END;

-- Products are deactivated, never deleted.
CREATE TRIGGER products_no_delete BEFORE DELETE ON products
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'products are never deleted';
