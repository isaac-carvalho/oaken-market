-- CreateEnum
CREATE TYPE "CourseType" AS ENUM ('DIGITAL', 'PHYSICAL', 'SERVICE', 'PAYMENT');

-- AlterTable
ALTER TABLE "Course" ADD COLUMN     "category" TEXT,
ADD COLUMN     "type" "CourseType" NOT NULL DEFAULT 'DIGITAL';
