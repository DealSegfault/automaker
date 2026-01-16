/**
 * Auto-mode metrics for quality and performance tracking.
 */

import type { PlanTaskComplexity } from './feature.js';

export type QualityGateStatus = 'pass' | 'fail' | 'skipped';

export interface QualityGateResult {
  name: string;
  status: QualityGateStatus;
  durationMs?: number;
  output?: string;
}

export interface FeatureQualityMetrics {
  checks: QualityGateResult[];
  coveragePercent?: number;
  lintErrorCount?: number;
  typeErrorCount?: number;
}

export interface AutoModeStageDurations {
  planningMs?: number;
  executionMs?: number;
  pipelineMs?: number;
  verificationMs?: number;
  judgeMs?: number;
}

export type AutoModeFeatureRunStatus = 'running' | 'success' | 'failed';

export interface AutoModeFeatureRunMetrics {
  runId: string;
  featureId: string;
  title?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: AutoModeFeatureRunStatus;
  complexity?: PlanTaskComplexity;
  attempts: number;
  revisions: number;
  model?: string;
  provider?: string;
  stageDurations?: AutoModeStageDurations;
  quality?: FeatureQualityMetrics;
  tokenEfficiency?: number;
}

export interface AutoModeMetricsStore {
  version: number;
  updatedAt: string;
  runs: AutoModeFeatureRunMetrics[];
}

export interface AutoModeMetricsSummary {
  totalRuns: number;
  successRate: number;
  revisionRate: number;
  averageDurationMs?: number;
  averageDurationByComplexity?: Partial<Record<PlanTaskComplexity, number>>;
  tokenEfficiency?: number;
  utilization?: number;
  bottleneck?: string;
}

export interface AutoModeMetricsSnapshot extends AutoModeMetricsStore {
  summary: AutoModeMetricsSummary;
}
