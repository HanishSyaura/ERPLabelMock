-- CreateTable
CREATE TABLE `processes` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(30) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `description` VARCHAR(255) NULL,
    `sequence` INTEGER NOT NULL DEFAULT 0,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    UNIQUE INDEX `processes_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `machine_categories` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(30) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `description` VARCHAR(255) NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    UNIQUE INDEX `machine_categories_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `machine_category_processes` (
    `category_id` CHAR(36) NOT NULL,
    `process_id` CHAR(36) NOT NULL,

    PRIMARY KEY (`category_id`, `process_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `operator_qualifications` (
    `user_id` CHAR(36) NOT NULL,
    `category_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` CHAR(36) NULL,

    INDEX `operator_qualifications_category_id_idx`(`category_id`),
    PRIMARY KEY (`user_id`, `category_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `machines` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(30) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `category_id` CHAR(36) NOT NULL,
    `description` VARCHAR(255) NULL,
    `location` VARCHAR(80) NULL,
    `remarks` VARCHAR(500) NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `status` ENUM('AVAILABLE', 'RUNNING', 'IDLE', 'BREAKDOWN', 'MAINTENANCE', 'OFFLINE') NOT NULL DEFAULT 'AVAILABLE',
    `status_changed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    UNIQUE INDEX `machines_code_key`(`code`),
    INDEX `machines_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `handheld_devices` (
    `id` VARCHAR(80) NOT NULL,
    `name` VARCHAR(80) NULL,
    `assigned_machine_id` CHAR(36) NULL,
    `last_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_user_id` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_by` CHAR(36) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `routines` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(30) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `description` VARCHAR(255) NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    UNIQUE INDEX `routines_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `routine_steps` (
    `id` CHAR(36) NOT NULL,
    `routine_id` CHAR(36) NOT NULL,
    `seq` INTEGER NOT NULL,
    `process_id` CHAR(36) NOT NULL,

    UNIQUE INDEX `routine_steps_routine_id_seq_key`(`routine_id`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `production_routines` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(30) NOT NULL,
    `bom_id` CHAR(36) NOT NULL,
    `routine_id` CHAR(36) NOT NULL,
    `remarks` VARCHAR(500) NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,

    UNIQUE INDEX `production_routines_code_key`(`code`),
    UNIQUE INDEX `production_routines_bom_id_key`(`bom_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `production_job_orders` (
    `id` CHAR(36) NOT NULL,
    `pjo_no` VARCHAR(30) NOT NULL,
    `bom_id` CHAR(36) NOT NULL,
    `artwork_revision_id` CHAR(36) NOT NULL,
    `component_revision_id` CHAR(36) NULL,
    `customer_ref` VARCHAR(120) NULL,
    `product_ref` VARCHAR(120) NULL,
    `order_qty` DECIMAL(18, 4) NOT NULL,
    `uom` VARCHAR(10) NOT NULL,
    `required_date` DATE NULL,
    `priority` ENUM('LOW', 'NORMAL', 'HIGH', 'URGENT') NOT NULL DEFAULT 'NORMAL',
    `status` ENUM('DRAFT', 'RELEASED', 'CLOSED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `remarks` VARCHAR(500) NULL,
    `released_at` DATETIME(3) NULL,
    `released_by` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NOT NULL,
    `updated_by` CHAR(36) NOT NULL,

    UNIQUE INDEX `production_job_orders_pjo_no_key`(`pjo_no`),
    INDEX `production_job_orders_status_required_date_idx`(`status`, `required_date`),
    INDEX `production_job_orders_bom_id_idx`(`bom_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `work_orders` (
    `id` CHAR(36) NOT NULL,
    `wo_no` VARCHAR(30) NOT NULL,
    `pjo_id` CHAR(36) NOT NULL,
    `quantity` DECIMAL(18, 4) NOT NULL,
    `uom` VARCHAR(10) NOT NULL,
    `planned_date` DATE NULL,
    `priority` ENUM('LOW', 'NORMAL', 'HIGH', 'URGENT') NOT NULL DEFAULT 'NORMAL',
    `status` ENUM('PLANNED', 'RELEASED', 'IN_PROGRESS', 'PARTIALLY_COMPLETED', 'COMPLETED', 'ON_HOLD', 'CANCELLED') NOT NULL DEFAULT 'PLANNED',
    `remarks` VARCHAR(500) NULL,
    `hold_reason` VARCHAR(500) NULL,
    `released_at` DATETIME(3) NULL,
    `released_by` CHAR(36) NULL,
    `completed_at` DATETIME(3) NULL,
    `completed_by` CHAR(36) NULL,
    `completion_note` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` CHAR(36) NOT NULL,
    `updated_by` CHAR(36) NOT NULL,

    UNIQUE INDEX `work_orders_wo_no_key`(`wo_no`),
    INDEX `work_orders_status_planned_date_idx`(`status`, `planned_date`),
    INDEX `work_orders_pjo_id_idx`(`pjo_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `work_order_processes` (
    `id` CHAR(36) NOT NULL,
    `work_order_id` CHAR(36) NOT NULL,
    `seq` INTEGER NOT NULL,
    `process_id` CHAR(36) NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'PAUSED', 'COMPLETED') NOT NULL DEFAULT 'PENDING',
    `assigned_machine_id` CHAR(36) NULL,
    `allow_partial_transfer` BOOLEAN NOT NULL DEFAULT false,
    `allow_split` BOOLEAN NOT NULL DEFAULT false,
    `extra_allowed_qty` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `good_qty` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `reject_qty` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `started_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `completed_by` CHAR(36) NULL,
    `completion_note` VARCHAR(500) NULL,

    INDEX `work_order_processes_assigned_machine_id_idx`(`assigned_machine_id`),
    UNIQUE INDEX `work_order_processes_work_order_id_seq_key`(`work_order_id`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `production_sessions` (
    `id` CHAR(36) NOT NULL,
    `session_no` VARCHAR(30) NOT NULL,
    `work_order_id` CHAR(36) NOT NULL,
    `wo_process_id` CHAR(36) NOT NULL,
    `machine_id` CHAR(36) NOT NULL,
    `operator_id` CHAR(36) NOT NULL,
    `check_in_at` DATETIME(3) NOT NULL,
    `check_out_at` DATETIME(3) NULL,
    `status` ENUM('RUNNING', 'COMPLETED', 'PAUSED', 'BREAKDOWN', 'TRANSFERRED', 'CLOSED') NOT NULL DEFAULT 'RUNNING',
    `check_out_type` ENUM('COMPLETED', 'PARTIAL', 'SHIFT_END', 'MACHINE_CHANGE', 'MACHINE_BREAKDOWN') NULL,
    `available_at_start` DECIMAL(18, 4) NOT NULL,
    `good_qty` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `reject_qty` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `remarks` VARCHAR(500) NULL,
    `check_in_device_id` VARCHAR(80) NULL,
    `check_out_device_id` VARCHAR(80) NULL,
    `check_out_by` CHAR(36) NULL,

    UNIQUE INDEX `production_sessions_session_no_key`(`session_no`),
    INDEX `production_sessions_machine_id_status_idx`(`machine_id`, `status`),
    INDEX `production_sessions_wo_process_id_status_idx`(`wo_process_id`, `status`),
    INDEX `production_sessions_operator_id_check_in_at_idx`(`operator_id`, `check_in_at`),
    INDEX `production_sessions_check_in_at_idx`(`check_in_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `production_outputs` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `session_id` CHAR(36) NOT NULL,
    `wo_process_id` CHAR(36) NOT NULL,
    `machine_id` CHAR(36) NOT NULL,
    `operator_id` CHAR(36) NOT NULL,
    `kind` VARCHAR(20) NOT NULL,
    `good_qty` DECIMAL(18, 4) NOT NULL,
    `reject_qty` DECIMAL(18, 4) NOT NULL,
    `reject_reason` VARCHAR(255) NULL,
    `recorded_at` DATETIME(3) NOT NULL,
    `device_id` VARCHAR(80) NULL,

    INDEX `production_outputs_machine_id_recorded_at_idx`(`machine_id`, `recorded_at`),
    INDEX `production_outputs_wo_process_id_idx`(`wo_process_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `machine_breakdowns` (
    `id` CHAR(36) NOT NULL,
    `breakdown_no` VARCHAR(30) NOT NULL,
    `machine_id` CHAR(36) NOT NULL,
    `session_id` CHAR(36) NULL,
    `work_order_id` CHAR(36) NULL,
    `wo_process_id` CHAR(36) NULL,
    `reason` VARCHAR(40) NOT NULL,
    `remarks` VARCHAR(500) NULL,
    `reported_at` DATETIME(3) NOT NULL,
    `reported_by` CHAR(36) NOT NULL,
    `last_confirmed_good` DECIMAL(18, 4) NULL,
    `status` ENUM('OPEN', 'UNDER_MAINTENANCE', 'RESOLVED') NOT NULL DEFAULT 'OPEN',
    `maintenance_note` VARCHAR(500) NULL,
    `maintenance_started_at` DATETIME(3) NULL,
    `maintenance_by` CHAR(36) NULL,
    `resolved_at` DATETIME(3) NULL,
    `resolved_by` CHAR(36) NULL,
    `resolution_note` VARCHAR(500) NULL,
    `safety_confirmed` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `machine_breakdowns_breakdown_no_key`(`breakdown_no`),
    INDEX `machine_breakdowns_machine_id_reported_at_idx`(`machine_id`, `reported_at`),
    INDEX `machine_breakdowns_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `machine_changes` (
    `id` CHAR(36) NOT NULL,
    `work_order_id` CHAR(36) NOT NULL,
    `wo_process_id` CHAR(36) NOT NULL,
    `from_machine_id` CHAR(36) NULL,
    `to_machine_id` CHAR(36) NOT NULL,
    `from_session_id` CHAR(36) NULL,
    `prev_machine_good` DECIMAL(18, 4) NOT NULL,
    `prev_machine_reject` DECIMAL(18, 4) NOT NULL,
    `outstanding_qty` DECIMAL(18, 4) NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL,
    `requested_by` CHAR(36) NOT NULL,
    `requested_at` DATETIME(3) NOT NULL,
    `decided_by` CHAR(36) NULL,
    `decided_at` DATETIME(3) NULL,
    `decision_note` VARCHAR(500) NULL,

    INDEX `machine_changes_wo_process_id_status_idx`(`wo_process_id`, `status`),
    INDEX `machine_changes_requested_at_idx`(`requested_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shopfloor_transactions` (
    `client_txn_id` VARCHAR(64) NOT NULL,
    `kind` VARCHAR(30) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `response` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`client_txn_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `machine_category_processes` ADD CONSTRAINT `machine_category_processes_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `machine_categories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `machine_category_processes` ADD CONSTRAINT `machine_category_processes_process_id_fkey` FOREIGN KEY (`process_id`) REFERENCES `processes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `operator_qualifications` ADD CONSTRAINT `operator_qualifications_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `machine_categories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `machines` ADD CONSTRAINT `machines_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `machine_categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `handheld_devices` ADD CONSTRAINT `handheld_devices_assigned_machine_id_fkey` FOREIGN KEY (`assigned_machine_id`) REFERENCES `machines`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `routine_steps` ADD CONSTRAINT `routine_steps_routine_id_fkey` FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `routine_steps` ADD CONSTRAINT `routine_steps_process_id_fkey` FOREIGN KEY (`process_id`) REFERENCES `processes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_routines` ADD CONSTRAINT `production_routines_bom_id_fkey` FOREIGN KEY (`bom_id`) REFERENCES `boms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_routines` ADD CONSTRAINT `production_routines_routine_id_fkey` FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_job_orders` ADD CONSTRAINT `production_job_orders_bom_id_fkey` FOREIGN KEY (`bom_id`) REFERENCES `boms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_job_orders` ADD CONSTRAINT `production_job_orders_artwork_revision_id_fkey` FOREIGN KEY (`artwork_revision_id`) REFERENCES `bom_artwork_revisions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_job_orders` ADD CONSTRAINT `production_job_orders_component_revision_id_fkey` FOREIGN KEY (`component_revision_id`) REFERENCES `bom_component_revisions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `work_orders` ADD CONSTRAINT `work_orders_pjo_id_fkey` FOREIGN KEY (`pjo_id`) REFERENCES `production_job_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `work_order_processes` ADD CONSTRAINT `work_order_processes_work_order_id_fkey` FOREIGN KEY (`work_order_id`) REFERENCES `work_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `work_order_processes` ADD CONSTRAINT `work_order_processes_process_id_fkey` FOREIGN KEY (`process_id`) REFERENCES `processes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_sessions` ADD CONSTRAINT `production_sessions_work_order_id_fkey` FOREIGN KEY (`work_order_id`) REFERENCES `work_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_sessions` ADD CONSTRAINT `production_sessions_wo_process_id_fkey` FOREIGN KEY (`wo_process_id`) REFERENCES `work_order_processes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_sessions` ADD CONSTRAINT `production_sessions_machine_id_fkey` FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_outputs` ADD CONSTRAINT `production_outputs_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `production_sessions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `machine_breakdowns` ADD CONSTRAINT `machine_breakdowns_machine_id_fkey` FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `machine_changes` ADD CONSTRAINT `machine_changes_wo_process_id_fkey` FOREIGN KEY (`wo_process_id`) REFERENCES `work_order_processes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
