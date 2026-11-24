-- AlterTable
ALTER TABLE `production_job_orders` ADD COLUMN `closed_at` DATETIME(3) NULL,
    ADD COLUMN `closed_by` CHAR(36) NULL,
    ADD COLUMN `closure_note` VARCHAR(500) NULL,
    ADD COLUMN `closure_override` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `schedule_entries` (
    `id` CHAR(36) NOT NULL,
    `work_order_id` CHAR(36) NOT NULL,
    `wo_process_id` CHAR(36) NOT NULL,
    `machine_id` CHAR(36) NOT NULL,
    `plan_date` DATE NOT NULL,
    `seq` INTEGER NOT NULL,
    `planned_qty` DECIMAL(18, 4) NOT NULL,
    `note` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NOT NULL,
    `updated_by` CHAR(36) NOT NULL,

    INDEX `schedule_entries_plan_date_machine_id_seq_idx`(`plan_date`, `machine_id`, `seq`),
    UNIQUE INDEX `schedule_entries_wo_process_id_machine_id_plan_date_key`(`wo_process_id`, `machine_id`, `plan_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reason_codes` (
    `id` CHAR(36) NOT NULL,
    `category` ENUM('ADDITIONAL_ISSUE', 'REJECT', 'SCRAP') NOT NULL,
    `code` VARCHAR(30) NOT NULL,
    `description` VARCHAR(255) NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NOT NULL,
    `updated_by` CHAR(36) NOT NULL,

    UNIQUE INDEX `reason_codes_category_code_key`(`category`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `material_requisitions` (
    `id` CHAR(36) NOT NULL,
    `mrs_no` VARCHAR(30) NOT NULL,
    `work_order_id` CHAR(36) NOT NULL,
    `status` ENUM('OPEN', 'PARTIALLY_ISSUED', 'ISSUED', 'CLOSED', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
    `remarks` VARCHAR(500) NULL,
    `closed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NOT NULL,
    `updated_by` CHAR(36) NOT NULL,

    UNIQUE INDEX `material_requisitions_mrs_no_key`(`mrs_no`),
    INDEX `material_requisitions_work_order_id_idx`(`work_order_id`),
    INDEX `material_requisitions_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `mrs_lines` (
    `id` CHAR(36) NOT NULL,
    `mrs_id` CHAR(36) NOT NULL,
    `line_no` INTEGER NOT NULL,
    `son_code_id` CHAR(36) NULL,
    `material_id` CHAR(36) NOT NULL,
    `material_code` VARCHAR(40) NOT NULL,
    `material_description` VARCHAR(255) NOT NULL,
    `uom` VARCHAR(10) NOT NULL,
    `requested_qty` DECIMAL(18, 4) NOT NULL,
    `issued_qty` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `additional_qty` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `returned_qty` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `rejected_qty` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `scrapped_qty` DECIMAL(18, 4) NOT NULL DEFAULT 0,

    INDEX `mrs_lines_material_id_idx`(`material_id`),
    UNIQUE INDEX `mrs_lines_mrs_id_line_no_key`(`mrs_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `material_transactions` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `txn_no` VARCHAR(30) NOT NULL,
    `type` ENUM('ISSUE', 'ADDITIONAL_ISSUE', 'RETURN', 'REJECT', 'SCRAP') NOT NULL,
    `mrs_id` CHAR(36) NOT NULL,
    `mrs_line_id` CHAR(36) NOT NULL,
    `work_order_id` CHAR(36) NOT NULL,
    `material_id` CHAR(36) NOT NULL,
    `qty` DECIMAL(18, 4) NOT NULL,
    `uom` VARCHAR(10) NOT NULL,
    `lot_ref` VARCHAR(80) NULL,
    `reason_code_id` CHAR(36) NULL,
    `machine_id` CHAR(36) NULL,
    `wo_process_id` CHAR(36) NULL,
    `remarks` VARCHAR(500) NULL,
    `created_by` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `material_transactions_txn_no_key`(`txn_no`),
    INDEX `material_transactions_mrs_id_idx`(`mrs_id`),
    INDEX `material_transactions_work_order_id_idx`(`work_order_id`),
    INDEX `material_transactions_type_created_at_idx`(`type`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `schedule_entries` ADD CONSTRAINT `schedule_entries_work_order_id_fkey` FOREIGN KEY (`work_order_id`) REFERENCES `work_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `schedule_entries` ADD CONSTRAINT `schedule_entries_wo_process_id_fkey` FOREIGN KEY (`wo_process_id`) REFERENCES `work_order_processes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `schedule_entries` ADD CONSTRAINT `schedule_entries_machine_id_fkey` FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_requisitions` ADD CONSTRAINT `material_requisitions_work_order_id_fkey` FOREIGN KEY (`work_order_id`) REFERENCES `work_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `mrs_lines` ADD CONSTRAINT `mrs_lines_mrs_id_fkey` FOREIGN KEY (`mrs_id`) REFERENCES `material_requisitions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `mrs_lines` ADD CONSTRAINT `mrs_lines_material_id_fkey` FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `mrs_lines` ADD CONSTRAINT `mrs_lines_son_code_id_fkey` FOREIGN KEY (`son_code_id`) REFERENCES `bom_son_codes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_transactions` ADD CONSTRAINT `material_transactions_mrs_id_fkey` FOREIGN KEY (`mrs_id`) REFERENCES `material_requisitions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_transactions` ADD CONSTRAINT `material_transactions_mrs_line_id_fkey` FOREIGN KEY (`mrs_line_id`) REFERENCES `mrs_lines`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_transactions` ADD CONSTRAINT `material_transactions_material_id_fkey` FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_transactions` ADD CONSTRAINT `material_transactions_reason_code_id_fkey` FOREIGN KEY (`reason_code_id`) REFERENCES `reason_codes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Material transactions are stock movements: corrections are new transactions, never edits.
CREATE TRIGGER material_transactions_no_update BEFORE UPDATE ON material_transactions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'material_transactions is append-only';

CREATE TRIGGER material_transactions_no_delete BEFORE DELETE ON material_transactions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'material_transactions is append-only';

-- Requisitions and their lines are history: closed or cancelled, never deleted.
CREATE TRIGGER material_requisitions_no_delete BEFORE DELETE ON material_requisitions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'material_requisitions are never deleted';

CREATE TRIGGER mrs_lines_no_delete BEFORE DELETE ON mrs_lines
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'mrs_lines are never deleted';
