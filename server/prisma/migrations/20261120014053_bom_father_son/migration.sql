-- CreateTable
CREATE TABLE `stored_files` (
    `id` CHAR(36) NOT NULL,
    `purpose` VARCHAR(20) NOT NULL,
    `original_name` VARCHAR(255) NOT NULL,
    `extension` VARCHAR(10) NOT NULL,
    `mime_type` VARCHAR(100) NOT NULL,
    `size_bytes` INTEGER NOT NULL,
    `sha256` CHAR(64) NOT NULL,
    `storage_key` VARCHAR(100) NOT NULL,
    `thumbnail_key` VARCHAR(100) NULL,
    `preview_kind` VARCHAR(10) NOT NULL,
    `uploaded_by` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `attached_at` DATETIME(3) NULL,

    UNIQUE INDEX `stored_files_storage_key_key`(`storage_key`),
    INDEX `stored_files_sha256_idx`(`sha256`),
    INDEX `stored_files_original_name_idx`(`original_name`),
    INDEX `stored_files_attached_at_created_at_idx`(`attached_at`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `materials` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `description` VARCHAR(255) NOT NULL,
    `uom` VARCHAR(10) NOT NULL,
    `category` VARCHAR(60) NULL,
    `remarks` VARCHAR(500) NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    UNIQUE INDEX `materials_code_key`(`code`),
    INDEX `materials_description_idx`(`description`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `boms` (
    `id` CHAR(36) NOT NULL,
    `father_code` VARCHAR(30) NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `label_description` VARCHAR(500) NOT NULL,
    `description_key` VARCHAR(500) NOT NULL,
    `current_artwork_rev_no` INTEGER NOT NULL,
    `current_component_rev_no` INTEGER NOT NULL DEFAULT 0,
    `next_son_seq` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NOT NULL,
    `updated_by` CHAR(36) NOT NULL,

    UNIQUE INDEX `boms_father_code_key`(`father_code`),
    INDEX `boms_description_key_idx`(`description_key`),
    INDEX `boms_status_updated_at_idx`(`status`, `updated_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bom_artwork_revisions` (
    `id` CHAR(36) NOT NULL,
    `bom_id` CHAR(36) NOT NULL,
    `revision_no` INTEGER NOT NULL,
    `label_description` VARCHAR(500) NOT NULL,
    `file_id` CHAR(36) NOT NULL,
    `change_type` VARCHAR(30) NOT NULL,
    `change_note` VARCHAR(500) NULL,
    `restored_from_revision_no` INTEGER NULL,
    `created_by` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `bom_artwork_revisions_file_id_idx`(`file_id`),
    UNIQUE INDEX `bom_artwork_revisions_bom_id_revision_no_key`(`bom_id`, `revision_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bom_son_codes` (
    `id` CHAR(36) NOT NULL,
    `bom_id` CHAR(36) NOT NULL,
    `son_code` VARCHAR(40) NOT NULL,
    `seq` INTEGER NOT NULL,
    `material_id` CHAR(36) NOT NULL,
    `status` ENUM('ACTIVE', 'REMOVED') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` CHAR(36) NOT NULL,
    `removed_at` DATETIME(3) NULL,
    `removed_by` CHAR(36) NULL,

    UNIQUE INDEX `bom_son_codes_son_code_key`(`son_code`),
    UNIQUE INDEX `bom_son_codes_bom_id_seq_key`(`bom_id`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bom_component_revisions` (
    `id` CHAR(36) NOT NULL,
    `bom_id` CHAR(36) NOT NULL,
    `revision_no` INTEGER NOT NULL,
    `change_type` VARCHAR(30) NOT NULL,
    `changes` JSON NOT NULL,
    `change_note` VARCHAR(500) NULL,
    `restored_from_revision_no` INTEGER NULL,
    `created_by` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `bom_component_revisions_bom_id_revision_no_key`(`bom_id`, `revision_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bom_component_lines` (
    `id` CHAR(36) NOT NULL,
    `revision_id` CHAR(36) NOT NULL,
    `son_code_id` CHAR(36) NOT NULL,
    `line_no` INTEGER NOT NULL,
    `material_id` CHAR(36) NOT NULL,
    `material_code` VARCHAR(40) NOT NULL,
    `material_description` VARCHAR(255) NOT NULL,
    `quantity` DECIMAL(18, 4) NULL,
    `uom` VARCHAR(10) NULL,
    `remarks` VARCHAR(500) NULL,

    INDEX `bom_component_lines_son_code_id_idx`(`son_code_id`),
    INDEX `bom_component_lines_material_id_idx`(`material_id`),
    UNIQUE INDEX `bom_component_lines_revision_id_son_code_id_key`(`revision_id`, `son_code_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `bom_artwork_revisions` ADD CONSTRAINT `bom_artwork_revisions_bom_id_fkey` FOREIGN KEY (`bom_id`) REFERENCES `boms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bom_artwork_revisions` ADD CONSTRAINT `bom_artwork_revisions_file_id_fkey` FOREIGN KEY (`file_id`) REFERENCES `stored_files`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bom_son_codes` ADD CONSTRAINT `bom_son_codes_bom_id_fkey` FOREIGN KEY (`bom_id`) REFERENCES `boms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bom_son_codes` ADD CONSTRAINT `bom_son_codes_material_id_fkey` FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bom_component_revisions` ADD CONSTRAINT `bom_component_revisions_bom_id_fkey` FOREIGN KEY (`bom_id`) REFERENCES `boms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bom_component_lines` ADD CONSTRAINT `bom_component_lines_revision_id_fkey` FOREIGN KEY (`revision_id`) REFERENCES `bom_component_revisions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bom_component_lines` ADD CONSTRAINT `bom_component_lines_son_code_id_fkey` FOREIGN KEY (`son_code_id`) REFERENCES `bom_son_codes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bom_component_lines` ADD CONSTRAINT `bom_component_lines_material_id_fkey` FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
