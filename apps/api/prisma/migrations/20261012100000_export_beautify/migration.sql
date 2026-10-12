-- AlterTable
ALTER TABLE "Export" ADD COLUMN     "beautified" JSONB,
ADD COLUMN     "options" JSONB NOT NULL DEFAULT '{}';
