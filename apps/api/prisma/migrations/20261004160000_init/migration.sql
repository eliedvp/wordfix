-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('user', 'admin');

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('QUEUED', 'EXTRACTING', 'ANALYZING_LOCAL', 'ANALYZING_CONTEXT', 'ANALYZING_GLOBAL', 'FINALIZING', 'COMPLETED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "ChunkStage" AS ENUM ('local', 'context', 'global', 'verify');

-- CreateEnum
CREATE TYPE "ChunkStatus" AS ENUM ('PENDING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "IssueCategory" AS ENUM ('spelling', 'grammar', 'punctuation', 'style', 'coherence', 'structure');

-- CreateEnum
CREATE TYPE "IssueNature" AS ENUM ('error', 'suggestion', 'potential', 'verify');

-- CreateEnum
CREATE TYPE "IssueSeverity" AS ENUM ('minor', 'major', 'critical');

-- CreateEnum
CREATE TYPE "Confidence" AS ENUM ('high', 'medium', 'low');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('open', 'accepted', 'ignored', 'verified', 'edited');

-- CreateEnum
CREATE TYPE "IssueSource" AS ENUM ('rules', 'local', 'context', 'global', 'verify');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "isGuest" BOOLEAN NOT NULL DEFAULT true,
    "email" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'user',
    "sessionTokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT,
    "wordCount" INTEGER NOT NULL,
    "declaredPages" INTEGER,
    "estimatedPages" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fileExpiresAt" TIMESTAMP(3) NOT NULL,
    "fileDeletedAt" TIMESTAMP(3),
    "contentExpiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentContent" (
    "documentId" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "model" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentContent_pkey" PRIMARY KEY ("documentId")
);

-- CreateTable
CREATE TABLE "Analysis" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "chunksTotal" INTEGER NOT NULL DEFAULT 0,
    "chunksDone" INTEGER NOT NULL DEFAULT 0,
    "score" INTEGER,
    "scoreDetail" JSONB,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "promptVersion" TEXT NOT NULL,
    "modelFast" TEXT,
    "modelSmart" TEXT,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),

    CONSTRAINT "Analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisChunk" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "stage" "ChunkStage" NOT NULL,
    "index" INTEGER NOT NULL,
    "blockIds" JSONB NOT NULL,
    "status" "ChunkStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "issueCount" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "errorCode" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalysisChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Issue" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "category" "IssueCategory" NOT NULL,
    "subtype" TEXT NOT NULL,
    "nature" "IssueNature" NOT NULL,
    "severity" "IssueSeverity" NOT NULL,
    "confidence" "Confidence" NOT NULL,
    "source" "IssueSource" NOT NULL,
    "blockId" TEXT NOT NULL,
    "sectionId" TEXT,
    "sectionPath" TEXT NOT NULL,
    "paragraphInSection" INTEGER,
    "charStart" INTEGER NOT NULL,
    "charEnd" INTEGER NOT NULL,
    "estimatedPage" INTEGER,
    "docOrder" INTEGER NOT NULL,
    "original" TEXT NOT NULL,
    "suggestion" TEXT,
    "explanation" TEXT NOT NULL,
    "related" JSONB NOT NULL DEFAULT '[]',
    "status" "IssueStatus" NOT NULL DEFAULT 'open',
    "userText" TEXT,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Issue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_sessionTokenHash_key" ON "User"("sessionTokenHash");

-- CreateIndex
CREATE INDEX "User_lastSeenAt_idx" ON "User"("lastSeenAt");

-- CreateIndex
CREATE INDEX "Document_ownerId_createdAt_idx" ON "Document"("ownerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Document_fileExpiresAt_idx" ON "Document"("fileExpiresAt");

-- CreateIndex
CREATE INDEX "Document_contentExpiresAt_idx" ON "Document"("contentExpiresAt");

-- CreateIndex
CREATE INDEX "Analysis_documentId_createdAt_idx" ON "Analysis"("documentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Analysis_status_idx" ON "Analysis"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisChunk_analysisId_stage_index_key" ON "AnalysisChunk"("analysisId", "stage", "index");

-- CreateIndex
CREATE INDEX "Issue_analysisId_docOrder_idx" ON "Issue"("analysisId", "docOrder");

-- CreateIndex
CREATE INDEX "Issue_analysisId_category_idx" ON "Issue"("analysisId", "category");

-- CreateIndex
CREATE INDEX "Issue_analysisId_status_idx" ON "Issue"("analysisId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Issue_analysisId_fingerprint_key" ON "Issue"("analysisId", "fingerprint");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentContent" ADD CONSTRAINT "DocumentContent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisChunk" ADD CONSTRAINT "AnalysisChunk_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
