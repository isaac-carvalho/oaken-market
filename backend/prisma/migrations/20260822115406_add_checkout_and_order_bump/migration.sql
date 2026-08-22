-- DropIndex
DROP INDEX "Enrollment_orderId_key";

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "bumpAmountKz" INTEGER,
ADD COLUMN     "bumpCourseId" TEXT;

-- CreateTable
CREATE TABLE "Checkout" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "bumpCourseId" TEXT,
    "bumpPriceKz" INTEGER,
    "bumpHeadline" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Checkout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Checkout_courseId_key" ON "Checkout"("courseId");

-- AddForeignKey
ALTER TABLE "Checkout" ADD CONSTRAINT "Checkout_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Checkout" ADD CONSTRAINT "Checkout_bumpCourseId_fkey" FOREIGN KEY ("bumpCourseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_bumpCourseId_fkey" FOREIGN KEY ("bumpCourseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;
