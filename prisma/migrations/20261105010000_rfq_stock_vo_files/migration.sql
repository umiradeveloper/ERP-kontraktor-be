-- AlterTable
ALTER TABLE `GoodsReceipt` ADD COLUMN `warehouseId` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `Rfq` (
    `id` CHAR(36) NOT NULL,
    `tenantId` CHAR(36) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `projectId` CHAR(36) NOT NULL,
    `requestId` CHAR(36) NULL,
    `title` VARCHAR(191) NOT NULL,
    `dueDate` DATETIME(3) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'OPEN',
    `awardedSupplierId` CHAR(36) NULL,
    `awardReason` TEXT NULL,
    `poId` CHAR(36) NULL,
    `createdBy` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Rfq_tenantId_status_idx`(`tenantId`, `status`),
    UNIQUE INDEX `Rfq_tenantId_number_key`(`tenantId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RfqItem` (
    `id` CHAR(36) NOT NULL,
    `tenantId` CHAR(36) NOT NULL,
    `rfqId` CHAR(36) NOT NULL,
    `description` VARCHAR(191) NOT NULL,
    `quantity` DECIMAL(18, 4) NOT NULL,
    `unit` VARCHAR(191) NULL,
    `category` ENUM('MATERIAL', 'LABOR', 'EQUIPMENT', 'SUBCONTRACTOR', 'OVERHEAD', 'TAX', 'OTHER') NOT NULL DEFAULT 'MATERIAL',
    `costCode` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RfqSupplier` (
    `id` CHAR(36) NOT NULL,
    `tenantId` CHAR(36) NOT NULL,
    `rfqId` CHAR(36) NOT NULL,
    `supplierId` CHAR(36) NOT NULL,

    UNIQUE INDEX `RfqSupplier_rfqId_supplierId_key`(`rfqId`, `supplierId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SupplierQuotation` (
    `id` CHAR(36) NOT NULL,
    `tenantId` CHAR(36) NOT NULL,
    `rfqId` CHAR(36) NOT NULL,
    `supplierId` CHAR(36) NOT NULL,
    `quoteRef` VARCHAR(191) NULL,
    `quoteDate` DATETIME(3) NOT NULL,
    `leadTimeDays` INTEGER NOT NULL DEFAULT 7,
    `paymentTerm` INTEGER NOT NULL DEFAULT 30,
    `validUntil` DATETIME(3) NULL,
    `notes` TEXT NULL,
    `subtotal` DECIMAL(18, 2) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `SupplierQuotation_rfqId_supplierId_key`(`rfqId`, `supplierId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `QuotationLine` (
    `id` CHAR(36) NOT NULL,
    `tenantId` CHAR(36) NOT NULL,
    `quotationId` CHAR(36) NOT NULL,
    `rfqItemId` CHAR(36) NOT NULL,
    `unitPrice` DECIMAL(18, 2) NOT NULL,
    `amount` DECIMAL(18, 2) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Warehouse` (
    `id` CHAR(36) NOT NULL,
    `tenantId` CHAR(36) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `projectId` CHAR(36) NULL,
    `location` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,

    UNIQUE INDEX `Warehouse_tenantId_code_key`(`tenantId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `InventoryItem` (
    `id` CHAR(36) NOT NULL,
    `tenantId` CHAR(36) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `unit` VARCHAR(191) NULL,
    `category` ENUM('MATERIAL', 'LABOR', 'EQUIPMENT', 'SUBCONTRACTOR', 'OVERHEAD', 'TAX', 'OTHER') NOT NULL DEFAULT 'MATERIAL',
    `minStock` DECIMAL(18, 4) NOT NULL DEFAULT 0,

    UNIQUE INDEX `InventoryItem_tenantId_code_key`(`tenantId`, `code`),
    UNIQUE INDEX `InventoryItem_tenantId_name_key`(`tenantId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StockBalance` (
    `id` CHAR(36) NOT NULL,
    `tenantId` CHAR(36) NOT NULL,
    `warehouseId` CHAR(36) NOT NULL,
    `itemId` CHAR(36) NOT NULL,
    `quantity` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `avgCost` DECIMAL(18, 2) NOT NULL DEFAULT 0,

    INDEX `StockBalance_tenantId_idx`(`tenantId`),
    UNIQUE INDEX `StockBalance_warehouseId_itemId_key`(`warehouseId`, `itemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StockMovement` (
    `id` CHAR(36) NOT NULL,
    `tenantId` CHAR(36) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `warehouseId` CHAR(36) NOT NULL,
    `itemId` CHAR(36) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `quantity` DECIMAL(18, 4) NOT NULL,
    `unitCost` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `refType` VARCHAR(191) NULL,
    `refId` CHAR(36) NULL,
    `projectId` CHAR(36) NULL,
    `costCode` VARCHAR(191) NULL,
    `notes` VARCHAR(191) NULL,
    `movedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdBy` CHAR(36) NOT NULL,

    INDEX `StockMovement_tenantId_warehouseId_itemId_movedAt_idx`(`tenantId`, `warehouseId`, `itemId`, `movedAt`),
    INDEX `StockMovement_tenantId_number_idx`(`tenantId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VariationOrder` (
    `id` CHAR(36) NOT NULL,
    `tenantId` CHAR(36) NOT NULL,
    `projectId` CHAR(36) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `contractChange` DECIMAL(18, 2) NOT NULL,
    `status` ENUM('DRAFT', 'SUBMITTED', 'IN_APPROVAL', 'APPROVED', 'REJECTED', 'REVISION', 'CONVERTED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `requestedBy` CHAR(36) NOT NULL,
    `approvedAt` DATETIME(3) NULL,
    `budgetId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `VariationOrder_tenantId_projectId_idx`(`tenantId`, `projectId`),
    UNIQUE INDEX `VariationOrder_tenantId_number_key`(`tenantId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VariationOrderItem` (
    `id` CHAR(36) NOT NULL,
    `tenantId` CHAR(36) NOT NULL,
    `voId` CHAR(36) NOT NULL,
    `category` ENUM('MATERIAL', 'LABOR', 'EQUIPMENT', 'SUBCONTRACTOR', 'OVERHEAD', 'TAX', 'OTHER') NOT NULL,
    `description` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(18, 2) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FileObject` (
    `id` CHAR(36) NOT NULL,
    `tenantId` CHAR(36) NOT NULL,
    `entityType` VARCHAR(191) NOT NULL,
    `entityId` CHAR(36) NOT NULL,
    `fileName` VARCHAR(191) NOT NULL,
    `mimeType` VARCHAR(191) NOT NULL,
    `size` INTEGER NOT NULL,
    `storageKey` VARCHAR(191) NOT NULL,
    `category` VARCHAR(191) NULL,
    `uploadedBy` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `FileObject_tenantId_entityType_entityId_idx`(`tenantId`, `entityType`, `entityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Notification` (
    `id` CHAR(36) NOT NULL,
    `tenantId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `body` TEXT NULL,
    `link` VARCHAR(191) NULL,
    `dedupeKey` VARCHAR(191) NULL,
    `readAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Notification_tenantId_userId_readAt_idx`(`tenantId`, `userId`, `readAt`),
    UNIQUE INDEX `Notification_tenantId_userId_dedupeKey_key`(`tenantId`, `userId`, `dedupeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `RfqItem` ADD CONSTRAINT `RfqItem_rfqId_fkey` FOREIGN KEY (`rfqId`) REFERENCES `Rfq`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RfqSupplier` ADD CONSTRAINT `RfqSupplier_rfqId_fkey` FOREIGN KEY (`rfqId`) REFERENCES `Rfq`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RfqSupplier` ADD CONSTRAINT `RfqSupplier_supplierId_fkey` FOREIGN KEY (`supplierId`) REFERENCES `Supplier`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierQuotation` ADD CONSTRAINT `SupplierQuotation_rfqId_fkey` FOREIGN KEY (`rfqId`) REFERENCES `Rfq`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierQuotation` ADD CONSTRAINT `SupplierQuotation_supplierId_fkey` FOREIGN KEY (`supplierId`) REFERENCES `Supplier`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `QuotationLine` ADD CONSTRAINT `QuotationLine_quotationId_fkey` FOREIGN KEY (`quotationId`) REFERENCES `SupplierQuotation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `QuotationLine` ADD CONSTRAINT `QuotationLine_rfqItemId_fkey` FOREIGN KEY (`rfqItemId`) REFERENCES `RfqItem`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockBalance` ADD CONSTRAINT `StockBalance_warehouseId_fkey` FOREIGN KEY (`warehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockBalance` ADD CONSTRAINT `StockBalance_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `InventoryItem`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockMovement` ADD CONSTRAINT `StockMovement_warehouseId_fkey` FOREIGN KEY (`warehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockMovement` ADD CONSTRAINT `StockMovement_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `InventoryItem`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VariationOrder` ADD CONSTRAINT `VariationOrder_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VariationOrderItem` ADD CONSTRAINT `VariationOrderItem_voId_fkey` FOREIGN KEY (`voId`) REFERENCES `VariationOrder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

