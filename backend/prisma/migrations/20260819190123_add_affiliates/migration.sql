-- CreateEnum
CREATE TYPE "AffiliateStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "affiliateId" TEXT,
ADD COLUMN     "commissionKz" INTEGER;

-- CreateTable
CREATE TABLE "Affiliate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "status" "AffiliateStatus" NOT NULL DEFAULT 'PENDING',
    "commissionPct" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "Affiliate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Affiliate_userId_courseId_key" ON "Affiliate"("userId", "courseId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Affiliate" ADD CONSTRAINT "Affiliate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Affiliate" ADD CONSTRAINT "Affiliate_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
