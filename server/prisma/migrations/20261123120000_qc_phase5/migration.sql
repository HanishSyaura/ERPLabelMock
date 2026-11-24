-- CreateTable
CREATE TABLE `defect_codes` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `category` ENUM('PRINT', 'COLOUR', 'REGISTRATION', 'DIE_CUT', 'MATERIAL', 'ADHESIVE', 'LAMINATION', 'SLITTING', 'WINDING', 'CONTAMINATION', 'PACKAGING', 'OTHER') NOT NULL,
    `severity` ENUM('MINOR', 'MAJOR', 'CRITICAL') NOT NULL DEFAULT 'MAJOR',
    `applies_iqc` BOOLEAN NOT NULL DEFAULT true,
    `applies_oqc` BOOLEAN NOT NULL DEFAULT true,
    `description` VARCHAR(255) NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    UNIQUE INDEX `defect_codes_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspection_templates` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `type` ENUM('IQC', 'OQC') NOT NULL,
    `part_category_id` CHAR(36) NULL,
    `items` JSON NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    UNIQUE INDEX `inspection_templates_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `qc_inspections` (
    `id` CHAR(36) NOT NULL,
    `insp_no` VARCHAR(30) NOT NULL,
    `type` ENUM('IQC', 'OQC') NOT NULL,
    `status` ENUM('IN_INSPECTION', 'PASSED', 'PENDING_DISPOSITION', 'ACCEPTED', 'REJECTED', 'REWORK', 'RETURNED') NOT NULL DEFAULT 'IN_INSPECTION',
    `template_id` CHAR(36) NULL,
    `checks` JSON NOT NULL,
    `material_id` CHAR(36) NULL,
    `lot_ref` VARCHAR(60) NULL,
    `supplier_name` VARCHAR(120) NULL,
    `delivery_ref` VARCHAR(60) NULL,
    `work_order_id` CHAR(36) NULL,
    `reinspection_of_id` CHAR(36) NULL,
    `qty` DECIMAL(18, 4) NOT NULL,
    `uom` VARCHAR(10) NOT NULL,
    `sample_size` DECIMAL(18, 4) NULL,
    `good_qty` DECIMAL(18, 4) NULL,
    `reject_qty` DECIMAL(18, 4) NULL,
    `result` ENUM('PASS', 'FAIL') NULL,
    `remarks` VARCHAR(500) NULL,
    `checked_in_at` DATETIME(3) NOT NULL,
    `checked_in_by` CHAR(36) NOT NULL,
    `checked_out_at` DATETIME(3) NULL,
    `checked_out_by` CHAR(36) NULL,
    `disposition` ENUM('USE_AS_IS', 'REJECT', 'REWORK', 'RETURN_TO_SUPPLIER') NULL,
    `disposition_note` VARCHAR(500) NULL,
    `disposition_at` DATETIME(3) NULL,
    `disposition_by` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `qc_inspections_insp_no_key`(`insp_no`),
    UNIQUE INDEX `qc_inspections_reinspection_of_id_key`(`reinspection_of_id`),
    INDEX `qc_inspections_type_status_idx`(`type`, `status`),
    INDEX `qc_inspections_material_id_lot_ref_idx`(`material_id`, `lot_ref`),
    INDEX `qc_inspections_work_order_id_idx`(`work_order_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `qc_defects` (
    `id` CHAR(36) NOT NULL,
    `inspection_id` CHAR(36) NOT NULL,
    `defect_code_id` CHAR(36) NOT NULL,
    `qty` DECIMAL(18, 4) NOT NULL,
    `remark` VARCHAR(255) NULL,

    INDEX `qc_defects_inspection_id_idx`(`inspection_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `label_templates` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `width_mm` INTEGER NOT NULL,
    `height_mm` INTEGER NOT NULL,
    `fields` JSON NOT NULL,
    `barcode` ENUM('CODE128', 'QR') NOT NULL DEFAULT 'CODE128',
    `barcode_field` VARCHAR(30) NOT NULL DEFAULT 'labelNo',
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    UNIQUE INDEX `label_templates_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipping_labels` (
    `id` CHAR(36) NOT NULL,
    `label_no` VARCHAR(30) NOT NULL,
    `inspection_id` CHAR(36) NOT NULL,
    `template_id` CHAR(36) NOT NULL,
    `carton_no` INTEGER NOT NULL,
    `carton_count` INTEGER NOT NULL,
    `qty` DECIMAL(18, 4) NOT NULL,
    `uom` VARCHAR(10) NOT NULL,
    `data` JSON NOT NULL,
    `status` ENUM('ACTIVE', 'VOID') NOT NULL DEFAULT 'ACTIVE',
    `print_count` INTEGER NOT NULL DEFAULT 0,
    `last_printed_at` DATETIME(3) NULL,
    `void_reason` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` CHAR(36) NOT NULL,

    UNIQUE INDEX `shipping_labels_label_no_key`(`label_no`),
    INDEX `shipping_labels_inspection_id_idx`(`inspection_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `inspection_templates` ADD CONSTRAINT `inspection_templates_part_category_id_fkey` FOREIGN KEY (`part_category_id`) REFERENCES `part_categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `qc_inspections` ADD CONSTRAINT `qc_inspections_template_id_fkey` FOREIGN KEY (`template_id`) REFERENCES `inspection_templates`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `qc_inspections` ADD CONSTRAINT `qc_inspections_material_id_fkey` FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `qc_inspections` ADD CONSTRAINT `qc_inspections_work_order_id_fkey` FOREIGN KEY (`work_order_id`) REFERENCES `work_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `qc_inspections` ADD CONSTRAINT `qc_inspections_reinspection_of_id_fkey` FOREIGN KEY (`reinspection_of_id`) REFERENCES `qc_inspections`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `qc_defects` ADD CONSTRAINT `qc_defects_inspection_id_fkey` FOREIGN KEY (`inspection_id`) REFERENCES `qc_inspections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `qc_defects` ADD CONSTRAINT `qc_defects_defect_code_id_fkey` FOREIGN KEY (`defect_code_id`) REFERENCES `defect_codes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `shipping_labels` ADD CONSTRAINT `shipping_labels_inspection_id_fkey` FOREIGN KEY (`inspection_id`) REFERENCES `qc_inspections`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `shipping_labels` ADD CONSTRAINT `shipping_labels_template_id_fkey` FOREIGN KEY (`template_id`) REFERENCES `label_templates`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

