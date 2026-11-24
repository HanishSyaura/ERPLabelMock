-- CreateTable
CREATE TABLE `document_templates` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `doc_type` ENUM('PJO', 'JOB_ORDER', 'MRS', 'MASTER_CARD', 'IQC_REPORT', 'OQC_REPORT') NOT NULL,
    `is_default` BOOLEAN NOT NULL DEFAULT false,
    `layout` JSON NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    UNIQUE INDEX `document_templates_code_key`(`code`),
    INDEX `document_templates_doc_type_status_idx`(`doc_type`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `document_settings` (
    `id` VARCHAR(20) NOT NULL,
    `company_name` VARCHAR(160) NOT NULL,
    `registration_no` VARCHAR(60) NULL,
    `address` VARCHAR(500) NULL,
    `phone` VARCHAR(60) NULL,
    `email` VARCHAR(120) NULL,
    `website` VARCHAR(120) NULL,
    `logo` MEDIUMTEXT NULL,
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by` CHAR(36) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

