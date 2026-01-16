/**
 * Auto Mode Service - Autonomous feature implementation using Claude Agent SDK
 *
 * Manages:
 * - Worktree creation for isolated development
 * - Feature execution with Claude
 * - Concurrent execution with max concurrency limits
 * - Progress streaming via events
 * - Verification and merge workflows
 */

import { ProviderFactory } from '../providers/provider-factory.js';
import type { BaseProvider } from '../providers/base-provider.js';
import { simpleQuery } from '../providers/simple-query-service.js';
import type {
  ExecuteOptions,
  Feature,
  ModelProvider,
  PipelineStep,
  PlanTask,
  PlanTaskComplexity,
  PlanTaskStatus,
  ArchitecturalDecision,
  RejectedApproach,
  CodePattern,
  TestingStrategy,
  AutoModeMetricsStore,
  AutoModeMetricsSnapshot,
  AutoModeMetricsSummary,
  AutoModeFeatureRunMetrics,
  FeatureQualityMetrics,
  QualityGateResult,
  AutoModeStageDurations,
  FeatureStatusWithPipeline,
  PipelineConfig,
  ThinkingLevel,
  PlanningMode,
  ReasoningEffort,
} from '@automaker/types';
import { DEFAULT_PHASE_MODELS, isClaudeModel, stripProviderPrefix } from '@automaker/types';
import {
  buildPromptWithImages,
  classifyError,
  loadContextFiles,
  appendLearning,
  updateArchitecturalMemory,
  recordMemoryUsage,
  createLogger,
} from '@automaker/utils';

const logger = createLogger('AutoMode');
import { resolveModelString, resolvePhaseModel, DEFAULT_MODELS } from '@automaker/model-resolver';
import { resolveDependencies, areDependenciesSatisfied } from '@automaker/dependency-resolver';
import {
  getFeatureDir,
  getAutomakerDir,
  getFeaturesDir,
  getExecutionStatePath,
  ensureAutomakerDir,
} from '@automaker/platform';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import * as secureFs from '../lib/secure-fs.js';
import type { EventEmitter } from '../lib/events.js';
import {
  createAutoModeOptions,
  createCustomOptions,
  validateWorkingDirectory,
} from '../lib/sdk-options.js';
import { FeatureLoader } from './feature-loader.js';
import type { SettingsService } from './settings-service.js';
import { pipelineService, PipelineService } from './pipeline-service.js';
import {
  getAutoLoadClaudeMdSetting,
  filterClaudeMdFromContext,
  getMCPServersFromSettings,
  getPromptCustomization,
} from '../lib/settings-helpers.js';

const execAsync = promisify(exec);

// PlanningMode type is imported from @automaker/types

interface ParsedTask extends PlanTask {
  status: PlanTaskStatus;
}

interface RoleModelConfig {
  model: string;
  thinkingLevel?: ThinkingLevel;
  reasoningEffort?: ReasoningEffort;
}

interface RolePromptConfig {
  planner?: string;
  worker?: string;
  judge?: string;
  refactor?: string;
}

interface PlanSpec {
  status: 'pending' | 'generating' | 'generated' | 'approved' | 'rejected';
  content?: string;
  version: number;
  generatedAt?: string;
  approvedAt?: string;
  reviewedByUser: boolean;
  tasksCompleted?: number;
  tasksTotal?: number;
  currentTaskId?: string;
  currentTaskIds?: string[];
  tasks?: ParsedTask[];
  taskStateVersion?: number;
  qualityIssues?: string[];
}

interface QualityCheckOutcome {
  passed: boolean;
  results: QualityGateResult[];
  metrics: FeatureQualityMetrics;
}

interface JudgeResult {
  verdict: 'pass' | 'revise' | 'fail';
  issues: string[];
  recommendations: string[];
  confidence?: number;
}

/**
 * Information about pipeline status when resuming a feature.
 * Used to determine how to handle features stuck in pipeline execution.
 *
 * @property {boolean} isPipeline - Whether the feature is in a pipeline step
 * @property {string | null} stepId - ID of the current pipeline step (e.g., 'step_123')
 * @property {number} stepIndex - Index of the step in the sorted pipeline steps (-1 if not found)
 * @property {number} totalSteps - Total number of steps in the pipeline
 * @property {PipelineStep | null} step - The pipeline step configuration, or null if step not found
 * @property {PipelineConfig | null} config - The full pipeline configuration, or null if no pipeline
 */
interface PipelineStatusInfo {
  isPipeline: boolean;
  stepId: string | null;
  stepIndex: number;
  totalSteps: number;
  step: PipelineStep | null;
  config: PipelineConfig | null;
}

/**
 * Parse tasks from generated spec content
 * Looks for the ```tasks code block and extracts task lines
 * Format: - [ ] T###: Description | File: path/to/file
 */
function parseTasksFromSpec(specContent: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];

  // Extract content within ```tasks ... ``` block
  const tasksBlockMatch = specContent.match(/```tasks\s*([\s\S]*?)```/);
  if (!tasksBlockMatch) {
    // Try fallback: look for task lines anywhere in content
    const taskLines = specContent.match(/- \[ \] T\d{3}:.*$/gm);
    if (!taskLines) {
      return tasks;
    }
    // Parse fallback task lines
    let currentPhase: string | undefined;
    for (const line of taskLines) {
      const parsed = parseTaskLine(line, currentPhase);
      if (parsed) {
        tasks.push(parsed);
      }
    }
    return tasks;
  }

  const tasksContent = tasksBlockMatch[1];
  const lines = tasksContent.split('\n');

  let currentPhase: string | undefined;

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Check for phase header (e.g., "## Phase 1: Foundation")
    const phaseMatch = trimmedLine.match(/^##\s*(.+)$/);
    if (phaseMatch) {
      currentPhase = phaseMatch[1].trim();
      continue;
    }

    // Check for task line
    if (trimmedLine.startsWith('- [ ]')) {
      const parsed = parseTaskLine(trimmedLine, currentPhase);
      if (parsed) {
        tasks.push(parsed);
      }
    }
  }

  return tasks;
}

/**
 * Parse a single task line
 * Format: - [ ] T###: Description | File: path/to/file | DependsOn: T000, T001 | Complexity: low
 */
function parseTaskLine(line: string, currentPhase?: string): ParsedTask | null {
  const taskMatch = line.match(/- \[ \] (T\d{3}):\s*(.+)$/);
  if (!taskMatch) {
    return null;
  }

  const [, id, remainder] = taskMatch;
  const parts = remainder
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  const description = parts.shift()!.trim();
  let filePath: string | undefined;
  let dependsOn: string[] | undefined;
  let complexity: PlanTaskComplexity | undefined;

  for (const part of parts) {
    const fileMatch = part.match(/^File:\s*(.+)$/i);
    if (fileMatch) {
      filePath = fileMatch[1].trim();
      continue;
    }

    const depsMatch = part.match(/^DependsOn:\s*(.+)$/i);
    if (depsMatch) {
      const raw = depsMatch[1].trim().replace(/[\[\]]/g, '');
      const deps = raw
        .split(/[,\s]+/)
        .map((dep) => dep.trim())
        .filter(Boolean);
      dependsOn = deps.length > 0 ? deps : undefined;
      continue;
    }

    const complexityMatch = part.match(/^Complexity:\s*(.+)$/i);
    if (complexityMatch) {
      const normalized = complexityMatch[1].trim().toLowerCase();
      if (normalized.startsWith('l')) {
        complexity = 'low';
      } else if (normalized.startsWith('m')) {
        complexity = 'medium';
      } else if (normalized.startsWith('h')) {
        complexity = 'high';
      }
    }
  }

  return {
    id,
    description,
    filePath,
    phase: currentPhase,
    dependsOn,
    complexity,
    status: 'pending',
  };
}

// Feature type is imported from feature-loader.js
// Extended type with planning fields for local use
interface FeatureWithPlanning extends Feature {
  planningMode?: PlanningMode;
  planSpec?: PlanSpec;
  requirePlanApproval?: boolean;
}

interface RunningFeature {
  featureId: string;
  projectPath: string;
  worktreePath: string | null;
  branchName: string | null;
  abortController: AbortController;
  isAutoMode: boolean;
  startTime: number;
  model?: string;
  provider?: ModelProvider;
  metricsRunId?: string;
}

interface AutoLoopState {
  projectPath: string;
  maxConcurrency: number;
  abortController: AbortController;
  isRunning: boolean;
}

interface PendingApproval {
  resolve: (result: { approved: boolean; editedPlan?: string; feedback?: string }) => void;
  reject: (error: Error) => void;
  featureId: string;
  projectPath: string;
}

interface AutoModeConfig {
  maxConcurrency: number;
  useWorktrees: boolean;
  projectPath: string;
}

/**
 * Execution state for recovery after server restart
 * Tracks which features were running and auto-loop configuration
 */
interface ExecutionState {
  version: 1;
  autoLoopWasRunning: boolean;
  maxConcurrency: number;
  projectPath: string;
  runningFeatureIds: string[];
  savedAt: string;
}

// Default empty execution state
const DEFAULT_EXECUTION_STATE: ExecutionState = {
  version: 1,
  autoLoopWasRunning: false,
  maxConcurrency: 3,
  projectPath: '',
  runningFeatureIds: [],
  savedAt: '',
};

// Constants for consecutive failure tracking
const CONSECUTIVE_FAILURE_THRESHOLD = 3; // Pause after 3 consecutive failures
const FAILURE_WINDOW_MS = 60000; // Failures within 1 minute count as consecutive
const DEFAULT_MAX_TASK_CONCURRENCY = 3;
const MAX_TASK_CONCURRENCY_CAP = 8;
const TASK_REFINEMENT_COUNT_THRESHOLD = 8;
const TASK_REFINEMENT_SCORE_THRESHOLD = 14;
const MAX_SUBPLANNING_PASSES = 1;
const METRICS_STORE_VERSION = 1;
const MAX_QUALITY_FIX_ATTEMPTS = 2;
const MAX_JUDGE_REVISIONS = 2;
const MAX_METRICS_HISTORY = 200;
const MAX_PLAN_QUALITY_REVISIONS = 2;

export class AutoModeService {
  private events: EventEmitter;
  private runningFeatures = new Map<string, RunningFeature>();
  private autoLoop: AutoLoopState | null = null;
  private featureLoader = new FeatureLoader();
  private autoLoopRunning = false;
  private autoLoopAbortController: AbortController | null = null;
  private config: AutoModeConfig | null = null;
  private pendingApprovals = new Map<string, PendingApproval>();
  private settingsService: SettingsService | null = null;
  // Track consecutive failures to detect quota/API issues
  private consecutiveFailures: { timestamp: number; error: string }[] = [];
  private pausedDueToFailures = false;
  private metricsByProject = new Map<string, AutoModeMetricsStore>();

  constructor(events: EventEmitter, settingsService?: SettingsService) {
    this.events = events;
    this.settingsService = settingsService ?? null;
  }

  /**
   * Track a failure and check if we should pause due to consecutive failures.
   * This handles cases where the SDK doesn't return useful error messages.
   */
  private trackFailureAndCheckPause(errorInfo: { type: string; message: string }): boolean {
    const now = Date.now();

    // Add this failure
    this.consecutiveFailures.push({ timestamp: now, error: errorInfo.message });

    // Remove old failures outside the window
    this.consecutiveFailures = this.consecutiveFailures.filter(
      (f) => now - f.timestamp < FAILURE_WINDOW_MS
    );

    // Check if we've hit the threshold
    if (this.consecutiveFailures.length >= CONSECUTIVE_FAILURE_THRESHOLD) {
      return true; // Should pause
    }

    // Also immediately pause for known quota/rate limit errors
    if (errorInfo.type === 'quota_exhausted' || errorInfo.type === 'rate_limit') {
      return true;
    }

    return false;
  }

  /**
   * Signal that we should pause due to repeated failures or quota exhaustion.
   * This will pause the auto loop to prevent repeated failures.
   */
  private signalShouldPause(errorInfo: { type: string; message: string }): void {
    if (this.pausedDueToFailures) {
      return; // Already paused
    }

    this.pausedDueToFailures = true;
    const failureCount = this.consecutiveFailures.length;
    logger.info(
      `Pausing auto loop after ${failureCount} consecutive failures. Last error: ${errorInfo.type}`
    );

    // Emit event to notify UI
    this.emitAutoModeEvent('auto_mode_paused_failures', {
      message:
        failureCount >= CONSECUTIVE_FAILURE_THRESHOLD
          ? `Auto Mode paused: ${failureCount} consecutive failures detected. This may indicate a quota limit or API issue. Please check your usage and try again.`
          : 'Auto Mode paused: Usage limit or API error detected. Please wait for your quota to reset or check your API configuration.',
      errorType: errorInfo.type,
      originalError: errorInfo.message,
      failureCount,
      projectPath: this.config?.projectPath,
    });

    // Stop the auto loop
    this.stopAutoLoop();
  }

  /**
   * Reset failure tracking (called when user manually restarts auto mode)
   */
  private resetFailureTracking(): void {
    this.consecutiveFailures = [];
    this.pausedDueToFailures = false;
  }

  /**
   * Record a successful feature completion to reset consecutive failure count
   */
  private recordSuccess(): void {
    this.consecutiveFailures = [];
  }

  private getMetricsPath(projectPath: string): string {
    return path.join(getAutomakerDir(projectPath), 'metrics', 'auto-mode-metrics.json');
  }

  private createDefaultMetricsStore(): AutoModeMetricsStore {
    return {
      version: METRICS_STORE_VERSION,
      updatedAt: new Date().toISOString(),
      runs: [],
    };
  }

  private async loadMetricsStore(projectPath: string): Promise<AutoModeMetricsStore> {
    const cached = this.metricsByProject.get(projectPath);
    if (cached) {
      return cached;
    }

    const metricsPath = this.getMetricsPath(projectPath);
    try {
      const raw = (await secureFs.readFile(metricsPath, 'utf-8')) as string;
      const parsed = JSON.parse(raw) as AutoModeMetricsStore;
      const store = {
        ...this.createDefaultMetricsStore(),
        ...parsed,
        runs: parsed.runs || [],
      };
      this.metricsByProject.set(projectPath, store);
      return store;
    } catch {
      const store = this.createDefaultMetricsStore();
      this.metricsByProject.set(projectPath, store);
      return store;
    }
  }

  private async saveMetricsStore(projectPath: string, store: AutoModeMetricsStore): Promise<void> {
    store.updatedAt = new Date().toISOString();
    if (store.runs.length > MAX_METRICS_HISTORY) {
      store.runs = store.runs.slice(-MAX_METRICS_HISTORY);
    }

    const metricsPath = this.getMetricsPath(projectPath);
    await secureFs.mkdir(path.dirname(metricsPath), { recursive: true });
    await secureFs.writeFile(metricsPath, JSON.stringify(store, null, 2));
  }

  private calculateMetricsSummary(
    store: AutoModeMetricsStore,
    projectPath?: string
  ): AutoModeMetricsSummary {
    const completedRuns = store.runs.filter(
      (run) => run.status !== 'running' && typeof run.durationMs === 'number'
    );
    const totalRuns = completedRuns.length;
    const successCount = completedRuns.filter((run) => run.status === 'success').length;
    const successRate = totalRuns > 0 ? successCount / totalRuns : 0;
    const revisionRate =
      totalRuns > 0
        ? completedRuns.reduce((sum, run) => sum + (run.revisions || 0), 0) / totalRuns
        : 0;
    const averageDurationMs =
      totalRuns > 0
        ? Math.round(completedRuns.reduce((sum, run) => sum + (run.durationMs || 0), 0) / totalRuns)
        : undefined;

    const complexityBuckets: Record<PlanTaskComplexity, number[]> = {
      low: [],
      medium: [],
      high: [],
    };
    for (const run of completedRuns) {
      if (run.complexity && typeof run.durationMs === 'number') {
        complexityBuckets[run.complexity].push(run.durationMs);
      }
    }
    const averageDurationByComplexity: Partial<Record<PlanTaskComplexity, number>> = {};
    for (const [complexity, durations] of Object.entries(complexityBuckets)) {
      if (durations.length > 0) {
        averageDurationByComplexity[complexity as PlanTaskComplexity] = Math.round(
          durations.reduce((sum, value) => sum + value, 0) / durations.length
        );
      }
    }

    const tokenValues = completedRuns
      .map((run) => run.tokenEfficiency)
      .filter((value): value is number => typeof value === 'number');
    const tokenEfficiency =
      tokenValues.length > 0
        ? tokenValues.reduce((sum, value) => sum + value, 0) / tokenValues.length
        : undefined;

    let utilization: number | undefined;
    if (
      projectPath &&
      this.config?.projectPath === projectPath &&
      (this.config?.maxConcurrency || 0) > 0
    ) {
      utilization = Math.min(1, this.runningFeatures.size / this.config.maxConcurrency);
    }

    const stageTotals: Record<keyof AutoModeStageDurations, number> = {
      planningMs: 0,
      executionMs: 0,
      pipelineMs: 0,
      verificationMs: 0,
      judgeMs: 0,
    };
    const stageCounts: Record<keyof AutoModeStageDurations, number> = {
      planningMs: 0,
      executionMs: 0,
      pipelineMs: 0,
      verificationMs: 0,
      judgeMs: 0,
    };

    for (const run of completedRuns) {
      const durations = run.stageDurations;
      if (!durations) continue;
      for (const key of Object.keys(stageTotals) as Array<keyof AutoModeStageDurations>) {
        const value = durations[key];
        if (typeof value === 'number') {
          stageTotals[key] += value;
          stageCounts[key] += 1;
        }
      }
    }

    const stageLabels: Record<keyof AutoModeStageDurations, string> = {
      planningMs: 'planning',
      executionMs: 'execution',
      pipelineMs: 'pipeline',
      verificationMs: 'verification',
      judgeMs: 'judge',
    };
    let bottleneck: string | undefined;
    let bottleneckValue = 0;
    for (const key of Object.keys(stageTotals) as Array<keyof AutoModeStageDurations>) {
      const count = stageCounts[key];
      if (count === 0) continue;
      const average = stageTotals[key] / count;
      if (average > bottleneckValue) {
        bottleneckValue = average;
        bottleneck = stageLabels[key];
      }
    }

    return {
      totalRuns,
      successRate,
      revisionRate,
      averageDurationMs,
      averageDurationByComplexity,
      tokenEfficiency,
      utilization,
      bottleneck,
    };
  }

  private emitMetricsUpdate(projectPath: string, store: AutoModeMetricsStore): void {
    const summary = this.calculateMetricsSummary(store, projectPath);
    const latestRun = store.runs[store.runs.length - 1];
    this.emitAutoModeEvent('auto_mode_metrics_updated', {
      projectPath,
      summary,
      latestRun,
    });
  }

  private async updateMetricsStore(
    projectPath: string,
    updater: (store: AutoModeMetricsStore) => AutoModeMetricsStore
  ): Promise<AutoModeMetricsStore> {
    const current = await this.loadMetricsStore(projectPath);
    const updated = updater({
      ...current,
      runs: [...current.runs],
    });
    await this.saveMetricsStore(projectPath, updated);
    this.metricsByProject.set(projectPath, updated);
    this.emitMetricsUpdate(projectPath, updated);
    return updated;
  }

  private async startMetricsRun(
    projectPath: string,
    feature: Feature,
    model?: string,
    provider?: ModelProvider
  ): Promise<string> {
    const runId = `${feature.id}-${Date.now().toString(36)}`;
    const startedAt = new Date().toISOString();
    const complexity = this.getFeatureComplexity(feature);

    await this.updateMetricsStore(projectPath, (store) => {
      const run: AutoModeFeatureRunMetrics = {
        runId,
        featureId: feature.id,
        title: feature.title,
        startedAt,
        status: 'running',
        complexity,
        attempts: 1,
        revisions: 0,
        model,
        provider,
        stageDurations: {},
      };
      store.runs.push(run);
      return store;
    });

    return runId;
  }

  private async updateMetricsRun(
    projectPath: string,
    runId: string,
    updater: (run: AutoModeFeatureRunMetrics) => void
  ): Promise<void> {
    await this.updateMetricsStore(projectPath, (store) => {
      const run = store.runs.find((entry) => entry.runId === runId);
      if (run) {
        updater(run);
      }
      return store;
    });
  }

  private getFeatureComplexity(feature: Feature): PlanTaskComplexity | undefined {
    const tasks = feature.planSpec?.tasks;
    if (!tasks || tasks.length === 0) {
      return undefined;
    }

    const weights: Record<PlanTaskComplexity, number> = {
      low: 1,
      medium: 2,
      high: 3,
    };
    const total = tasks.reduce((sum, task) => {
      const complexity = task.complexity || 'medium';
      return sum + weights[complexity];
    }, 0);
    const average = total / tasks.length;

    if (average <= 1.5) {
      return 'low';
    }
    if (average <= 2.3) {
      return 'medium';
    }
    return 'high';
  }

  async getMetricsSnapshot(projectPath: string): Promise<AutoModeMetricsSnapshot> {
    const store = await this.loadMetricsStore(projectPath);
    const summary = this.calculateMetricsSummary(store, projectPath);
    return { ...store, summary };
  }

  /**
   * Start the auto mode loop - continuously picks and executes pending features
   */
  async startAutoLoop(projectPath: string, maxConcurrency = 3): Promise<void> {
    if (this.autoLoopRunning) {
      throw new Error('Auto mode is already running');
    }

    // Reset failure tracking when user manually starts auto mode
    this.resetFailureTracking();

    this.autoLoopRunning = true;
    this.autoLoopAbortController = new AbortController();
    this.config = {
      maxConcurrency,
      useWorktrees: true,
      projectPath,
    };

    this.emitAutoModeEvent('auto_mode_started', {
      message: `Auto mode started with max ${maxConcurrency} concurrent features`,
      projectPath,
    });

    // Save execution state for recovery after restart
    await this.saveExecutionState(projectPath);

    // Note: Memory folder initialization is now handled by loadContextFiles

    // Run the loop in the background
    this.runAutoLoop().catch((error) => {
      logger.error('Loop error:', error);
      const errorInfo = classifyError(error);
      this.emitAutoModeEvent('auto_mode_error', {
        error: errorInfo.message,
        errorType: errorInfo.type,
      });
    });
  }

  private async runAutoLoop(): Promise<void> {
    while (
      this.autoLoopRunning &&
      this.autoLoopAbortController &&
      !this.autoLoopAbortController.signal.aborted
    ) {
      try {
        // Check if we have capacity
        if (this.runningFeatures.size >= (this.config?.maxConcurrency || 3)) {
          await this.sleep(5000);
          continue;
        }

        // Load pending features
        const pendingFeatures = await this.loadPendingFeatures(this.config!.projectPath);

        if (pendingFeatures.length === 0) {
          this.emitAutoModeEvent('auto_mode_idle', {
            message: 'No pending features - auto mode idle',
            projectPath: this.config!.projectPath,
          });
          await this.sleep(10000);
          continue;
        }

        // Find a feature not currently running
        const nextFeature = pendingFeatures.find((f) => !this.runningFeatures.has(f.id));

        if (nextFeature) {
          // Start feature execution in background
          this.executeFeature(
            this.config!.projectPath,
            nextFeature.id,
            this.config!.useWorktrees,
            true
          ).catch((error) => {
            logger.error(`Feature ${nextFeature.id} error:`, error);
          });
        }

        await this.sleep(2000);
      } catch (error) {
        logger.error('Loop iteration error:', error);
        await this.sleep(5000);
      }
    }

    this.autoLoopRunning = false;
  }

  /**
   * Stop the auto mode loop
   */
  async stopAutoLoop(): Promise<number> {
    const wasRunning = this.autoLoopRunning;
    const projectPath = this.config?.projectPath;
    this.autoLoopRunning = false;
    if (this.autoLoopAbortController) {
      this.autoLoopAbortController.abort();
      this.autoLoopAbortController = null;
    }

    // Clear execution state when auto-loop is explicitly stopped
    if (projectPath) {
      await this.clearExecutionState(projectPath);
    }

    // Emit stop event immediately when user explicitly stops
    if (wasRunning) {
      this.emitAutoModeEvent('auto_mode_stopped', {
        message: 'Auto mode stopped',
        projectPath,
      });
    }

    return this.runningFeatures.size;
  }

  /**
   * Execute a single feature
   * @param projectPath - The main project path
   * @param featureId - The feature ID to execute
   * @param useWorktrees - Whether to use worktrees for isolation
   * @param isAutoMode - Whether this is running in auto mode
   */
  async executeFeature(
    projectPath: string,
    featureId: string,
    useWorktrees = false,
    isAutoMode = false,
    providedWorktreePath?: string,
    options?: {
      continuationPrompt?: string;
    }
  ): Promise<void> {
    if (this.runningFeatures.has(featureId)) {
      throw new Error('already running');
    }

    // Add to running features immediately to prevent race conditions
    const abortController = new AbortController();
    const tempRunningFeature: RunningFeature = {
      featureId,
      projectPath,
      worktreePath: null,
      branchName: null,
      abortController,
      isAutoMode,
      startTime: Date.now(),
    };
    this.runningFeatures.set(featureId, tempRunningFeature);
    let metricsRunId: string | undefined;

    // Save execution state when feature starts
    if (isAutoMode) {
      await this.saveExecutionState(projectPath);
    }

    try {
      // Validate that project path is allowed using centralized validation
      validateWorkingDirectory(projectPath);

      // Check if feature has existing context - if so, resume instead of starting fresh
      // Skip this check if we're already being called with a continuation prompt (from resumeFeature)
      if (!options?.continuationPrompt) {
        const hasExistingContext = await this.contextExists(projectPath, featureId);
        if (hasExistingContext) {
          logger.info(
            `Feature ${featureId} has existing context, resuming instead of starting fresh`
          );
          // Remove from running features temporarily, resumeFeature will add it back
          this.runningFeatures.delete(featureId);
          return this.resumeFeature(projectPath, featureId, useWorktrees);
        }
      }

      // Emit feature start event early
      this.emitAutoModeEvent('auto_mode_feature_start', {
        featureId,
        projectPath,
        feature: {
          id: featureId,
          title: 'Loading...',
          description: 'Feature is starting',
        },
      });
      // Load feature details FIRST to get branchName
      const feature = await this.loadFeature(projectPath, featureId);
      if (!feature) {
        throw new Error(`Feature ${featureId} not found`);
      }

      // Derive workDir from feature.branchName
      // Worktrees should already be created when the feature is added/edited
      let worktreePath: string | null = null;
      const branchName = feature.branchName;

      if (useWorktrees && branchName) {
        // Try to find existing worktree for this branch
        // Worktree should already exist (created when feature was added/edited)
        worktreePath = await this.findExistingWorktreeForBranch(projectPath, branchName);

        if (worktreePath) {
          logger.info(`Using worktree for branch "${branchName}": ${worktreePath}`);
        } else {
          // Worktree doesn't exist - log warning and continue with project path
          logger.warn(`Worktree for branch "${branchName}" not found, using project path`);
        }
      }

      // Ensure workDir is always an absolute path for cross-platform compatibility
      const workDir = worktreePath ? path.resolve(worktreePath) : path.resolve(projectPath);

      // Validate that working directory is allowed using centralized validation
      validateWorkingDirectory(workDir);

      // Update running feature with actual worktree info
      tempRunningFeature.worktreePath = worktreePath;
      tempRunningFeature.branchName = branchName ?? null;

      // Update feature status to in_progress
      await this.updateFeatureStatus(projectPath, featureId, 'in_progress');

      // Load autoLoadClaudeMd setting to determine context loading strategy
      const autoLoadClaudeMd = await getAutoLoadClaudeMdSetting(
        projectPath,
        this.settingsService,
        '[AutoMode]'
      );

      // Build the prompt - use continuation prompt if provided (for recovery after plan approval)
      let prompt: string;
      // Load project context files (CLAUDE.md, CODE_QUALITY.md, etc.) and memory files
      // Context loader uses task context to select relevant memory files
      const contextResult = await loadContextFiles({
        projectPath,
        fsModule: secureFs as Parameters<typeof loadContextFiles>[0]['fsModule'],
        taskContext: {
          title: feature.title ?? '',
          description: feature.description ?? '',
        },
      });

      // When autoLoadClaudeMd is enabled, filter out CLAUDE.md to avoid duplication
      // (SDK handles CLAUDE.md via settingSources), but keep other context files like CODE_QUALITY.md
      // Note: contextResult.formattedPrompt now includes both context AND memory
      const combinedSystemPrompt = filterClaudeMdFromContext(contextResult, autoLoadClaudeMd);

      const prompts = await getPromptCustomization(this.settingsService, '[AutoMode]');
      const rolePrompts: RolePromptConfig = {
        planner: prompts.autoMode.plannerSystemPrompt,
        worker: prompts.autoMode.workerSystemPrompt,
        judge: prompts.autoMode.judgeSystemPrompt,
        refactor: prompts.autoMode.refactorSystemPrompt,
      };
      const roleModels = await this.resolveRoleModels(feature);

      if (options?.continuationPrompt) {
        // Continuation prompt is used when recovering from a plan approval
        // The plan was already approved, so skip the planning phase
        prompt = options.continuationPrompt;
        logger.info(`Using continuation prompt for feature ${featureId}`);
      } else {
        // Normal flow: build prompt with planning phase
        const featurePrompt = this.buildFeaturePrompt(feature);
        const planningPrefix = await this.getPlanningPromptPrefix(feature);
        prompt = planningPrefix + featurePrompt;

        // Emit planning mode info
        if (feature.planningMode && feature.planningMode !== 'skip') {
          this.emitAutoModeEvent('planning_started', {
            featureId: feature.id,
            mode: feature.planningMode,
            message: `Starting ${feature.planningMode} planning phase`,
          });
        }
      }

      // Extract image paths from feature
      const imagePaths = feature.imagePaths?.map((img) =>
        typeof img === 'string' ? img : img.path
      );

      // Get model from worker role and determine provider
      const model = roleModels.worker.model;
      const provider = ProviderFactory.getProviderNameForModel(model);
      logger.info(
        `Executing feature ${featureId} with model: ${model}, provider: ${provider} in ${workDir}`
      );

      // Store model and provider in running feature for tracking
      tempRunningFeature.model = model;
      tempRunningFeature.provider = provider;

      // Run the agent with the feature's model and images
      // Context files are passed as system prompt for higher priority
      metricsRunId = await this.startMetricsRun(projectPath, feature, model, provider);
      tempRunningFeature.metricsRunId = metricsRunId;

      const executionStart = Date.now();
      await this.runAgent(
        workDir,
        featureId,
        prompt,
        abortController,
        projectPath,
        imagePaths,
        model,
        {
          projectPath,
          planningMode: feature.planningMode,
          requirePlanApproval: feature.requirePlanApproval,
          systemPrompt: combinedSystemPrompt || undefined,
          autoLoadClaudeMd,
          roleModels,
          rolePrompts,
        }
      );
      const executionDuration = Date.now() - executionStart;
      if (metricsRunId) {
        await this.updateMetricsRun(projectPath, metricsRunId, (run) => {
          run.stageDurations = run.stageDurations || {};
          run.stageDurations.executionMs =
            (run.stageDurations.executionMs || 0) + executionDuration;
        });
      }

      // Check for pipeline steps and execute them
      const pipelineConfig = await pipelineService.getPipelineConfig(projectPath);
      const sortedSteps = [...(pipelineConfig?.steps || [])].sort((a, b) => a.order - b.order);

      if (sortedSteps.length > 0) {
        const pipelineStart = Date.now();
        // Execute pipeline steps sequentially
        await this.executePipelineSteps(
          projectPath,
          featureId,
          feature,
          sortedSteps,
          workDir,
          abortController,
          autoLoadClaudeMd,
          roleModels,
          rolePrompts
        );
        const pipelineDuration = Date.now() - pipelineStart;
        if (metricsRunId) {
          await this.updateMetricsRun(projectPath, metricsRunId, (run) => {
            run.stageDurations = run.stageDurations || {};
            run.stageDurations.pipelineMs = (run.stageDurations.pipelineMs || 0) + pipelineDuration;
          });
        }
      }

      const loadAgentContext = async (): Promise<string> => {
        const featureDir = getFeatureDir(projectPath, featureId);
        const outputPath = path.join(featureDir, 'agent-output.md');
        try {
          const outputContent = await secureFs.readFile(outputPath, 'utf-8');
          return typeof outputContent === 'string' ? outputContent : outputContent.toString();
        } catch {
          return '';
        }
      };

      const runRevision = async (revisionPrompt: string): Promise<number> => {
        const previousContext = await loadAgentContext();
        const revisionStart = Date.now();
        await this.runAgent(
          workDir,
          featureId,
          revisionPrompt,
          abortController,
          projectPath,
          imagePaths,
          model,
          {
            projectPath,
            planningMode: 'skip',
            requirePlanApproval: false,
            previousContent: previousContext,
            systemPrompt: combinedSystemPrompt || undefined,
            autoLoadClaudeMd,
            roleModels,
            rolePrompts,
          }
        );
        const revisionDuration = Date.now() - revisionStart;
        if (metricsRunId) {
          await this.updateMetricsRun(projectPath, metricsRunId, (run) => {
            run.attempts += 1;
            run.revisions += 1;
            run.stageDurations = run.stageDurations || {};
            run.stageDurations.executionMs =
              (run.stageDurations.executionMs || 0) + revisionDuration;
          });
        }
        return revisionDuration;
      };

      const refreshedFeature = await this.loadFeature(projectPath, featureId);
      if (metricsRunId && refreshedFeature) {
        const complexity = this.getFeatureComplexity(refreshedFeature);
        await this.updateMetricsRun(projectPath, metricsRunId, (run) => {
          run.complexity = complexity || run.complexity;
          run.title = refreshedFeature.title || run.title;
        });
      }

      let verificationDuration = 0;
      let qualityOutcome: QualityCheckOutcome | null = null;
      let qualityPassed = true;

      if (feature.skipTests) {
        const skippedChecks: QualityGateResult[] = [
          { name: 'Lint', status: 'skipped' },
          { name: 'Type check', status: 'skipped' },
          { name: 'Tests', status: 'skipped' },
          { name: 'Build', status: 'skipped' },
        ];
        qualityOutcome = {
          passed: true,
          results: skippedChecks,
          metrics: { checks: skippedChecks },
        };
        this.emitAutoModeEvent('auto_mode_quality_metrics', {
          featureId,
          projectPath,
          passed: true,
          attempt: 0,
          checks: skippedChecks,
        });
        if (metricsRunId) {
          await this.updateMetricsRun(projectPath, metricsRunId, (run) => {
            run.quality = qualityOutcome?.metrics;
          });
        }
      } else {
        const verificationStart = Date.now();
        qualityOutcome = await this.runQualityChecks({
          workDir,
          featureId,
          projectPath,
          attempt: 0,
        });
        verificationDuration += Date.now() - verificationStart;
        qualityPassed = qualityOutcome.passed;
        if (metricsRunId) {
          await this.updateMetricsRun(projectPath, metricsRunId, (run) => {
            run.quality = qualityOutcome?.metrics;
            run.stageDurations = run.stageDurations || {};
            run.stageDurations.verificationMs =
              (run.stageDurations.verificationMs || 0) + verificationDuration;
          });
        }

        let qualityFixes = 0;
        while (!qualityPassed && qualityFixes < MAX_QUALITY_FIX_ATTEMPTS) {
          qualityFixes += 1;
          await runRevision(this.buildQualityFixPrompt(feature, qualityOutcome!.metrics));

          const retryStart = Date.now();
          qualityOutcome = await this.runQualityChecks({
            workDir,
            featureId,
            projectPath,
            attempt: qualityFixes,
          });
          const retryDuration = Date.now() - retryStart;
          verificationDuration += retryDuration;
          qualityPassed = qualityOutcome.passed;

          if (metricsRunId) {
            await this.updateMetricsRun(projectPath, metricsRunId, (run) => {
              run.quality = qualityOutcome?.metrics;
              run.stageDurations = run.stageDurations || {};
              run.stageDurations.verificationMs =
                (run.stageDurations.verificationMs || 0) + retryDuration;
            });
          }
        }
      }

      let judgeDuration = 0;
      let judgeResult: JudgeResult | null = null;
      let judgePassed = true;

      if (qualityPassed) {
        const agentContext = await loadAgentContext();
        const judgeStart = Date.now();
        judgeResult = await this.runJudgeEvaluation({
          workDir,
          projectPath,
          feature,
          agentOutput: agentContext,
          qualityMetrics: qualityOutcome?.metrics,
          systemPrompt: combinedSystemPrompt || undefined,
          roleModels,
          rolePrompts,
        });
        judgeDuration += Date.now() - judgeStart;
        judgePassed = judgeResult.verdict === 'pass';

        if (metricsRunId) {
          await this.updateMetricsRun(projectPath, metricsRunId, (run) => {
            run.stageDurations = run.stageDurations || {};
            run.stageDurations.judgeMs = (run.stageDurations.judgeMs || 0) + judgeDuration;
          });
        }

        let judgeRevisions = 0;
        while (!judgePassed && judgeRevisions < MAX_JUDGE_REVISIONS) {
          judgeRevisions += 1;
          await runRevision(this.buildJudgeFixPrompt(feature, judgeResult!));

          const retryContext = await loadAgentContext();
          const judgeRetryStart = Date.now();
          judgeResult = await this.runJudgeEvaluation({
            workDir,
            projectPath,
            feature,
            agentOutput: retryContext,
            qualityMetrics: qualityOutcome?.metrics,
            systemPrompt: combinedSystemPrompt || undefined,
            roleModels,
            rolePrompts,
          });
          const retryDuration = Date.now() - judgeRetryStart;
          judgeDuration += retryDuration;
          judgePassed = judgeResult.verdict === 'pass';

          if (metricsRunId) {
            await this.updateMetricsRun(projectPath, metricsRunId, (run) => {
              run.stageDurations = run.stageDurations || {};
              run.stageDurations.judgeMs = (run.stageDurations.judgeMs || 0) + retryDuration;
            });
          }
        }
      }

      const passedGates = qualityPassed && judgePassed;

      // Determine final status based on testing mode:
      // - skipTests=false (automated testing): go directly to 'verified' (no manual verify needed)
      // - skipTests=true (manual verification): go to 'waiting_approval' for manual review
      const finalStatus = passedGates && !feature.skipTests ? 'verified' : 'waiting_approval';
      await this.updateFeatureStatus(projectPath, featureId, finalStatus);

      if (metricsRunId) {
        await this.updateMetricsRun(projectPath, metricsRunId, (run) => {
          run.status = passedGates ? 'success' : 'failed';
          run.completedAt = new Date().toISOString();
          run.durationMs = Date.now() - tempRunningFeature.startTime;
        });
      }

      if (passedGates) {
        // Record success to reset consecutive failure tracking
        this.recordSuccess();
      } else {
        const shouldPause = this.trackFailureAndCheckPause({
          type: 'quality_gate',
          message: 'Quality gates failed',
        });
        if (shouldPause) {
          this.signalShouldPause({
            type: 'quality_gate',
            message: 'Quality gates failed',
          });
        }
      }

      // Record learnings and memory usage after feature completion
      try {
        const featureDir = getFeatureDir(projectPath, featureId);
        const outputPath = path.join(featureDir, 'agent-output.md');
        let agentOutput = '';
        try {
          const outputContent = await secureFs.readFile(outputPath, 'utf-8');
          agentOutput =
            typeof outputContent === 'string' ? outputContent : outputContent.toString();
        } catch {
          // Agent output might not exist yet
        }

        // Record memory usage if we loaded any memory files
        if (contextResult.memoryFiles.length > 0 && agentOutput) {
          await recordMemoryUsage(
            projectPath,
            contextResult.memoryFiles,
            agentOutput,
            passedGates, // success
            secureFs as Parameters<typeof recordMemoryUsage>[4]
          );
        }

        if (metricsRunId && agentOutput) {
          const tokenEfficiency = await this.calculateTokenEfficiency(agentOutput, workDir);
          if (typeof tokenEfficiency === 'number') {
            await this.updateMetricsRun(projectPath, metricsRunId, (run) => {
              run.tokenEfficiency = tokenEfficiency;
            });
          }
        }

        // Extract and record learnings from the agent output
        await this.recordLearningsFromFeature(projectPath, feature, agentOutput);
      } catch (learningError) {
        console.warn('[AutoMode] Failed to record learnings:', learningError);
      }

      this.emitAutoModeEvent('auto_mode_feature_complete', {
        featureId,
        passes: passedGates,
        message: `Feature completed in ${Math.round(
          (Date.now() - tempRunningFeature.startTime) / 1000
        )}s${finalStatus === 'verified' ? ' - auto-verified' : ''}${
          passedGates ? '' : ' - review required'
        }`,
        projectPath,
        model: tempRunningFeature.model,
        provider: tempRunningFeature.provider,
      });
    } catch (error) {
      const errorInfo = classifyError(error);

      if (errorInfo.isAbort) {
        this.emitAutoModeEvent('auto_mode_feature_complete', {
          featureId,
          passes: false,
          message: 'Feature stopped by user',
          projectPath,
        });
      } else {
        logger.error(`Feature ${featureId} failed:`, error);
        await this.updateFeatureStatus(projectPath, featureId, 'backlog');
        this.emitAutoModeEvent('auto_mode_error', {
          featureId,
          error: errorInfo.message,
          errorType: errorInfo.type,
          projectPath,
        });

        // Track this failure and check if we should pause auto mode
        // This handles both specific quota/rate limit errors AND generic failures
        // that may indicate quota exhaustion (SDK doesn't always return useful errors)
        const shouldPause = this.trackFailureAndCheckPause({
          type: errorInfo.type,
          message: errorInfo.message,
        });

        if (shouldPause) {
          this.signalShouldPause({
            type: errorInfo.type,
            message: errorInfo.message,
          });
        }
      }

      if (metricsRunId) {
        try {
          await this.updateMetricsRun(projectPath, metricsRunId, (run) => {
            run.status = 'failed';
            run.completedAt = new Date().toISOString();
            run.durationMs = Date.now() - tempRunningFeature.startTime;
          });
        } catch (metricsError) {
          logger.warn('Failed to update metrics after error:', metricsError);
        }
      }
    } finally {
      logger.info(`Feature ${featureId} execution ended, cleaning up runningFeatures`);
      logger.info(
        `Pending approvals at cleanup: ${Array.from(this.pendingApprovals.keys()).join(', ') || 'none'}`
      );
      this.runningFeatures.delete(featureId);

      // Update execution state after feature completes
      if (this.autoLoopRunning && projectPath) {
        await this.saveExecutionState(projectPath);
      }
    }
  }

  /**
   * Execute pipeline steps sequentially after initial feature implementation
   */
  private async executePipelineSteps(
    projectPath: string,
    featureId: string,
    feature: Feature,
    steps: PipelineStep[],
    workDir: string,
    abortController: AbortController,
    autoLoadClaudeMd: boolean,
    roleModels: Record<string, RoleModelConfig>,
    rolePrompts: RolePromptConfig
  ): Promise<void> {
    logger.info(`Executing ${steps.length} pipeline step(s) for feature ${featureId}`);

    // Load context files once with feature context for smart memory selection
    const contextResult = await loadContextFiles({
      projectPath,
      fsModule: secureFs as Parameters<typeof loadContextFiles>[0]['fsModule'],
      taskContext: {
        title: feature.title ?? '',
        description: feature.description ?? '',
      },
    });
    const contextFilesPrompt = filterClaudeMdFromContext(contextResult, autoLoadClaudeMd);

    // Load previous agent output for context continuity
    const featureDir = getFeatureDir(projectPath, featureId);
    const contextPath = path.join(featureDir, 'agent-output.md');
    let previousContext = '';
    try {
      previousContext = (await secureFs.readFile(contextPath, 'utf-8')) as string;
    } catch {
      // No previous context
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const pipelineStatus = `pipeline_${step.id}`;

      // Update feature status to current pipeline step
      await this.updateFeatureStatus(projectPath, featureId, pipelineStatus);

      this.emitAutoModeEvent('auto_mode_progress', {
        featureId,
        content: `Starting pipeline step ${i + 1}/${steps.length}: ${step.name}`,
        projectPath,
      });

      this.emitAutoModeEvent('pipeline_step_started', {
        featureId,
        stepId: step.id,
        stepName: step.name,
        stepIndex: i,
        totalSteps: steps.length,
        projectPath,
      });

      // Build prompt for this pipeline step
      const prompt = this.buildPipelineStepPrompt(step, feature, previousContext);

      // Use worker role model for pipeline steps
      const model = roleModels.worker.model;

      // Run the agent for this pipeline step
      await this.runAgent(
        workDir,
        featureId,
        prompt,
        abortController,
        projectPath,
        undefined, // no images for pipeline steps
        model,
        {
          projectPath,
          planningMode: 'skip', // Pipeline steps don't need planning
          requirePlanApproval: false,
          previousContent: previousContext,
          systemPrompt: contextFilesPrompt || undefined,
          autoLoadClaudeMd,
          roleModels,
          rolePrompts,
        }
      );

      // Load updated context for next step
      try {
        previousContext = (await secureFs.readFile(contextPath, 'utf-8')) as string;
      } catch {
        // No context update
      }

      this.emitAutoModeEvent('pipeline_step_complete', {
        featureId,
        stepId: step.id,
        stepName: step.name,
        stepIndex: i,
        totalSteps: steps.length,
        projectPath,
      });

      logger.info(
        `Pipeline step ${i + 1}/${steps.length} (${step.name}) completed for feature ${featureId}`
      );
    }

    logger.info(`All pipeline steps completed for feature ${featureId}`);
  }

  /**
   * Build the prompt for a pipeline step
   */
  private buildPipelineStepPrompt(
    step: PipelineStep,
    feature: Feature,
    previousContext: string
  ): string {
    let prompt = `## Pipeline Step: ${step.name}

This is an automated pipeline step following the initial feature implementation.

### Feature Context
${this.buildFeaturePrompt(feature)}

`;

    if (previousContext) {
      prompt += `### Previous Work
The following is the output from the previous work on this feature:

${previousContext}

`;
    }

    prompt += `### Pipeline Step Instructions
${step.instructions}

### Task
Complete the pipeline step instructions above. Review the previous work and apply the required changes or actions.`;

    return prompt;
  }

  /**
   * Stop a specific feature
   */
  async stopFeature(featureId: string): Promise<boolean> {
    const running = this.runningFeatures.get(featureId);
    if (!running) {
      return false;
    }

    // Cancel any pending plan approval for this feature
    this.cancelPlanApproval(featureId);

    running.abortController.abort();

    // Remove from running features immediately to allow resume
    // The abort signal will still propagate to stop any ongoing execution
    this.runningFeatures.delete(featureId);

    return true;
  }

  /**
   * Resume a feature (continues from saved context)
   */
  async resumeFeature(projectPath: string, featureId: string, useWorktrees = false): Promise<void> {
    if (this.runningFeatures.has(featureId)) {
      throw new Error('already running');
    }

    // Load feature to check status
    const feature = await this.loadFeature(projectPath, featureId);
    if (!feature) {
      throw new Error(`Feature ${featureId} not found`);
    }

    // Check if feature is stuck in a pipeline step
    const pipelineInfo = await this.detectPipelineStatus(
      projectPath,
      featureId,
      (feature.status || '') as FeatureStatusWithPipeline
    );

    if (pipelineInfo.isPipeline) {
      // Feature stuck in pipeline - use pipeline resume
      return this.resumePipelineFeature(projectPath, feature, useWorktrees, pipelineInfo);
    }

    // Normal resume flow for non-pipeline features
    // Check if context exists in .automaker directory
    const featureDir = getFeatureDir(projectPath, featureId);
    const contextPath = path.join(featureDir, 'agent-output.md');

    let hasContext = false;
    try {
      await secureFs.access(contextPath);
      hasContext = true;
    } catch {
      // No context
    }

    if (hasContext) {
      // Load previous context and continue
      const context = (await secureFs.readFile(contextPath, 'utf-8')) as string;
      return this.executeFeatureWithContext(projectPath, featureId, context, useWorktrees);
    }

    // No context, start fresh - executeFeature will handle adding to runningFeatures
    return this.executeFeature(projectPath, featureId, useWorktrees, false);
  }

  /**
   * Resume a feature that crashed during pipeline execution.
   * Handles multiple edge cases to ensure robust recovery:
   * - No context file: Restart entire pipeline from beginning
   * - Step deleted from config: Complete feature without remaining pipeline steps
   * - Valid step exists: Resume from the crashed step and continue
   *
   * @param {string} projectPath - Absolute path to the project directory
   * @param {Feature} feature - The feature object (already loaded to avoid redundant reads)
   * @param {boolean} useWorktrees - Whether to use git worktrees for isolation
   * @param {PipelineStatusInfo} pipelineInfo - Information about the pipeline status from detectPipelineStatus()
   * @returns {Promise<void>} Resolves when resume operation completes or throws on error
   * @throws {Error} If pipeline config is null but stepIndex is valid (should never happen)
   * @private
   */
  private async resumePipelineFeature(
    projectPath: string,
    feature: Feature,
    useWorktrees: boolean,
    pipelineInfo: PipelineStatusInfo
  ): Promise<void> {
    const featureId = feature.id;
    console.log(
      `[AutoMode] Resuming feature ${featureId} from pipeline step ${pipelineInfo.stepId}`
    );

    // Check for context file
    const featureDir = getFeatureDir(projectPath, featureId);
    const contextPath = path.join(featureDir, 'agent-output.md');

    let hasContext = false;
    try {
      await secureFs.access(contextPath);
      hasContext = true;
    } catch {
      // No context
    }

    // Edge Case 1: No context file - restart entire pipeline from beginning
    if (!hasContext) {
      console.warn(
        `[AutoMode] No context found for pipeline feature ${featureId}, restarting from beginning`
      );

      // Reset status to in_progress and start fresh
      await this.updateFeatureStatus(projectPath, featureId, 'in_progress');

      return this.executeFeature(projectPath, featureId, useWorktrees, false);
    }

    // Edge Case 2: Step no longer exists in pipeline config
    if (pipelineInfo.stepIndex === -1) {
      console.warn(
        `[AutoMode] Step ${pipelineInfo.stepId} no longer exists in pipeline, completing feature without pipeline`
      );

      const finalStatus = feature.skipTests ? 'waiting_approval' : 'verified';

      await this.updateFeatureStatus(projectPath, featureId, finalStatus);

      this.emitAutoModeEvent('auto_mode_feature_complete', {
        featureId,
        passes: true,
        message:
          'Pipeline step no longer exists - feature completed without remaining pipeline steps',
        projectPath,
      });

      return;
    }

    // Normal case: Valid pipeline step exists, has context
    // Resume from the stuck step (re-execute the step that crashed)
    if (!pipelineInfo.config) {
      throw new Error('Pipeline config is null but stepIndex is valid - this should not happen');
    }

    return this.resumeFromPipelineStep(
      projectPath,
      feature,
      useWorktrees,
      pipelineInfo.stepIndex,
      pipelineInfo.config
    );
  }

  /**
   * Resume pipeline execution from a specific step index.
   * Re-executes the step that crashed (to handle partial completion),
   * then continues executing all remaining pipeline steps in order.
   *
   * This method handles the complete pipeline resume workflow:
   * - Validates feature and step index
   * - Locates or creates git worktree if needed
   * - Executes remaining steps starting from the crashed step
   * - Updates feature status to verified/waiting_approval when complete
   * - Emits progress events throughout execution
   *
   * @param {string} projectPath - Absolute path to the project directory
   * @param {Feature} feature - The feature object (already loaded to avoid redundant reads)
   * @param {boolean} useWorktrees - Whether to use git worktrees for isolation
   * @param {number} startFromStepIndex - Zero-based index of the step to resume from
   * @param {PipelineConfig} pipelineConfig - Pipeline config passed from detectPipelineStatus to avoid re-reading
   * @returns {Promise<void>} Resolves when pipeline execution completes successfully
   * @throws {Error} If feature not found, step index invalid, or pipeline execution fails
   * @private
   */
  private async resumeFromPipelineStep(
    projectPath: string,
    feature: Feature,
    useWorktrees: boolean,
    startFromStepIndex: number,
    pipelineConfig: PipelineConfig
  ): Promise<void> {
    const featureId = feature.id;

    const sortedSteps = [...pipelineConfig.steps].sort((a, b) => a.order - b.order);

    // Validate step index
    if (startFromStepIndex < 0 || startFromStepIndex >= sortedSteps.length) {
      throw new Error(`Invalid step index: ${startFromStepIndex}`);
    }

    // Get steps to execute (from startFromStepIndex onwards)
    const stepsToExecute = sortedSteps.slice(startFromStepIndex);

    console.log(
      `[AutoMode] Resuming pipeline for feature ${featureId} from step ${startFromStepIndex + 1}/${sortedSteps.length}`
    );

    // Add to running features immediately
    const abortController = new AbortController();
    this.runningFeatures.set(featureId, {
      featureId,
      projectPath,
      worktreePath: null, // Will be set below
      branchName: feature.branchName ?? null,
      abortController,
      isAutoMode: false,
      startTime: Date.now(),
    });

    try {
      // Validate project path
      validateWorkingDirectory(projectPath);

      // Derive workDir from feature.branchName
      let worktreePath: string | null = null;
      const branchName = feature.branchName;

      if (useWorktrees && branchName) {
        worktreePath = await this.findExistingWorktreeForBranch(projectPath, branchName);
        if (worktreePath) {
          console.log(`[AutoMode] Using worktree for branch "${branchName}": ${worktreePath}`);
        } else {
          console.warn(
            `[AutoMode] Worktree for branch "${branchName}" not found, using project path`
          );
        }
      }

      const workDir = worktreePath ? path.resolve(worktreePath) : path.resolve(projectPath);
      validateWorkingDirectory(workDir);

      // Update running feature with worktree info
      const runningFeature = this.runningFeatures.get(featureId);
      if (runningFeature) {
        runningFeature.worktreePath = worktreePath;
        runningFeature.branchName = branchName ?? null;
      }

      // Emit resume event
      this.emitAutoModeEvent('auto_mode_feature_start', {
        featureId,
        projectPath,
        feature: {
          id: featureId,
          title: feature.title || 'Resuming Pipeline',
          description: feature.description,
        },
      });

      this.emitAutoModeEvent('auto_mode_progress', {
        featureId,
        content: `Resuming from pipeline step ${startFromStepIndex + 1}/${sortedSteps.length}`,
        projectPath,
      });

      // Load autoLoadClaudeMd setting
      const autoLoadClaudeMd = await getAutoLoadClaudeMdSetting(
        projectPath,
        this.settingsService,
        '[AutoMode]'
      );

      // Execute remaining pipeline steps (starting from crashed step)
      await this.executePipelineSteps(
        projectPath,
        featureId,
        feature,
        stepsToExecute,
        workDir,
        abortController,
        autoLoadClaudeMd
      );

      // Determine final status
      const finalStatus = feature.skipTests ? 'waiting_approval' : 'verified';
      await this.updateFeatureStatus(projectPath, featureId, finalStatus);

      console.log('[AutoMode] Pipeline resume completed successfully');

      this.emitAutoModeEvent('auto_mode_feature_complete', {
        featureId,
        passes: true,
        message: 'Pipeline resumed and completed successfully',
        projectPath,
      });
    } catch (error) {
      const errorInfo = classifyError(error);

      if (errorInfo.isAbort) {
        this.emitAutoModeEvent('auto_mode_feature_complete', {
          featureId,
          passes: false,
          message: 'Pipeline resume stopped by user',
          projectPath,
        });
      } else {
        console.error(`[AutoMode] Pipeline resume failed for feature ${featureId}:`, error);
        await this.updateFeatureStatus(projectPath, featureId, 'backlog');
        this.emitAutoModeEvent('auto_mode_error', {
          featureId,
          error: errorInfo.message,
          errorType: errorInfo.type,
          projectPath,
        });
      }
    } finally {
      this.runningFeatures.delete(featureId);
    }
  }

  /**
   * Follow up on a feature with additional instructions
   */
  async followUpFeature(
    projectPath: string,
    featureId: string,
    prompt: string,
    imagePaths?: string[],
    useWorktrees = true
  ): Promise<void> {
    // Validate project path early for fast failure
    validateWorkingDirectory(projectPath);

    if (this.runningFeatures.has(featureId)) {
      throw new Error(`Feature ${featureId} is already running`);
    }

    const abortController = new AbortController();

    // Load feature info for context FIRST to get branchName
    const feature = await this.loadFeature(projectPath, featureId);

    // Derive workDir from feature.branchName
    // If no branchName, derive from feature ID: feature/{featureId}
    let workDir = path.resolve(projectPath);
    let worktreePath: string | null = null;
    const branchName = feature?.branchName || `feature/${featureId}`;

    if (useWorktrees && branchName) {
      // Try to find existing worktree for this branch
      worktreePath = await this.findExistingWorktreeForBranch(projectPath, branchName);

      if (worktreePath) {
        workDir = worktreePath;
        logger.info(`Follow-up using worktree for branch "${branchName}": ${workDir}`);
      }
    }

    // Load previous agent output if it exists
    const featureDir = getFeatureDir(projectPath, featureId);
    const contextPath = path.join(featureDir, 'agent-output.md');
    let previousContext = '';
    try {
      previousContext = (await secureFs.readFile(contextPath, 'utf-8')) as string;
    } catch {
      // No previous context
    }

    // Load autoLoadClaudeMd setting to determine context loading strategy
    const autoLoadClaudeMd = await getAutoLoadClaudeMdSetting(
      projectPath,
      this.settingsService,
      '[AutoMode]'
    );

    // Load project context files (CLAUDE.md, CODE_QUALITY.md, etc.) - passed as system prompt
    const contextResult = await loadContextFiles({
      projectPath,
      fsModule: secureFs as Parameters<typeof loadContextFiles>[0]['fsModule'],
      taskContext: {
        title: feature?.title ?? prompt.substring(0, 200),
        description: feature?.description ?? prompt,
      },
    });

    // When autoLoadClaudeMd is enabled, filter out CLAUDE.md to avoid duplication
    // (SDK handles CLAUDE.md via settingSources), but keep other context files like CODE_QUALITY.md
    const contextFilesPrompt = filterClaudeMdFromContext(contextResult, autoLoadClaudeMd);

    const prompts = await getPromptCustomization(this.settingsService, '[AutoMode] Follow-up');
    const rolePrompts: RolePromptConfig = {
      planner: prompts.autoMode.plannerSystemPrompt,
      worker: prompts.autoMode.workerSystemPrompt,
      judge: prompts.autoMode.judgeSystemPrompt,
      refactor: prompts.autoMode.refactorSystemPrompt,
    };
    const roleModels = await this.resolveRoleModels(
      feature ??
        ({
          id: featureId,
          category: 'general',
          description: prompt,
        } as Feature)
    );

    // Build complete prompt with feature info, previous context, and follow-up instructions
    let fullPrompt = `## Follow-up on Feature Implementation

${feature ? this.buildFeaturePrompt(feature) : `**Feature ID:** ${featureId}`}
`;

    if (previousContext) {
      fullPrompt += `
## Previous Agent Work
The following is the output from the previous implementation attempt:

${previousContext}
`;
    }

    fullPrompt += `
## Follow-up Instructions
${prompt}

## Task
Address the follow-up instructions above. Review the previous work and make the requested changes or fixes.`;

    // Use worker role model for follow-up execution
    const model = roleModels.worker.model;
    const provider = ProviderFactory.getProviderNameForModel(model);
    logger.info(`Follow-up for feature ${featureId} using model: ${model}, provider: ${provider}`);

    this.runningFeatures.set(featureId, {
      featureId,
      projectPath,
      worktreePath,
      branchName,
      abortController,
      isAutoMode: false,
      startTime: Date.now(),
      model,
      provider,
    });

    this.emitAutoModeEvent('auto_mode_feature_start', {
      featureId,
      projectPath,
      feature: feature || {
        id: featureId,
        title: 'Follow-up',
        description: prompt.substring(0, 100),
      },
      model,
      provider,
    });

    try {
      // Update feature status to in_progress
      await this.updateFeatureStatus(projectPath, featureId, 'in_progress');

      // Copy follow-up images to feature folder
      const copiedImagePaths: string[] = [];
      if (imagePaths && imagePaths.length > 0) {
        const featureDirForImages = getFeatureDir(projectPath, featureId);
        const featureImagesDir = path.join(featureDirForImages, 'images');

        await secureFs.mkdir(featureImagesDir, { recursive: true });

        for (const imagePath of imagePaths) {
          try {
            // Get the filename from the path
            const filename = path.basename(imagePath);
            const destPath = path.join(featureImagesDir, filename);

            // Copy the image
            await secureFs.copyFile(imagePath, destPath);

            // Store the absolute path (external storage uses absolute paths)
            copiedImagePaths.push(destPath);
          } catch (error) {
            logger.error(`Failed to copy follow-up image ${imagePath}:`, error);
          }
        }
      }

      // Update feature object with new follow-up images BEFORE building prompt
      if (copiedImagePaths.length > 0 && feature) {
        const currentImagePaths = feature.imagePaths || [];
        const newImagePaths = copiedImagePaths.map((p) => ({
          path: p,
          filename: path.basename(p),
          mimeType: 'image/png', // Default, could be improved
        }));

        feature.imagePaths = [...currentImagePaths, ...newImagePaths];
      }

      // Combine original feature images with new follow-up images
      const allImagePaths: string[] = [];

      // Add all images from feature (now includes both original and new)
      if (feature?.imagePaths) {
        const allPaths = feature.imagePaths.map((img) =>
          typeof img === 'string' ? img : img.path
        );
        allImagePaths.push(...allPaths);
      }

      // Save updated feature.json with new images
      if (copiedImagePaths.length > 0 && feature) {
        const featureDirForSave = getFeatureDir(projectPath, featureId);
        const featurePath = path.join(featureDirForSave, 'feature.json');

        try {
          await secureFs.writeFile(featurePath, JSON.stringify(feature, null, 2));
        } catch (error) {
          logger.error(`Failed to save feature.json:`, error);
        }
      }

      // Use fullPrompt (already built above) with model and all images
      // Note: Follow-ups skip planning mode - they continue from previous work
      // Pass previousContext so the history is preserved in the output file
      // Context files are passed as system prompt for higher priority
      await this.runAgent(
        workDir,
        featureId,
        fullPrompt,
        abortController,
        projectPath,
        allImagePaths.length > 0 ? allImagePaths : imagePaths,
        model,
        {
          projectPath,
          planningMode: 'skip', // Follow-ups don't require approval
          previousContent: previousContext || undefined,
          systemPrompt: contextFilesPrompt || undefined,
          autoLoadClaudeMd,
          roleModels,
          rolePrompts,
        }
      );

      // Determine final status based on testing mode:
      // - skipTests=false (automated testing): go directly to 'verified' (no manual verify needed)
      // - skipTests=true (manual verification): go to 'waiting_approval' for manual review
      const finalStatus = feature?.skipTests ? 'waiting_approval' : 'verified';
      await this.updateFeatureStatus(projectPath, featureId, finalStatus);

      // Record success to reset consecutive failure tracking
      this.recordSuccess();

      this.emitAutoModeEvent('auto_mode_feature_complete', {
        featureId,
        passes: true,
        message: `Follow-up completed successfully${finalStatus === 'verified' ? ' - auto-verified' : ''}`,
        projectPath,
        model,
        provider,
      });
    } catch (error) {
      const errorInfo = classifyError(error);
      if (!errorInfo.isCancellation) {
        this.emitAutoModeEvent('auto_mode_error', {
          featureId,
          error: errorInfo.message,
          errorType: errorInfo.type,
          projectPath,
        });

        // Track this failure and check if we should pause auto mode
        const shouldPause = this.trackFailureAndCheckPause({
          type: errorInfo.type,
          message: errorInfo.message,
        });

        if (shouldPause) {
          this.signalShouldPause({
            type: errorInfo.type,
            message: errorInfo.message,
          });
        }
      }
    } finally {
      this.runningFeatures.delete(featureId);
    }
  }

  /**
   * Verify a feature's implementation
   */
  private async runQualityChecks(options: {
    workDir: string;
    featureId: string;
    projectPath: string;
    attempt?: number;
  }): Promise<QualityCheckOutcome> {
    const verificationChecks = [
      { cmd: 'npm run lint', name: 'Lint' },
      { cmd: 'npm run typecheck', name: 'Type check' },
      { cmd: 'npm test', name: 'Tests' },
      { cmd: 'npm run build', name: 'Build' },
    ];

    const results: QualityGateResult[] = [];
    let allPassed = true;

    const clampOutput = (value: string): string =>
      value.length > 4000 ? value.slice(-4000) : value;

    for (let index = 0; index < verificationChecks.length; index++) {
      const check = verificationChecks[index];
      const start = Date.now();
      try {
        const { stdout, stderr } = await execAsync(check.cmd, {
          cwd: options.workDir,
          timeout: 120000,
        });
        results.push({
          name: check.name,
          status: 'pass',
          durationMs: Date.now() - start,
          output: stdout || stderr ? clampOutput(String(stdout || stderr)) : undefined,
        });
      } catch (error) {
        const err = error as { stdout?: string; stderr?: string; message?: string };
        results.push({
          name: check.name,
          status: 'fail',
          durationMs: Date.now() - start,
          output: clampOutput(String(err.stdout || err.stderr || err.message || 'Unknown error')),
        });
        allPassed = false;

        // Mark remaining checks as skipped
        for (let remaining = index + 1; remaining < verificationChecks.length; remaining++) {
          const skipped = verificationChecks[remaining];
          results.push({
            name: skipped.name,
            status: 'skipped',
          });
        }
        break;
      }
    }

    const metrics: FeatureQualityMetrics = { checks: results };

    this.emitAutoModeEvent('auto_mode_quality_metrics', {
      featureId: options.featureId,
      projectPath: options.projectPath,
      passed: allPassed,
      attempt: options.attempt ?? 0,
      checks: results,
    });

    return { passed: allPassed, results, metrics };
  }

  async verifyFeature(projectPath: string, featureId: string): Promise<boolean> {
    // Worktrees are in project dir
    const worktreePath = path.join(projectPath, '.worktrees', featureId);
    let workDir = projectPath;

    try {
      await secureFs.access(worktreePath);
      workDir = worktreePath;
    } catch {
      // No worktree
    }

    const qualityOutcome = await this.runQualityChecks({
      workDir,
      featureId,
      projectPath,
    });
    const allPassed = qualityOutcome.passed;

    this.emitAutoModeEvent('auto_mode_feature_complete', {
      featureId,
      passes: allPassed,
      message: allPassed
        ? 'All verification checks passed'
        : `Verification failed: ${qualityOutcome.results.find((r) => r.status === 'fail')?.name || 'Unknown'}`,
    });

    return allPassed;
  }

  private async runJudgeEvaluation(options: {
    workDir: string;
    projectPath: string;
    feature: Feature;
    agentOutput: string;
    qualityMetrics?: FeatureQualityMetrics;
    systemPrompt?: string;
    roleModels: Record<string, RoleModelConfig>;
    rolePrompts: RolePromptConfig;
  }): Promise<JudgeResult> {
    try {
      const judgeModel =
        options.roleModels.judge?.model ||
        options.roleModels.worker?.model ||
        DEFAULT_MODELS.cursor;
      const judgeThinkingLevel = options.roleModels.judge?.thinkingLevel;
      const judgeReasoningEffort = options.roleModels.judge?.reasoningEffort;
      const judgeProvider = ProviderFactory.getProviderForModel(judgeModel);
      const judgeBareModel = stripProviderPrefix(judgeModel);
      const judgeSystemPrompt = this.combineSystemPrompts(
        options.systemPrompt,
        options.rolePrompts.judge
      );

      const taskSummary = options.feature.planSpec?.tasks?.length
        ? options.feature.planSpec.tasks
            .map((task) => `- ${task.id}: ${task.description}`)
            .slice(0, 20)
            .join('\n')
        : 'No structured task list available.';

      const qualitySummary = options.qualityMetrics?.checks?.length
        ? options.qualityMetrics.checks
            .map((check) => `- ${check.name}: ${check.status}`)
            .join('\n')
        : 'No quality checks recorded.';

      const outputExcerpt =
        options.agentOutput.length > 6000 ? options.agentOutput.slice(-6000) : options.agentOutput;

      const judgePrompt = `You are the judge agent. Evaluate whether the feature implementation is complete and aligned with the plan.

Return ONLY JSON (no markdown, no prose):
{"verdict":"pass|revise|fail","issues":["..."],"recommendations":["..."],"confidence":0.0}

Feature:
Title: ${options.feature.title || options.feature.id}
Description: ${options.feature.description}

Plan Tasks:
${taskSummary}

Quality Checks:
${qualitySummary}

Implementation Output (excerpt):
${outputExcerpt}

Guidance:
- "pass" if the feature is complete and quality checks are acceptable.
- "revise" if there are fixable gaps or missing tasks.
- "fail" if the implementation is fundamentally misaligned.
`;

      const executeOptions: ExecuteOptions = {
        prompt: judgePrompt,
        model: judgeBareModel,
        maxTurns: 1,
        cwd: options.workDir,
        allowedTools: [],
        readOnly: true,
        systemPrompt: judgeSystemPrompt,
        thinkingLevel: judgeThinkingLevel,
        reasoningEffort: judgeReasoningEffort,
      };

      const stream = judgeProvider.executeQuery(executeOptions);
      let responseText = '';

      for await (const msg of stream) {
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              responseText += block.text;
            }
          }
        } else if (msg.type === 'result' && msg.subtype === 'success') {
          responseText = msg.result || responseText;
        }
      }

      const extractJson = (text: string): string | null => {
        const codeBlockMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (codeBlockMatch) {
          return codeBlockMatch[1];
        }
        const start = text.indexOf('{');
        if (start === -1) return null;
        let depth = 0;
        for (let i = start; i < text.length; i++) {
          if (text[i] === '{') depth += 1;
          if (text[i] === '}') depth -= 1;
          if (depth === 0) {
            return text.slice(start, i + 1);
          }
        }
        return null;
      };

      const jsonText = extractJson(responseText);
      if (!jsonText) {
        return {
          verdict: 'revise',
          issues: ['Judge response could not be parsed.'],
          recommendations: [],
        };
      }

      const parsed = JSON.parse(jsonText) as {
        verdict?: string;
        issues?: unknown;
        recommendations?: unknown;
        confidence?: number;
      };
      const verdictRaw =
        typeof parsed.verdict === 'string' ? parsed.verdict.toLowerCase() : 'revise';
      const verdict: JudgeResult['verdict'] =
        verdictRaw === 'pass' || verdictRaw === 'fail' || verdictRaw === 'revise'
          ? (verdictRaw as JudgeResult['verdict'])
          : 'revise';
      const issues = Array.isArray(parsed.issues)
        ? parsed.issues.filter((issue): issue is string => typeof issue === 'string')
        : [];
      const recommendations = Array.isArray(parsed.recommendations)
        ? parsed.recommendations.filter((rec): rec is string => typeof rec === 'string')
        : [];
      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : undefined;

      this.emitAutoModeEvent('auto_mode_judge_result', {
        featureId: options.feature.id,
        projectPath: options.projectPath,
        verdict,
        issueCount: issues.length,
      });

      return { verdict, issues, recommendations, confidence };
    } catch (error) {
      logger.warn('Judge evaluation failed:', error);
      return {
        verdict: 'revise',
        issues: ['Judge evaluation failed.'],
        recommendations: [],
      };
    }
  }

  private buildQualityFixPrompt(feature: Feature, qualityMetrics: FeatureQualityMetrics): string {
    const failingChecks = qualityMetrics.checks.filter((check) => check.status === 'fail');
    const truncate = (value?: string): string =>
      value && value.length > 2000 ? value.slice(-2000) : value || '';

    const failures = failingChecks.length
      ? failingChecks
          .map((check) => {
            const output = truncate(check.output);
            return `- ${check.name}\n${output ? `  Output:\n${output}` : ''}`;
          })
          .join('\n')
      : 'No failing checks reported.';

    return `## Quality Gate Fix Required

${this.buildFeaturePrompt(feature)}

### Failing Checks
${failures}

## Task
Fix the issues causing the quality checks to fail. Re-run the failing checks if needed and ensure all checks pass.`;
  }

  private buildJudgeFixPrompt(feature: Feature, judgeResult: JudgeResult): string {
    const issues =
      judgeResult.issues.length > 0
        ? judgeResult.issues.map((issue) => `- ${issue}`).join('\n')
        : 'No issues provided.';
    const recommendations =
      judgeResult.recommendations.length > 0
        ? judgeResult.recommendations.map((rec) => `- ${rec}`).join('\n')
        : 'No recommendations provided.';

    return `## Judge Revision Required

${this.buildFeaturePrompt(feature)}

### Issues
${issues}

### Recommendations
${recommendations}

## Task
Address the judge feedback above. Update the implementation so it fully satisfies the feature requirements.`;
  }

  private async calculateTokenEfficiency(
    agentOutput: string,
    workDir: string
  ): Promise<number | undefined> {
    if (!agentOutput.trim()) {
      return undefined;
    }

    try {
      const { stdout } = await execAsync('git diff --numstat', { cwd: workDir });
      const lines = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      let changedLines = 0;
      for (const line of lines) {
        const [added, deleted] = line.split('\t');
        const addedCount = added === '-' ? 0 : parseInt(added, 10);
        const deletedCount = deleted === '-' ? 0 : parseInt(deleted, 10);
        if (!Number.isNaN(addedCount)) {
          changedLines += addedCount;
        }
        if (!Number.isNaN(deletedCount)) {
          changedLines += deletedCount;
        }
      }

      if (changedLines === 0) {
        return undefined;
      }

      const estimatedTokens = Math.ceil(agentOutput.length / 4);
      return Number((estimatedTokens / changedLines).toFixed(2));
    } catch {
      return undefined;
    }
  }

  /**
   * Commit feature changes
   * @param projectPath - The main project path
   * @param featureId - The feature ID to commit
   * @param providedWorktreePath - Optional: the worktree path where the feature's changes are located
   */
  async commitFeature(
    projectPath: string,
    featureId: string,
    providedWorktreePath?: string
  ): Promise<string | null> {
    let workDir = projectPath;

    // Use the provided worktree path if given
    if (providedWorktreePath) {
      try {
        await secureFs.access(providedWorktreePath);
        workDir = providedWorktreePath;
        logger.info(`Committing in provided worktree: ${workDir}`);
      } catch {
        logger.info(
          `Provided worktree path doesn't exist: ${providedWorktreePath}, using project path`
        );
      }
    } else {
      // Fallback: try to find worktree at legacy location
      const legacyWorktreePath = path.join(projectPath, '.worktrees', featureId);
      try {
        await secureFs.access(legacyWorktreePath);
        workDir = legacyWorktreePath;
        logger.info(`Committing in legacy worktree: ${workDir}`);
      } catch {
        logger.info(`No worktree found, committing in project path: ${workDir}`);
      }
    }

    try {
      // Check for changes
      const { stdout: status } = await execAsync('git status --porcelain', {
        cwd: workDir,
      });
      if (!status.trim()) {
        return null; // No changes
      }

      // Load feature for commit message
      const feature = await this.loadFeature(projectPath, featureId);
      const commitMessage = feature
        ? `feat: ${this.extractTitleFromDescription(
            feature.description
          )}\n\nImplemented by Automaker auto-mode`
        : `feat: Feature ${featureId}`;

      // Stage and commit
      await execAsync('git add -A', { cwd: workDir });
      await execAsync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, {
        cwd: workDir,
      });

      // Get commit hash
      const { stdout: hash } = await execAsync('git rev-parse HEAD', {
        cwd: workDir,
      });

      this.emitAutoModeEvent('auto_mode_feature_complete', {
        featureId,
        passes: true,
        message: `Changes committed: ${hash.trim().substring(0, 8)}`,
      });

      return hash.trim();
    } catch (error) {
      logger.error(`Commit failed for ${featureId}:`, error);
      return null;
    }
  }

  /**
   * Check if context exists for a feature
   */
  async contextExists(projectPath: string, featureId: string): Promise<boolean> {
    // Context is stored in .automaker directory
    const featureDir = getFeatureDir(projectPath, featureId);
    const contextPath = path.join(featureDir, 'agent-output.md');

    try {
      await secureFs.access(contextPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Analyze project to gather context
   */
  async analyzeProject(projectPath: string): Promise<void> {
    const abortController = new AbortController();

    const analysisFeatureId = `analysis-${Date.now()}`;
    this.emitAutoModeEvent('auto_mode_feature_start', {
      featureId: analysisFeatureId,
      projectPath,
      feature: {
        id: analysisFeatureId,
        title: 'Project Analysis',
        description: 'Analyzing project structure',
      },
    });

    const prompt = `Analyze this project and provide a summary of:
1. Project structure and architecture
2. Main technologies and frameworks used
3. Key components and their responsibilities
4. Build and test commands
5. Any existing conventions or patterns

Format your response as a structured markdown document.`;

    try {
      // Get model from phase settings
      const settings = await this.settingsService?.getGlobalSettings();
      const phaseModelEntry =
        settings?.phaseModels?.projectAnalysisModel || DEFAULT_PHASE_MODELS.projectAnalysisModel;
      const { model: analysisModel, thinkingLevel: analysisThinkingLevel } =
        resolvePhaseModel(phaseModelEntry);
      logger.info('Using model for project analysis:', analysisModel);

      const provider = ProviderFactory.getProviderForModel(analysisModel);

      // Load autoLoadClaudeMd setting
      const autoLoadClaudeMd = await getAutoLoadClaudeMdSetting(
        projectPath,
        this.settingsService,
        '[AutoMode]'
      );

      // Use createCustomOptions for centralized SDK configuration with CLAUDE.md support
      const sdkOptions = createCustomOptions({
        cwd: projectPath,
        model: analysisModel,
        maxTurns: 5,
        allowedTools: ['Read', 'Glob', 'Grep'],
        abortController,
        autoLoadClaudeMd,
        thinkingLevel: analysisThinkingLevel,
      });

      const options: ExecuteOptions = {
        prompt,
        model: sdkOptions.model ?? analysisModel,
        cwd: sdkOptions.cwd ?? projectPath,
        maxTurns: sdkOptions.maxTurns,
        allowedTools: sdkOptions.allowedTools as string[],
        abortController,
        settingSources: sdkOptions.settingSources,
        thinkingLevel: analysisThinkingLevel, // Pass thinking level
      };

      const stream = provider.executeQuery(options);
      let analysisResult = '';

      for await (const msg of stream) {
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text') {
              analysisResult = block.text || '';
              this.emitAutoModeEvent('auto_mode_progress', {
                featureId: analysisFeatureId,
                content: block.text,
                projectPath,
              });
            }
          }
        } else if (msg.type === 'result' && msg.subtype === 'success') {
          analysisResult = msg.result || analysisResult;
        }
      }

      // Save analysis to .automaker directory
      const automakerDir = getAutomakerDir(projectPath);
      const analysisPath = path.join(automakerDir, 'project-analysis.md');
      await secureFs.mkdir(automakerDir, { recursive: true });
      await secureFs.writeFile(analysisPath, analysisResult);

      this.emitAutoModeEvent('auto_mode_feature_complete', {
        featureId: analysisFeatureId,
        passes: true,
        message: 'Project analysis completed',
        projectPath,
      });
    } catch (error) {
      const errorInfo = classifyError(error);
      this.emitAutoModeEvent('auto_mode_error', {
        featureId: analysisFeatureId,
        error: errorInfo.message,
        errorType: errorInfo.type,
        projectPath,
      });
    }
  }

  /**
   * Get current status
   */
  getStatus(): {
    isRunning: boolean;
    runningFeatures: string[];
    runningCount: number;
  } {
    return {
      isRunning: this.runningFeatures.size > 0,
      runningFeatures: Array.from(this.runningFeatures.keys()),
      runningCount: this.runningFeatures.size,
    };
  }

  /**
   * Get detailed info about all running agents
   */
  async getRunningAgents(): Promise<
    Array<{
      featureId: string;
      projectPath: string;
      projectName: string;
      isAutoMode: boolean;
      model?: string;
      provider?: ModelProvider;
      title?: string;
      description?: string;
    }>
  > {
    const agents = await Promise.all(
      Array.from(this.runningFeatures.values()).map(async (rf) => {
        // Try to fetch feature data to get title and description
        let title: string | undefined;
        let description: string | undefined;

        try {
          const feature = await this.featureLoader.get(rf.projectPath, rf.featureId);
          if (feature) {
            title = feature.title;
            description = feature.description;
          }
        } catch (error) {
          // Silently ignore errors - title/description are optional
        }

        return {
          featureId: rf.featureId,
          projectPath: rf.projectPath,
          projectName: path.basename(rf.projectPath),
          isAutoMode: rf.isAutoMode,
          model: rf.model,
          provider: rf.provider,
          title,
          description,
        };
      })
    );
    return agents;
  }

  /**
   * Wait for plan approval from the user.
   * Returns a promise that resolves when the user approves/rejects the plan.
   * Times out after 30 minutes to prevent indefinite memory retention.
   */
  waitForPlanApproval(
    featureId: string,
    projectPath: string
  ): Promise<{ approved: boolean; editedPlan?: string; feedback?: string }> {
    const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

    logger.info(`Registering pending approval for feature ${featureId}`);
    logger.info(
      `Current pending approvals: ${Array.from(this.pendingApprovals.keys()).join(', ') || 'none'}`
    );
    return new Promise((resolve, reject) => {
      // Set up timeout to prevent indefinite waiting and memory leaks
      const timeoutId = setTimeout(() => {
        const pending = this.pendingApprovals.get(featureId);
        if (pending) {
          logger.warn(`Plan approval for feature ${featureId} timed out after 30 minutes`);
          this.pendingApprovals.delete(featureId);
          reject(
            new Error('Plan approval timed out after 30 minutes - feature execution cancelled')
          );
        }
      }, APPROVAL_TIMEOUT_MS);

      // Wrap resolve/reject to clear timeout when approval is resolved
      const wrappedResolve = (result: {
        approved: boolean;
        editedPlan?: string;
        feedback?: string;
      }) => {
        clearTimeout(timeoutId);
        resolve(result);
      };

      const wrappedReject = (error: Error) => {
        clearTimeout(timeoutId);
        reject(error);
      };

      this.pendingApprovals.set(featureId, {
        resolve: wrappedResolve,
        reject: wrappedReject,
        featureId,
        projectPath,
      });
      logger.info(`Pending approval registered for feature ${featureId} (timeout: 30 minutes)`);
    });
  }

  /**
   * Resolve a pending plan approval.
   * Called when the user approves or rejects the plan via API.
   */
  async resolvePlanApproval(
    featureId: string,
    approved: boolean,
    editedPlan?: string,
    feedback?: string,
    projectPathFromClient?: string
  ): Promise<{ success: boolean; error?: string }> {
    logger.info(`resolvePlanApproval called for feature ${featureId}, approved=${approved}`);
    logger.info(
      `Current pending approvals: ${Array.from(this.pendingApprovals.keys()).join(', ') || 'none'}`
    );
    const pending = this.pendingApprovals.get(featureId);

    if (!pending) {
      logger.info(`No pending approval in Map for feature ${featureId}`);

      // RECOVERY: If no pending approval but we have projectPath from client,
      // check if feature's planSpec.status is 'generated' and handle recovery
      if (projectPathFromClient) {
        logger.info(`Attempting recovery with projectPath: ${projectPathFromClient}`);
        const feature = await this.loadFeature(projectPathFromClient, featureId);

        if (feature?.planSpec?.status === 'generated') {
          logger.info(`Feature ${featureId} has planSpec.status='generated', performing recovery`);

          if (approved) {
            // Update planSpec to approved
            await this.updateFeaturePlanSpec(projectPathFromClient, featureId, {
              status: 'approved',
              approvedAt: new Date().toISOString(),
              reviewedByUser: true,
              content: editedPlan || feature.planSpec.content,
            });

            // Build continuation prompt and re-run the feature
            const planContent = editedPlan || feature.planSpec.content || '';
            let continuationPrompt = `The plan/specification has been approved. `;
            if (feedback) {
              continuationPrompt += `\n\nUser feedback: ${feedback}\n\n`;
            }
            continuationPrompt += `Now proceed with the implementation as specified in the plan:\n\n${planContent}\n\nImplement the feature now.`;

            logger.info(`Starting recovery execution for feature ${featureId}`);

            // Start feature execution with the continuation prompt (async, don't await)
            // Pass undefined for providedWorktreePath, use options for continuation prompt
            this.executeFeature(projectPathFromClient, featureId, true, false, undefined, {
              continuationPrompt,
            }).catch((error) => {
              logger.error(`Recovery execution failed for feature ${featureId}:`, error);
            });

            return { success: true };
          } else {
            // Rejected - update status and emit event
            await this.updateFeaturePlanSpec(projectPathFromClient, featureId, {
              status: 'rejected',
              reviewedByUser: true,
            });

            await this.updateFeatureStatus(projectPathFromClient, featureId, 'backlog');

            this.emitAutoModeEvent('plan_rejected', {
              featureId,
              projectPath: projectPathFromClient,
              feedback,
            });

            return { success: true };
          }
        }
      }

      logger.info(
        `ERROR: No pending approval found for feature ${featureId} and recovery not possible`
      );
      return {
        success: false,
        error: `No pending approval for feature ${featureId}`,
      };
    }
    logger.info(`Found pending approval for feature ${featureId}, proceeding...`);

    const { projectPath } = pending;

    // Update feature's planSpec status
    await this.updateFeaturePlanSpec(projectPath, featureId, {
      status: approved ? 'approved' : 'rejected',
      approvedAt: approved ? new Date().toISOString() : undefined,
      reviewedByUser: true,
      content: editedPlan, // Update content if user provided an edited version
    });

    // If rejected with feedback, we can store it for the user to see
    if (!approved && feedback) {
      // Emit event so client knows the rejection reason
      this.emitAutoModeEvent('plan_rejected', {
        featureId,
        projectPath,
        feedback,
      });
    }

    // Resolve the promise with all data including feedback
    pending.resolve({ approved, editedPlan, feedback });
    this.pendingApprovals.delete(featureId);

    return { success: true };
  }

  /**
   * Cancel a pending plan approval (e.g., when feature is stopped).
   */
  cancelPlanApproval(featureId: string): void {
    logger.info(`cancelPlanApproval called for feature ${featureId}`);
    logger.info(
      `Current pending approvals: ${Array.from(this.pendingApprovals.keys()).join(', ') || 'none'}`
    );
    const pending = this.pendingApprovals.get(featureId);
    if (pending) {
      logger.info(`Found and cancelling pending approval for feature ${featureId}`);
      pending.reject(new Error('Plan approval cancelled - feature was stopped'));
      this.pendingApprovals.delete(featureId);
    } else {
      logger.info(`No pending approval to cancel for feature ${featureId}`);
    }
  }

  /**
   * Check if a feature has a pending plan approval.
   */
  hasPendingApproval(featureId: string): boolean {
    return this.pendingApprovals.has(featureId);
  }

  // Private helpers

  /**
   * Find an existing worktree for a given branch by checking git worktree list
   */
  private async findExistingWorktreeForBranch(
    projectPath: string,
    branchName: string
  ): Promise<string | null> {
    try {
      const { stdout } = await execAsync('git worktree list --porcelain', {
        cwd: projectPath,
      });

      const lines = stdout.split('\n');
      let currentPath: string | null = null;
      let currentBranch: string | null = null;

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          currentPath = line.slice(9);
        } else if (line.startsWith('branch ')) {
          currentBranch = line.slice(7).replace('refs/heads/', '');
        } else if (line === '' && currentPath && currentBranch) {
          // End of a worktree entry
          if (currentBranch === branchName) {
            // Resolve to absolute path - git may return relative paths
            // On Windows, this is critical for cwd to work correctly
            // On all platforms, absolute paths ensure consistent behavior
            const resolvedPath = path.isAbsolute(currentPath)
              ? path.resolve(currentPath)
              : path.resolve(projectPath, currentPath);
            return resolvedPath;
          }
          currentPath = null;
          currentBranch = null;
        }
      }

      // Check the last entry (if file doesn't end with newline)
      if (currentPath && currentBranch && currentBranch === branchName) {
        // Resolve to absolute path for cross-platform compatibility
        const resolvedPath = path.isAbsolute(currentPath)
          ? path.resolve(currentPath)
          : path.resolve(projectPath, currentPath);
        return resolvedPath;
      }

      return null;
    } catch {
      return null;
    }
  }

  private async loadFeature(projectPath: string, featureId: string): Promise<Feature | null> {
    // Features are stored in .automaker directory
    const featureDir = getFeatureDir(projectPath, featureId);
    const featurePath = path.join(featureDir, 'feature.json');

    try {
      const data = (await secureFs.readFile(featurePath, 'utf-8')) as string;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  private async updateFeatureStatus(
    projectPath: string,
    featureId: string,
    status: string
  ): Promise<void> {
    // Features are stored in .automaker directory
    const featureDir = getFeatureDir(projectPath, featureId);
    const featurePath = path.join(featureDir, 'feature.json');

    try {
      const data = (await secureFs.readFile(featurePath, 'utf-8')) as string;
      const feature = JSON.parse(data);
      feature.status = status;
      feature.updatedAt = new Date().toISOString();
      // Set justFinishedAt timestamp when moving to waiting_approval (agent just completed)
      // Badge will show for 2 minutes after this timestamp
      if (status === 'waiting_approval') {
        feature.justFinishedAt = new Date().toISOString();
      } else {
        // Clear the timestamp when moving to other statuses
        feature.justFinishedAt = undefined;
      }
      await secureFs.writeFile(featurePath, JSON.stringify(feature, null, 2));
    } catch {
      // Feature file may not exist
    }
  }

  /**
   * Update the planSpec of a feature
   */
  private async updateFeaturePlanSpec(
    projectPath: string,
    featureId: string,
    updates: Partial<PlanSpec>
  ): Promise<void> {
    const featurePath = path.join(projectPath, '.automaker', 'features', featureId, 'feature.json');

    try {
      const data = (await secureFs.readFile(featurePath, 'utf-8')) as string;
      const feature = JSON.parse(data);

      // Initialize planSpec if it doesn't exist
      if (!feature.planSpec) {
        feature.planSpec = {
          status: 'pending',
          version: 1,
          reviewedByUser: false,
        };
      }

      if (feature.planSpec.taskStateVersion === undefined) {
        feature.planSpec.taskStateVersion = 0;
      }

      // Apply updates
      Object.assign(feature.planSpec, updates);

      // If content is being updated and it's a new version, increment version
      if (updates.content && updates.content !== feature.planSpec.content) {
        feature.planSpec.version = (feature.planSpec.version || 0) + 1;
      }

      if (
        updates.tasks !== undefined ||
        updates.currentTaskId !== undefined ||
        updates.currentTaskIds !== undefined ||
        updates.tasksCompleted !== undefined ||
        updates.tasksTotal !== undefined
      ) {
        feature.planSpec.taskStateVersion = (feature.planSpec.taskStateVersion || 0) + 1;
      }

      feature.updatedAt = new Date().toISOString();
      await secureFs.writeFile(featurePath, JSON.stringify(feature, null, 2));
    } catch (error) {
      logger.error(`Failed to update planSpec for ${featureId}:`, error);
    }
  }

  private async updatePlanSpecWithRetry(
    projectPath: string,
    featureId: string,
    updater: (planSpec: PlanSpec) => PlanSpec,
    maxRetries = 5
  ): Promise<PlanSpec | null> {
    const featurePath = path.join(projectPath, '.automaker', 'features', featureId, 'feature.json');

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const data = (await secureFs.readFile(featurePath, 'utf-8')) as string;
        const feature = JSON.parse(data);

        if (!feature.planSpec) {
          feature.planSpec = {
            status: 'pending',
            version: 1,
            reviewedByUser: false,
            taskStateVersion: 0,
          };
        }

        const currentTaskVersion = feature.planSpec.taskStateVersion || 0;
        const nextPlanSpec = updater({ ...feature.planSpec });
        nextPlanSpec.taskStateVersion = currentTaskVersion + 1;
        feature.planSpec = nextPlanSpec;
        feature.updatedAt = new Date().toISOString();

        await secureFs.writeFile(featurePath, JSON.stringify(feature, null, 2));

        // Verify we didn't lose the write to a concurrent update
        const verifyData = (await secureFs.readFile(featurePath, 'utf-8')) as string;
        const verified = JSON.parse(verifyData);
        if (verified.planSpec?.taskStateVersion === currentTaskVersion + 1) {
          return nextPlanSpec;
        }
      } catch (error) {
        logger.error(`Failed to update planSpec for ${featureId} (attempt ${attempt + 1}):`, error);
      }
    }

    logger.error(`Failed to update planSpec for ${featureId} after ${maxRetries} attempts`);
    return null;
  }

  private async loadPendingFeatures(projectPath: string): Promise<Feature[]> {
    // Features are stored in .automaker directory
    const featuresDir = getFeaturesDir(projectPath);

    try {
      const entries = await secureFs.readdir(featuresDir, {
        withFileTypes: true,
      });
      const allFeatures: Feature[] = [];
      const pendingFeatures: Feature[] = [];

      // Load all features (for dependency checking)
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const featurePath = path.join(featuresDir, entry.name, 'feature.json');
          try {
            const data = (await secureFs.readFile(featurePath, 'utf-8')) as string;
            const feature = JSON.parse(data);
            allFeatures.push(feature);

            // Track pending features separately
            if (
              feature.status === 'pending' ||
              feature.status === 'ready' ||
              feature.status === 'backlog'
            ) {
              pendingFeatures.push(feature);
            }
          } catch {
            // Skip invalid features
          }
        }
      }

      // Apply dependency-aware ordering
      const { orderedFeatures } = resolveDependencies(pendingFeatures);

      // Get skipVerificationInAutoMode setting
      const settings = await this.settingsService?.getGlobalSettings();
      const skipVerification = settings?.skipVerificationInAutoMode ?? false;

      // Filter to only features with satisfied dependencies
      const readyFeatures = orderedFeatures.filter((feature: Feature) =>
        areDependenciesSatisfied(feature, allFeatures, { skipVerification })
      );

      return readyFeatures;
    } catch {
      return [];
    }
  }

  /**
   * Extract a title from feature description (first line or truncated)
   */
  private extractTitleFromDescription(description: string): string {
    if (!description || !description.trim()) {
      return 'Untitled Feature';
    }

    // Get first line, or first 60 characters if no newline
    const firstLine = description.split('\n')[0].trim();
    if (firstLine.length <= 60) {
      return firstLine;
    }

    // Truncate to 60 characters and add ellipsis
    return firstLine.substring(0, 57) + '...';
  }

  /**
   * Get the planning prompt prefix based on feature's planning mode
   */
  private async getPlanningPromptPrefix(feature: Feature): Promise<string> {
    const mode = feature.planningMode || 'skip';

    if (mode === 'skip') {
      return ''; // No planning phase
    }

    // Load prompts from settings (no caching - allows hot reload of custom prompts)
    const prompts = await getPromptCustomization(this.settingsService, '[AutoMode]');
    const planningPrompts: Record<string, string> = {
      lite: prompts.autoMode.planningLite,
      lite_with_approval: prompts.autoMode.planningLiteWithApproval,
      spec: prompts.autoMode.planningSpec,
      full: prompts.autoMode.planningFull,
    };

    // For lite mode, use the approval variant if requirePlanApproval is true
    let promptKey: string = mode;
    if (mode === 'lite' && feature.requirePlanApproval === true) {
      promptKey = 'lite_with_approval';
    }

    const planningPrompt = planningPrompts[promptKey];
    if (!planningPrompt) {
      return '';
    }

    return planningPrompt + '\n\n---\n\n## Feature Request\n\n';
  }

  private getPlanQualityIssues(planContent: string, planningMode: PlanningMode): string[] {
    const issues: string[] = [];
    const hasSection = (pattern: RegExp) => pattern.test(planContent);

    if (planningMode === 'lite') {
      if (!hasSection(/\bGoal\b/i)) {
        issues.push('Missing Goal section.');
      }
      if (!hasSection(/\bApproach\b/i)) {
        issues.push('Missing Approach section.');
      }
      if (!hasSection(/Files?\s+to\s+Touch/i)) {
        issues.push('Missing Files to Touch section.');
      }
      if (!hasSection(/\bTasks?\b/i)) {
        issues.push('Missing Tasks section.');
      }
      if (!hasSection(/\bRisks?\b/i)) {
        issues.push('Missing Risks section.');
      }
      return issues;
    }

    if (!hasSection(/Acceptance\s+Criteria/i)) {
      issues.push('Missing Acceptance Criteria section.');
    }
    if (!hasSection(/Verification|Test\s+Strategy/i)) {
      issues.push('Missing Verification/Test Strategy section.');
    }
    if (!hasSection(/Security|Privacy|Auth/i)) {
      issues.push('Missing Security/Privacy considerations.');
    }
    if (!hasSection(/Performance|Scalability|Latency/i)) {
      issues.push('Missing Performance/Scalability considerations.');
    }
    if (!hasSection(/UX|User\s+Experience|Loading|Empty\s+State|Error\s+State/i)) {
      issues.push('Missing UX states (loading/error/empty).');
    }
    if (!hasSection(/Schema|Contract|API|Validation/i)) {
      issues.push('Missing Data/Contract alignment section.');
    }

    const tasks = parseTasksFromSpec(planContent);
    if (tasks.length === 0) {
      issues.push('Missing tasks block.');
    } else if (tasks.length < 3) {
      issues.push('Too few tasks for the scope.');
    }

    return issues;
  }

  private async revisePlanForQuality(options: {
    featureId: string;
    projectPath: string;
    planningMode: PlanningMode;
    currentPlanContent: string;
    issues: string[];
    plannerProvider: BaseProvider;
    plannerBareModel: string;
    plannerSdkOptions: {
      maxTurns?: number;
      systemPrompt?: ExecuteOptions['systemPrompt'];
      settingSources?: ExecuteOptions['settingSources'];
    };
    plannerThinkingLevel?: ThinkingLevel;
    plannerReasoningEffort?: ReasoningEffort;
    workDir: string;
    abortController: AbortController;
    allowedTools?: string[] | undefined;
    mcpServers?: ExecuteOptions['mcpServers'];
  }): Promise<{ planContent: string; rawText: string } | null> {
    const issueList = options.issues.map((issue) => `- ${issue}`).join('\n');
    const formatHint =
      options.planningMode === 'lite'
        ? 'Use the lite planning outline format (Goal, Approach, Files to Touch, Tasks, Risks).'
        : 'Use the specification format with a ```tasks``` block and required sections.';

    const revisionPrompt = `The plan/specification failed quality gates.

Missing items:
${issueList}

Current plan/specification:
${options.currentPlanContent}

Revise the plan/specification to address ALL missing items while preserving scope.
${formatHint}

After generating the revised plan, output:
"[SPEC_GENERATED] Please review the revised specification above."
`;

    const revisionStream = options.plannerProvider.executeQuery({
      prompt: revisionPrompt,
      model: options.plannerBareModel,
      maxTurns: options.plannerSdkOptions.maxTurns || 120,
      cwd: options.workDir,
      allowedTools: options.allowedTools,
      abortController: options.abortController,
      systemPrompt: options.plannerSdkOptions.systemPrompt,
      settingSources: options.plannerSdkOptions.settingSources,
      thinkingLevel: options.plannerThinkingLevel,
      reasoningEffort: options.plannerReasoningEffort,
      mcpServers: options.mcpServers,
    });

    let revisionText = '';
    for await (const msg of revisionStream) {
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            revisionText += block.text || '';
            this.emitAutoModeEvent('auto_mode_progress', {
              featureId: options.featureId,
              content: block.text,
            });
          }
        }
      } else if (msg.type === 'error') {
        throw new Error(msg.error || 'Error during plan quality revision');
      } else if (msg.type === 'result' && msg.subtype === 'success') {
        revisionText += msg.result || '';
      }
    }

    const markerIndex = revisionText.indexOf('[SPEC_GENERATED]');
    const revisedContent =
      markerIndex > 0 ? revisionText.substring(0, markerIndex).trim() : revisionText.trim();

    if (!revisedContent) {
      return null;
    }

    return { planContent: revisedContent, rawText: revisionText };
  }

  private combineSystemPrompts(basePrompt?: string, rolePrompt?: string): string | undefined {
    const parts = [basePrompt?.trim(), rolePrompt?.trim()].filter((part): part is string =>
      Boolean(part && part.length > 0)
    );
    if (parts.length === 0) {
      return undefined;
    }
    return parts.join('\n\n---\n\n');
  }

  private async resolveRoleModels(feature: Feature): Promise<Record<string, RoleModelConfig>> {
    const settings = await this.settingsService?.getGlobalSettings();

    const plannerEntry = settings?.phaseModels?.plannerModel || DEFAULT_PHASE_MODELS.plannerModel;
    const workerEntry = settings?.phaseModels?.workerModel || DEFAULT_PHASE_MODELS.workerModel;
    const judgeEntry = settings?.phaseModels?.judgeModel || DEFAULT_PHASE_MODELS.judgeModel;
    const refactorEntry =
      settings?.phaseModels?.refactorModel || DEFAULT_PHASE_MODELS.refactorModel;

    const resolvedPlanner = resolvePhaseModel(plannerEntry);
    const resolvedWorker = resolvePhaseModel(workerEntry);
    const resolvedJudge = resolvePhaseModel(judgeEntry);
    const resolvedRefactor = resolvePhaseModel(refactorEntry);

    const workerModel: RoleModelConfig = {
      model: resolvedWorker.model,
      thinkingLevel: resolvedWorker.thinkingLevel,
      reasoningEffort: resolvedWorker.reasoningEffort,
    };

    if (feature.model) {
      workerModel.model = resolveModelString(feature.model, workerModel.model);
    }
    if (feature.thinkingLevel) {
      workerModel.thinkingLevel = feature.thinkingLevel;
    }
    if (feature.reasoningEffort) {
      workerModel.reasoningEffort = feature.reasoningEffort;
    }

    return {
      planner: {
        model: resolvedPlanner.model,
        thinkingLevel: resolvedPlanner.thinkingLevel,
        reasoningEffort: resolvedPlanner.reasoningEffort,
      },
      worker: workerModel,
      judge: {
        model: resolvedJudge.model,
        thinkingLevel: resolvedJudge.thinkingLevel,
        reasoningEffort: resolvedJudge.reasoningEffort,
      },
      refactor: {
        model: resolvedRefactor.model,
        thinkingLevel: resolvedRefactor.thinkingLevel,
        reasoningEffort: resolvedRefactor.reasoningEffort,
      },
    };
  }

  private buildFeaturePrompt(feature: Feature): string {
    const title = this.extractTitleFromDescription(feature.description);

    let prompt = `## Feature Implementation Task

**Feature ID:** ${feature.id}
**Title:** ${title}
**Description:** ${feature.description}
`;

    if (feature.spec) {
      prompt += `
**Specification:**
${feature.spec}
`;
    }

    // Add images note (like old implementation)
    if (feature.imagePaths && feature.imagePaths.length > 0) {
      const imagesList = feature.imagePaths
        .map((img, idx) => {
          const path = typeof img === 'string' ? img : img.path;
          const filename =
            typeof img === 'string' ? path.split('/').pop() : img.filename || path.split('/').pop();
          const mimeType = typeof img === 'string' ? 'image/*' : img.mimeType || 'image/*';
          return `   ${idx + 1}. ${filename} (${mimeType})\n      Path: ${path}`;
        })
        .join('\n');

      prompt += `
**📎 Context Images Attached:**
The user has attached ${feature.imagePaths.length} image(s) for context. These images are provided both visually (in the initial message) and as files you can read:

${imagesList}

You can use the Read tool to view these images at any time during implementation. Review them carefully before implementing.
`;
    }

    // Add verification instructions based on testing mode
    if (feature.skipTests) {
      // Manual verification - just implement the feature
      prompt += `
## Instructions

Implement this feature by:
1. First, explore the codebase to understand the existing structure
2. Plan your implementation approach
3. Write the necessary code changes
4. Ensure the code follows existing patterns and conventions

When done, wrap your final summary in <summary> tags like this:

<summary>
## Summary: [Feature Title]

### Changes Implemented
- [List of changes made]

### Files Modified
- [List of files]

### Notes for Developer
- [Any important notes]
</summary>

This helps parse your summary correctly in the output logs.`;
    } else {
      // Automated testing - implement and verify with Playwright
      prompt += `
## Instructions

Implement this feature by:
1. First, explore the codebase to understand the existing structure
2. Plan your implementation approach
3. Write the necessary code changes
4. Ensure the code follows existing patterns and conventions

## Verification with Playwright (REQUIRED)

After implementing the feature, you MUST verify it works correctly using Playwright:

1. **Create a temporary Playwright test** to verify the feature works as expected
2. **Run the test** to confirm the feature is working
3. **Delete the test file** after verification - this is a temporary verification test, not a permanent test suite addition

Example verification workflow:
\`\`\`bash
# Create a simple verification test
npx playwright test my-verification-test.spec.ts

# After successful verification, delete the test
rm my-verification-test.spec.ts
\`\`\`

The test should verify the core functionality of the feature. If the test fails, fix the implementation and re-test.

When done, wrap your final summary in <summary> tags like this:

<summary>
## Summary: [Feature Title]

### Changes Implemented
- [List of changes made]

### Files Modified
- [List of files]

### Verification Status
- [Describe how the feature was verified with Playwright]

### Notes for Developer
- [Any important notes]
</summary>

This helps parse your summary correctly in the output logs.`;
    }

    return prompt;
  }

  private async runAgent(
    workDir: string,
    featureId: string,
    prompt: string,
    abortController: AbortController,
    projectPath: string,
    imagePaths?: string[],
    model?: string,
    options?: {
      projectPath?: string;
      planningMode?: PlanningMode;
      requirePlanApproval?: boolean;
      previousContent?: string;
      systemPrompt?: string;
      autoLoadClaudeMd?: boolean;
      thinkingLevel?: ThinkingLevel;
      reasoningEffort?: ReasoningEffort;
      roleModels?: Record<string, RoleModelConfig>;
      rolePrompts?: RolePromptConfig;
    }
  ): Promise<void> {
    const finalProjectPath = options?.projectPath || projectPath;
    const planningMode = options?.planningMode || 'skip';
    const previousContent = options?.previousContent;
    const roleModels = options?.roleModels || {};
    const rolePrompts = options?.rolePrompts || {};

    const workerRole = roleModels.worker;
    const workerModel = workerRole?.model || model || DEFAULT_MODELS.cursor;
    const workerThinkingLevel = workerRole?.thinkingLevel ?? options?.thinkingLevel;
    const workerReasoningEffort = workerRole?.reasoningEffort ?? options?.reasoningEffort;

    const plannerRole = roleModels.planner;
    const plannerModel = plannerRole?.model || workerModel;
    const plannerThinkingLevel = plannerRole?.thinkingLevel;
    const plannerReasoningEffort = plannerRole?.reasoningEffort;

    // Validate vision support before processing images
    const initialVisionModel = planningMode === 'skip' ? workerModel : plannerModel;
    if (imagePaths && imagePaths.length > 0) {
      const supportsVision = ProviderFactory.modelSupportsVision(initialVisionModel);
      if (!supportsVision) {
        throw new Error(
          `This model (${initialVisionModel}) does not support image input. ` +
            `Please switch to a model that supports vision (like Claude models), or remove the images and try again.`
        );
      }
    }

    // Check if this planning mode can generate a spec/plan that needs approval
    // - spec and full always generate specs
    // - lite only generates approval-ready content when requirePlanApproval is true
    const planningModeRequiresApproval =
      planningMode === 'spec' ||
      planningMode === 'full' ||
      (planningMode === 'lite' && options?.requirePlanApproval === true);
    const requiresApproval = planningModeRequiresApproval && options?.requirePlanApproval === true;

    // CI/CD Mock Mode: Return early with mock response when AUTOMAKER_MOCK_AGENT is set
    // This prevents actual API calls during automated testing
    if (process.env.AUTOMAKER_MOCK_AGENT === 'true') {
      logger.info(`MOCK MODE: Skipping real agent execution for feature ${featureId}`);

      // Simulate some work being done
      await this.sleep(500);

      // Emit mock progress events to simulate agent activity
      this.emitAutoModeEvent('auto_mode_progress', {
        featureId,
        content: 'Mock agent: Analyzing the codebase...',
      });

      await this.sleep(300);

      this.emitAutoModeEvent('auto_mode_progress', {
        featureId,
        content: 'Mock agent: Implementing the feature...',
      });

      await this.sleep(300);

      // Create a mock file with "yellow" content as requested in the test
      const mockFilePath = path.join(workDir, 'yellow.txt');
      await secureFs.writeFile(mockFilePath, 'yellow');

      this.emitAutoModeEvent('auto_mode_progress', {
        featureId,
        content: "Mock agent: Created yellow.txt file with content 'yellow'",
      });

      await this.sleep(200);

      // Save mock agent output
      const featureDirForOutput = getFeatureDir(projectPath, featureId);
      const outputPath = path.join(featureDirForOutput, 'agent-output.md');

      const mockOutput = `# Mock Agent Output

## Summary
This is a mock agent response for CI/CD testing.

## Changes Made
- Created \`yellow.txt\` with content "yellow"

## Notes
This mock response was generated because AUTOMAKER_MOCK_AGENT=true was set.
`;

      await secureFs.mkdir(path.dirname(outputPath), { recursive: true });
      await secureFs.writeFile(outputPath, mockOutput);

      logger.info(`MOCK MODE: Completed mock execution for feature ${featureId}`);
      return;
    }

    // Load autoLoadClaudeMd setting (project setting takes precedence over global)
    // Use provided value if available, otherwise load from settings
    const autoLoadClaudeMd =
      options?.autoLoadClaudeMd !== undefined
        ? options.autoLoadClaudeMd
        : await getAutoLoadClaudeMdSetting(finalProjectPath, this.settingsService, '[AutoMode]');

    // Load MCP servers from settings (global setting only)
    const mcpServers = await getMCPServersFromSettings(this.settingsService, '[AutoMode]');

    // Load MCP permission settings (global setting only)

    const workerSystemPrompt = this.combineSystemPrompts(options?.systemPrompt, rolePrompts.worker);
    const plannerSystemPrompt = this.combineSystemPrompts(
      options?.systemPrompt,
      rolePrompts.planner
    );

    // Build SDK options using centralized configuration for feature implementation
    const workerSdkOptions = createAutoModeOptions({
      cwd: workDir,
      model: workerModel,
      abortController,
      autoLoadClaudeMd,
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
      thinkingLevel: workerThinkingLevel,
      systemPrompt: workerSystemPrompt,
    });

    const plannerSdkOptions = createAutoModeOptions({
      cwd: workDir,
      model: plannerModel,
      abortController,
      autoLoadClaudeMd,
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
      thinkingLevel: plannerThinkingLevel,
      systemPrompt: plannerSystemPrompt,
    });

    // Extract model, maxTurns, and allowedTools from SDK options
    const workerFinalModel = workerSdkOptions.model!;
    const plannerFinalModel = plannerSdkOptions.model!;
    const allowedTools = workerSdkOptions.allowedTools as string[] | undefined;

    logger.info(
      `runAgent called for feature ${featureId} with planner model: ${plannerFinalModel}, worker model: ${workerFinalModel}, planningMode: ${planningMode}, requiresApproval: ${requiresApproval}`
    );

    // Build prompt content with images using utility
    const { content: promptContent } = await buildPromptWithImages(
      prompt,
      imagePaths,
      workDir,
      false // don't duplicate paths in text
    );

    // Debug: Log if system prompt is provided
    if (options?.systemPrompt) {
      logger.info(
        `System prompt provided (${options.systemPrompt.length} chars), first 200 chars:\n${options.systemPrompt.substring(0, 200)}...`
      );
    }

    const resolveProviderForModel = (resolvedModel: string) => ({
      provider: ProviderFactory.getProviderForModel(resolvedModel),
      bareModel: stripProviderPrefix(resolvedModel),
    });

    const { provider: plannerProvider, bareModel: plannerBareModel } =
      resolveProviderForModel(plannerFinalModel);
    const { provider: workerProvider, bareModel: workerBareModel } =
      resolveProviderForModel(workerFinalModel);

    const initialRole = planningMode === 'skip' ? 'worker' : 'planner';
    const initialModel = planningMode === 'skip' ? workerFinalModel : plannerFinalModel;
    const initialSdkOptions = planningMode === 'skip' ? workerSdkOptions : plannerSdkOptions;
    const initialThinkingLevel =
      planningMode === 'skip' ? workerThinkingLevel : plannerThinkingLevel;
    const initialReasoningEffort =
      planningMode === 'skip' ? workerReasoningEffort : plannerReasoningEffort;
    const initialProvider = planningMode === 'skip' ? workerProvider : plannerProvider;
    const initialBareModel = planningMode === 'skip' ? workerBareModel : plannerBareModel;

    logger.info(
      `Using provider "${initialProvider.getName()}" for ${initialRole} model "${initialModel}" (bare: ${initialBareModel})`
    );

    const executeOptions: ExecuteOptions = {
      prompt: promptContent,
      model: initialBareModel,
      maxTurns: initialSdkOptions.maxTurns,
      cwd: workDir,
      allowedTools: allowedTools,
      abortController,
      systemPrompt: initialSdkOptions.systemPrompt,
      settingSources: initialSdkOptions.settingSources,
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined, // Pass MCP servers configuration
      thinkingLevel: initialThinkingLevel,
      reasoningEffort: initialReasoningEffort,
    };

    // Execute via provider
    logger.info(`Starting stream for feature ${featureId}...`);
    const stream = initialProvider.executeQuery(executeOptions);
    logger.info(`Stream created, starting to iterate...`);
    // Initialize with previous content if this is a follow-up, with a separator
    let responseText = previousContent
      ? `${previousContent}\n\n---\n\n## Follow-up Session\n\n`
      : '';
    let specDetected = false;

    // Agent output goes to .automaker directory
    // Note: We use projectPath here, not workDir, because workDir might be a worktree path
    const featureDirForOutput = getFeatureDir(projectPath, featureId);
    const outputPath = path.join(featureDirForOutput, 'agent-output.md');
    const rawOutputPath = path.join(featureDirForOutput, 'raw-output.jsonl');

    // Raw output logging is configurable via environment variable
    // Set AUTOMAKER_DEBUG_RAW_OUTPUT=true to enable raw stream event logging
    const enableRawOutput =
      process.env.AUTOMAKER_DEBUG_RAW_OUTPUT === 'true' ||
      process.env.AUTOMAKER_DEBUG_RAW_OUTPUT === '1';

    // Incremental file writing state
    let writeTimeout: ReturnType<typeof setTimeout> | null = null;
    const WRITE_DEBOUNCE_MS = 500; // Batch writes every 500ms

    // Raw output accumulator for debugging (NDJSON format)
    let rawOutputLines: string[] = [];
    let rawWriteTimeout: ReturnType<typeof setTimeout> | null = null;

    // Helper to append raw stream event for debugging (only when enabled)
    const appendRawEvent = (event: unknown): void => {
      if (!enableRawOutput) return;

      try {
        const timestamp = new Date().toISOString();
        const rawLine = JSON.stringify({ timestamp, event }, null, 4); // Pretty print for readability
        rawOutputLines.push(rawLine);

        // Debounced write of raw output
        if (rawWriteTimeout) {
          clearTimeout(rawWriteTimeout);
        }
        rawWriteTimeout = setTimeout(async () => {
          try {
            await secureFs.mkdir(path.dirname(rawOutputPath), { recursive: true });
            await secureFs.appendFile(rawOutputPath, rawOutputLines.join('\n') + '\n');
            rawOutputLines = []; // Clear after writing
          } catch (error) {
            logger.error(`Failed to write raw output for ${featureId}:`, error);
          }
        }, WRITE_DEBOUNCE_MS);
      } catch {
        // Ignore serialization errors
      }
    };

    // Helper to write current responseText to file
    const writeToFile = async (): Promise<void> => {
      try {
        await secureFs.mkdir(path.dirname(outputPath), { recursive: true });
        await secureFs.writeFile(outputPath, responseText);
      } catch (error) {
        // Log but don't crash - file write errors shouldn't stop execution
        logger.error(`Failed to write agent output for ${featureId}:`, error);
      }
    };

    // Debounced write - schedules a write after WRITE_DEBOUNCE_MS
    const scheduleWrite = (): void => {
      if (writeTimeout) {
        clearTimeout(writeTimeout);
      }
      writeTimeout = setTimeout(() => {
        writeToFile();
      }, WRITE_DEBOUNCE_MS);
    };

    // Heartbeat logging so "silent" model calls are visible.
    // Some runs can take a while before the first streamed message arrives.
    const streamStartTime = Date.now();
    let receivedAnyStreamMessage = false;
    const STREAM_HEARTBEAT_MS = 15_000;
    const streamHeartbeat = setInterval(() => {
      if (receivedAnyStreamMessage) return;
      const elapsedSeconds = Math.round((Date.now() - streamStartTime) / 1000);
      logger.info(
        `Waiting for first model response for feature ${featureId} (${elapsedSeconds}s elapsed)...`
      );
    }, STREAM_HEARTBEAT_MS);

    // Wrap stream processing in try/finally to ensure timeout cleanup on any error/abort
    try {
      streamLoop: for await (const msg of stream) {
        receivedAnyStreamMessage = true;
        // Log raw stream event for debugging
        appendRawEvent(msg);

        logger.info(`Stream message received:`, msg.type, msg.subtype || '');
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text') {
              const newText = block.text || '';

              // Skip empty text
              if (!newText) continue;

              // Note: Cursor-specific dedup (duplicate blocks, accumulated text) is now
              // handled in CursorProvider.deduplicateTextBlocks() for cleaner separation

              // Only add separator when we're at a natural paragraph break:
              // - Previous text ends with sentence terminator AND new text starts a new thought
              // - Don't add separators mid-word or mid-sentence (for streaming providers like Cursor)
              if (responseText.length > 0 && newText.length > 0) {
                const lastChar = responseText.slice(-1);
                const endsWithSentence = /[.!?:]\s*$/.test(responseText);
                const endsWithNewline = /\n\s*$/.test(responseText);
                const startsNewParagraph = /^[\n#\-*>]/.test(newText);

                // Add paragraph break only at natural boundaries
                if (
                  !endsWithNewline &&
                  (endsWithSentence || startsNewParagraph) &&
                  !/[a-zA-Z0-9]/.test(lastChar) // Not mid-word
                ) {
                  responseText += '\n\n';
                }
              }
              responseText += newText;

              // Check for authentication errors in the response
              if (
                block.text &&
                (block.text.includes('Invalid API key') ||
                  block.text.includes('authentication_failed') ||
                  block.text.includes('Fix external API key'))
              ) {
                throw new Error(
                  'Authentication failed: Invalid or expired API key. ' +
                    "Please check your ANTHROPIC_API_KEY, or run 'claude login' to re-authenticate."
                );
              }

              // Schedule incremental file write (debounced)
              scheduleWrite();

              // Check for [SPEC_GENERATED] marker in planning modes (spec or full)
              if (
                planningModeRequiresApproval &&
                !specDetected &&
                responseText.includes('[SPEC_GENERATED]')
              ) {
                specDetected = true;

                // Extract plan content (everything before the marker)
                const markerIndex = responseText.indexOf('[SPEC_GENERATED]');
                let currentPlanContent = responseText.substring(0, markerIndex).trim();

                // Parse tasks from the generated spec (for spec and full modes)
                // Use let since we may need to update this after plan revision
                let parsedTasks = parseTasksFromSpec(currentPlanContent);
                let tasksTotal = parsedTasks.length;

                let qualityIssues = this.getPlanQualityIssues(currentPlanContent, planningMode);
                let qualityRevisionCount = 0;

                while (
                  qualityIssues.length > 0 &&
                  qualityRevisionCount < MAX_PLAN_QUALITY_REVISIONS
                ) {
                  this.emitAutoModeEvent('plan_quality_gate_failed', {
                    featureId,
                    projectPath,
                    issues: qualityIssues,
                    attempt: qualityRevisionCount + 1,
                  });

                  const revisionResult = await this.revisePlanForQuality({
                    featureId,
                    projectPath,
                    planningMode,
                    currentPlanContent,
                    issues: qualityIssues,
                    plannerProvider,
                    plannerBareModel,
                    plannerSdkOptions: {
                      maxTurns: plannerSdkOptions.maxTurns,
                      systemPrompt: plannerSdkOptions.systemPrompt,
                      settingSources: plannerSdkOptions.settingSources,
                    },
                    plannerThinkingLevel,
                    plannerReasoningEffort,
                    workDir,
                    abortController,
                    allowedTools,
                    mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
                  });

                  if (!revisionResult) {
                    break;
                  }

                  currentPlanContent = revisionResult.planContent;
                  responseText += revisionResult.rawText;
                  scheduleWrite();

                  parsedTasks = parseTasksFromSpec(currentPlanContent);
                  tasksTotal = parsedTasks.length;
                  qualityIssues = this.getPlanQualityIssues(currentPlanContent, planningMode);
                  qualityRevisionCount += 1;
                }

                const qualityGatePassed = qualityIssues.length === 0;

                logger.info(`Parsed ${tasksTotal} tasks from spec for feature ${featureId}`);
                if (parsedTasks.length > 0) {
                  logger.info(`Tasks: ${parsedTasks.map((t) => t.id).join(', ')}`);
                }

                // Update planSpec status to 'generated' and save content with parsed tasks
                await this.updateFeaturePlanSpec(projectPath, featureId, {
                  status: 'generated',
                  content: currentPlanContent,
                  version: 1 + qualityRevisionCount,
                  generatedAt: new Date().toISOString(),
                  reviewedByUser: false,
                  tasks: parsedTasks,
                  tasksTotal,
                  tasksCompleted: 0,
                  qualityIssues: qualityGatePassed ? [] : qualityIssues,
                });

                let approvedPlanContent = currentPlanContent;
                let userFeedback: string | undefined;
                let planVersion = 1 + qualityRevisionCount;

                // Only pause for approval if requirePlanApproval is true
                if (requiresApproval) {
                  // ========================================
                  // PLAN REVISION LOOP
                  // Keep regenerating plan until user approves
                  // ========================================
                  let planApproved = false;

                  while (!planApproved) {
                    logger.info(
                      `Spec v${planVersion} generated for feature ${featureId}, waiting for approval`
                    );

                    // CRITICAL: Register pending approval BEFORE emitting event
                    const approvalPromise = this.waitForPlanApproval(featureId, projectPath);

                    // Emit plan_approval_required event
                    this.emitAutoModeEvent('plan_approval_required', {
                      featureId,
                      projectPath,
                      planContent: currentPlanContent,
                      planningMode,
                      planVersion,
                    });

                    // Wait for user response
                    try {
                      const approvalResult = await approvalPromise;

                      if (approvalResult.approved) {
                        // User approved the plan
                        logger.info(`Plan v${planVersion} approved for feature ${featureId}`);
                        planApproved = true;

                        // If user provided edits, use the edited version
                        if (approvalResult.editedPlan) {
                          approvedPlanContent = approvalResult.editedPlan;
                          await this.updateFeaturePlanSpec(projectPath, featureId, {
                            content: approvalResult.editedPlan,
                          });
                        } else {
                          approvedPlanContent = currentPlanContent;
                        }

                        // Capture any additional feedback for implementation
                        userFeedback = approvalResult.feedback;

                        // Emit approval event
                        this.emitAutoModeEvent('plan_approved', {
                          featureId,
                          projectPath,
                          hasEdits: !!approvalResult.editedPlan,
                          planVersion,
                        });
                      } else {
                        // User rejected - check if they provided feedback for revision
                        const hasFeedback =
                          approvalResult.feedback && approvalResult.feedback.trim().length > 0;
                        const hasEdits =
                          approvalResult.editedPlan && approvalResult.editedPlan.trim().length > 0;

                        if (!hasFeedback && !hasEdits) {
                          // No feedback or edits = explicit cancel
                          logger.info(
                            `Plan rejected without feedback for feature ${featureId}, cancelling`
                          );
                          throw new Error('Plan cancelled by user');
                        }

                        // User wants revisions - regenerate the plan
                        logger.info(
                          `Plan v${planVersion} rejected with feedback for feature ${featureId}, regenerating...`
                        );
                        planVersion++;

                        // Emit revision event
                        this.emitAutoModeEvent('plan_revision_requested', {
                          featureId,
                          projectPath,
                          feedback: approvalResult.feedback,
                          hasEdits: !!hasEdits,
                          planVersion,
                        });

                        // Build revision prompt
                        let revisionPrompt = `The user has requested revisions to the plan/specification.

## Previous Plan (v${planVersion - 1})
${hasEdits ? approvalResult.editedPlan : currentPlanContent}

## User Feedback
${approvalResult.feedback || 'Please revise the plan based on the edits above.'}

## Instructions
Please regenerate the specification incorporating the user's feedback.
Keep the same format with the \`\`\`tasks block for task definitions.
After generating the revised spec, output:
"[SPEC_GENERATED] Please review the revised specification above."
`;

                        // Update status to regenerating
                        await this.updateFeaturePlanSpec(projectPath, featureId, {
                          status: 'generating',
                          version: planVersion,
                        });

                        // Make revision call
                        const revisionStream = plannerProvider.executeQuery({
                          prompt: revisionPrompt,
                          model: plannerBareModel,
                          maxTurns: plannerSdkOptions.maxTurns || 100,
                          cwd: workDir,
                          allowedTools: allowedTools,
                          abortController,
                          systemPrompt: plannerSdkOptions.systemPrompt,
                          settingSources: plannerSdkOptions.settingSources,
                          thinkingLevel: plannerThinkingLevel,
                          reasoningEffort: plannerReasoningEffort,
                          mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
                        });

                        let revisionText = '';
                        for await (const msg of revisionStream) {
                          if (msg.type === 'assistant' && msg.message?.content) {
                            for (const block of msg.message.content) {
                              if (block.type === 'text') {
                                revisionText += block.text || '';
                                this.emitAutoModeEvent('auto_mode_progress', {
                                  featureId,
                                  content: block.text,
                                });
                              }
                            }
                          } else if (msg.type === 'error') {
                            throw new Error(msg.error || 'Error during plan revision');
                          } else if (msg.type === 'result' && msg.subtype === 'success') {
                            revisionText += msg.result || '';
                          }
                        }

                        // Extract new plan content
                        const markerIndex = revisionText.indexOf('[SPEC_GENERATED]');
                        if (markerIndex > 0) {
                          currentPlanContent = revisionText.substring(0, markerIndex).trim();
                        } else {
                          currentPlanContent = revisionText.trim();
                        }

                        // Re-parse tasks from revised plan
                        const revisedTasks = parseTasksFromSpec(currentPlanContent);
                        logger.info(`Revised plan has ${revisedTasks.length} tasks`);

                        // Update planSpec with revised content
                        await this.updateFeaturePlanSpec(projectPath, featureId, {
                          status: 'generated',
                          content: currentPlanContent,
                          version: planVersion,
                          tasks: revisedTasks,
                          tasksTotal: revisedTasks.length,
                          tasksCompleted: 0,
                        });

                        // Update parsedTasks for implementation
                        parsedTasks = revisedTasks;

                        responseText += revisionText;
                      }
                    } catch (error) {
                      if ((error as Error).message.includes('cancelled')) {
                        throw error;
                      }
                      throw new Error(`Plan approval failed: ${(error as Error).message}`);
                    }
                  }
                } else {
                  // Auto-approve: requirePlanApproval is false, just continue without pausing
                  logger.info(
                    `Spec generated for feature ${featureId}, auto-approving (requirePlanApproval=false)`
                  );

                  // Emit info event for frontend
                  this.emitAutoModeEvent('plan_auto_approved', {
                    featureId,
                    projectPath,
                    planContent: currentPlanContent,
                    planningMode,
                  });

                  approvedPlanContent = currentPlanContent;
                }

                // CRITICAL: After approval, we need to make a second call to continue implementation
                // The agent is waiting for "approved" - we need to send it and continue
                logger.info(
                  `Making continuation call after plan approval for feature ${featureId}`
                );

                // Update planSpec status to approved (handles both manual and auto-approval paths)
                await this.updateFeaturePlanSpec(projectPath, featureId, {
                  status: 'approved',
                  approvedAt: new Date().toISOString(),
                  reviewedByUser: requiresApproval,
                });

                // ========================================
                // MULTI-AGENT TASK EXECUTION
                // Each task gets its own focused agent call
                // ========================================

                if (parsedTasks.length > 0) {
                  logger.info(
                    `Starting dependency-aware execution: ${parsedTasks.length} tasks for feature ${featureId}`
                  );

                  let refinementPass = 0;
                  while (this.shouldRefineTasks(parsedTasks, refinementPass)) {
                    this.emitAutoModeEvent('auto_mode_progress', {
                      featureId,
                      content: `Refining plan with sub-planner (pass ${refinementPass + 1})...`,
                    });

                    const refinedTasks = await this.refineTasksWithSubPlanner({
                      featureId,
                      projectPath,
                      tasks: parsedTasks,
                      planContent: approvedPlanContent,
                      plannerProvider,
                      plannerBareModel,
                      plannerSdkOptions: {
                        maxTurns: plannerSdkOptions.maxTurns,
                        systemPrompt: plannerSdkOptions.systemPrompt,
                        settingSources: plannerSdkOptions.settingSources,
                      },
                      plannerThinkingLevel,
                      plannerReasoningEffort,
                      workDir,
                      abortController,
                      allowedTools,
                      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
                    });

                    if (!refinedTasks || refinedTasks.length <= parsedTasks.length) {
                      break;
                    }

                    parsedTasks = refinedTasks;
                    refinementPass += 1;

                    await this.updateFeaturePlanSpec(projectPath, featureId, {
                      tasks: parsedTasks,
                      tasksTotal: parsedTasks.length,
                      tasksCompleted: 0,
                      currentTaskId: undefined,
                      currentTaskIds: [],
                    });
                  }

                  await this.executeTasksWithDependencies({
                    projectPath,
                    featureId,
                    workDir,
                    tasks: parsedTasks,
                    planContent: approvedPlanContent,
                    userFeedback,
                    workerProvider,
                    workerBareModel,
                    workerSdkOptions: {
                      maxTurns: workerSdkOptions.maxTurns,
                      systemPrompt: workerSdkOptions.systemPrompt,
                      settingSources: workerSdkOptions.settingSources,
                    },
                    workerThinkingLevel,
                    workerReasoningEffort,
                    allowedTools,
                    abortController,
                    mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
                    appendOutput: (text) => {
                      if (!text) return;
                      responseText += text;
                      scheduleWrite();
                    },
                  });

                  logger.info(`All ${parsedTasks.length} tasks completed for feature ${featureId}`);
                } else {
                  // No parsed tasks - fall back to single-agent execution
                  logger.info(
                    `No parsed tasks, using single-agent execution for feature ${featureId}`
                  );

                  const continuationPrompt = `The plan/specification has been approved. Now implement it.
${userFeedback ? `\n## User Feedback\n${userFeedback}\n` : ''}
## Approved Plan

${approvedPlanContent}

## Instructions

Implement all the changes described in the plan above.`;

                  const continuationStream = workerProvider.executeQuery({
                    prompt: continuationPrompt,
                    model: workerBareModel,
                    maxTurns: workerSdkOptions.maxTurns,
                    cwd: workDir,
                    allowedTools: allowedTools,
                    abortController,
                    systemPrompt: workerSdkOptions.systemPrompt,
                    settingSources: workerSdkOptions.settingSources,
                    thinkingLevel: workerThinkingLevel,
                    reasoningEffort: workerReasoningEffort,
                    mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
                  });

                  for await (const msg of continuationStream) {
                    if (msg.type === 'assistant' && msg.message?.content) {
                      for (const block of msg.message.content) {
                        if (block.type === 'text') {
                          responseText += block.text || '';
                          this.emitAutoModeEvent('auto_mode_progress', {
                            featureId,
                            content: block.text,
                          });
                        } else if (block.type === 'tool_use') {
                          this.emitAutoModeEvent('auto_mode_tool', {
                            featureId,
                            tool: block.name,
                            input: block.input,
                          });
                        }
                      }
                    } else if (msg.type === 'error') {
                      throw new Error(msg.error || 'Unknown error during implementation');
                    } else if (msg.type === 'result' && msg.subtype === 'success') {
                      responseText += msg.result || '';
                    }
                  }
                }

                logger.info(`Implementation completed for feature ${featureId}`);
                // Exit the original stream loop since continuation is done
                break streamLoop;
              }

              // Only emit progress for non-marker text (marker was already handled above)
              if (!specDetected) {
                logger.info(
                  `Emitting progress event for ${featureId}, content length: ${block.text?.length || 0}`
                );
                this.emitAutoModeEvent('auto_mode_progress', {
                  featureId,
                  content: block.text,
                });
              }
            } else if (block.type === 'tool_use') {
              // Emit event for real-time UI
              this.emitAutoModeEvent('auto_mode_tool', {
                featureId,
                tool: block.name,
                input: block.input,
              });

              // Also add to file output for persistence
              if (responseText.length > 0 && !responseText.endsWith('\n')) {
                responseText += '\n';
              }
              responseText += `\n🔧 Tool: ${block.name}\n`;
              if (block.input) {
                responseText += `Input: ${JSON.stringify(block.input, null, 2)}\n`;
              }
              scheduleWrite();
            }
          }
        } else if (msg.type === 'error') {
          // Handle error messages
          throw new Error(msg.error || 'Unknown error');
        } else if (msg.type === 'result' && msg.subtype === 'success') {
          // Don't replace responseText - the accumulated content is the full history
          // The msg.result is just a summary which would lose all tool use details
          // Just ensure final write happens
          scheduleWrite();
        }
      }

      // Final write - ensure all accumulated content is saved (on success path)
      await writeToFile();

      // Flush remaining raw output (only if enabled, on success path)
      if (enableRawOutput && rawOutputLines.length > 0) {
        try {
          await secureFs.mkdir(path.dirname(rawOutputPath), { recursive: true });
          await secureFs.appendFile(rawOutputPath, rawOutputLines.join('\n') + '\n');
        } catch (error) {
          logger.error(`Failed to write final raw output for ${featureId}:`, error);
        }
      }
    } finally {
      clearInterval(streamHeartbeat);
      // ALWAYS clear pending timeouts to prevent memory leaks
      // This runs on success, error, or abort
      if (writeTimeout) {
        clearTimeout(writeTimeout);
        writeTimeout = null;
      }
      if (rawWriteTimeout) {
        clearTimeout(rawWriteTimeout);
        rawWriteTimeout = null;
      }
    }
  }

  private async executeFeatureWithContext(
    projectPath: string,
    featureId: string,
    context: string,
    useWorktrees: boolean
  ): Promise<void> {
    const feature = await this.loadFeature(projectPath, featureId);
    if (!feature) {
      throw new Error(`Feature ${featureId} not found`);
    }

    const prompt = `## Continuing Feature Implementation

${this.buildFeaturePrompt(feature)}

## Previous Context
The following is the output from a previous implementation attempt. Continue from where you left off:

${context}

## Instructions
Review the previous work and continue the implementation. If the feature appears complete, verify it works correctly.`;

    return this.executeFeature(projectPath, featureId, useWorktrees, false, undefined, {
      continuationPrompt: prompt,
    });
  }

  /**
   * Detect if a feature is stuck in a pipeline step and extract step information.
   * Parses the feature status to determine if it's a pipeline status (e.g., 'pipeline_step_xyz'),
   * loads the pipeline configuration, and validates that the step still exists.
   *
   * This method handles several scenarios:
   * - Non-pipeline status: Returns default PipelineStatusInfo with isPipeline=false
   * - Invalid pipeline status format: Returns isPipeline=true but null step info
   * - Step deleted from config: Returns stepIndex=-1 to signal missing step
   * - Valid pipeline step: Returns full step information and config
   *
   * @param {string} projectPath - Absolute path to the project directory
   * @param {string} featureId - Unique identifier of the feature
   * @param {FeatureStatusWithPipeline} currentStatus - Current feature status (may include pipeline step info)
   * @returns {Promise<PipelineStatusInfo>} Information about the pipeline status and step
   * @private
   */
  private async detectPipelineStatus(
    projectPath: string,
    featureId: string,
    currentStatus: FeatureStatusWithPipeline
  ): Promise<PipelineStatusInfo> {
    // Check if status is pipeline format using PipelineService
    const isPipeline = pipelineService.isPipelineStatus(currentStatus);

    if (!isPipeline) {
      return {
        isPipeline: false,
        stepId: null,
        stepIndex: -1,
        totalSteps: 0,
        step: null,
        config: null,
      };
    }

    // Extract step ID using PipelineService
    const stepId = pipelineService.getStepIdFromStatus(currentStatus);

    if (!stepId) {
      console.warn(
        `[AutoMode] Feature ${featureId} has invalid pipeline status format: ${currentStatus}`
      );
      return {
        isPipeline: true,
        stepId: null,
        stepIndex: -1,
        totalSteps: 0,
        step: null,
        config: null,
      };
    }

    // Load pipeline config
    const config = await pipelineService.getPipelineConfig(projectPath);

    if (!config || config.steps.length === 0) {
      // Pipeline config doesn't exist or empty - feature stuck with invalid pipeline status
      console.warn(
        `[AutoMode] Feature ${featureId} has pipeline status but no pipeline config exists`
      );
      return {
        isPipeline: true,
        stepId,
        stepIndex: -1,
        totalSteps: 0,
        step: null,
        config: null,
      };
    }

    // Find the step directly from config (already loaded, avoid redundant file read)
    const sortedSteps = [...config.steps].sort((a, b) => a.order - b.order);
    const stepIndex = sortedSteps.findIndex((s) => s.id === stepId);
    const step = stepIndex === -1 ? null : sortedSteps[stepIndex];

    if (!step) {
      // Step not found in current config - step was deleted/changed
      console.warn(
        `[AutoMode] Feature ${featureId} stuck in step ${stepId} which no longer exists in pipeline config`
      );
      return {
        isPipeline: true,
        stepId,
        stepIndex: -1,
        totalSteps: sortedSteps.length,
        step: null,
        config,
      };
    }

    console.log(
      `[AutoMode] Detected pipeline status for feature ${featureId}: step ${stepIndex + 1}/${sortedSteps.length} (${step.name})`
    );

    return {
      isPipeline: true,
      stepId,
      stepIndex,
      totalSteps: sortedSteps.length,
      step,
      config,
    };
  }

  /**
   * Build a focused prompt for executing a single task.
   * Each task gets minimal context to keep the agent focused.
   */
  private buildTaskPrompt(
    task: ParsedTask,
    allTasks: ParsedTask[],
    taskIndex: number,
    planContent: string,
    userFeedback?: string
  ): string {
    const completedTasks = allTasks.slice(0, taskIndex);
    const remainingTasks = allTasks.slice(taskIndex + 1);

    let prompt = `# Task Execution: ${task.id}

You are executing a specific task as part of a larger feature implementation.

## Your Current Task

**Task ID:** ${task.id}
**Description:** ${task.description}
${task.filePath ? `**Primary File:** ${task.filePath}` : ''}
${task.phase ? `**Phase:** ${task.phase}` : ''}
${task.dependsOn ? `**Depends On:** ${task.dependsOn.join(', ')}` : ''}
${task.complexity ? `**Complexity:** ${task.complexity}` : ''}

## Context

`;

    // Show what's already done
    if (completedTasks.length > 0) {
      prompt += `### Already Completed (${completedTasks.length} tasks)
${completedTasks.map((t) => `- [x] ${t.id}: ${t.description}`).join('\n')}

`;
    }

    // Show remaining tasks
    if (remainingTasks.length > 0) {
      prompt += `### Coming Up Next (${remainingTasks.length} tasks remaining)
${remainingTasks
  .slice(0, 3)
  .map((t) => `- [ ] ${t.id}: ${t.description}`)
  .join('\n')}
${remainingTasks.length > 3 ? `... and ${remainingTasks.length - 3} more tasks` : ''}

`;
    }

    // Add user feedback if any
    if (userFeedback) {
      prompt += `### User Feedback
${userFeedback}

`;
    }

    // Add relevant excerpt from plan (just the task-related part to save context)
    prompt += `### Reference: Full Plan
<details>
${planContent}
</details>

## Instructions

1. Focus ONLY on completing task ${task.id}: "${task.description}"
2. Do not work on other tasks
3. Use the existing codebase patterns
4. When done, summarize what you implemented

    Begin implementing task ${task.id} now.`;

    return prompt;
  }

  private shouldRefineTasks(tasks: ParsedTask[], pass: number): boolean {
    if (pass >= MAX_SUBPLANNING_PASSES) {
      return false;
    }

    const weights: Record<PlanTaskComplexity, number> = {
      low: 1,
      medium: 2,
      high: 3,
    };

    const complexityScore = tasks.reduce((score, task) => {
      const complexity = task.complexity || 'medium';
      return score + weights[complexity];
    }, 0);
    const highCount = tasks.filter((task) => task.complexity === 'high').length;

    return (
      tasks.length >= TASK_REFINEMENT_COUNT_THRESHOLD ||
      complexityScore >= TASK_REFINEMENT_SCORE_THRESHOLD ||
      highCount >= 2
    );
  }

  private async refineTasksWithSubPlanner(options: {
    featureId: string;
    projectPath: string;
    tasks: ParsedTask[];
    planContent: string;
    plannerProvider: BaseProvider;
    plannerBareModel: string;
    plannerSdkOptions: {
      maxTurns?: number;
      systemPrompt?: ExecuteOptions['systemPrompt'];
      settingSources?: ExecuteOptions['settingSources'];
    };
    plannerThinkingLevel?: ThinkingLevel;
    plannerReasoningEffort?: ReasoningEffort;
    workDir: string;
    abortController: AbortController;
    allowedTools?: string[];
    mcpServers?: ExecuteOptions['mcpServers'];
  }): Promise<ParsedTask[] | null> {
    const taskSummary = options.tasks
      .map((task) => {
        const deps = task.dependsOn?.length ? ` deps: ${task.dependsOn.join(', ')}` : '';
        const file = task.filePath ? ` file: ${task.filePath}` : '';
        const complexity = task.complexity ? ` complexity: ${task.complexity}` : '';
        return `- ${task.id}: ${task.description}${file}${deps}${complexity}`;
      })
      .join('\n');

    const subPlanPrompt = `You are a sub-planner. Refine the task list into smaller, executable tasks with clear dependencies.

Rules:
- Output ONLY a \`\`\`tasks\`\`\` block (no other text).
- Use sequential IDs (T001, T002, ...).
- Include File, DependsOn (optional), and Complexity (optional) fields.
- Keep scope identical; do not add new features.

## Original Plan Context
${options.planContent}

## Current Tasks
${taskSummary}

Return ONLY the refined tasks block.`;

    const stream = options.plannerProvider.executeQuery({
      prompt: subPlanPrompt,
      model: options.plannerBareModel,
      maxTurns: options.plannerSdkOptions.maxTurns || 120,
      cwd: options.workDir,
      allowedTools: options.allowedTools,
      abortController: options.abortController,
      systemPrompt: options.plannerSdkOptions.systemPrompt,
      settingSources: options.plannerSdkOptions.settingSources,
      thinkingLevel: options.plannerThinkingLevel,
      reasoningEffort: options.plannerReasoningEffort,
      mcpServers: options.mcpServers,
    });

    let responseText = '';
    for await (const msg of stream) {
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            responseText += block.text || '';
          }
        }
      } else if (msg.type === 'result' && msg.subtype === 'success') {
        responseText += msg.result || '';
      } else if (msg.type === 'error') {
        throw new Error(msg.error || 'Error during sub-planning');
      }
    }

    const refinedTasks = parseTasksFromSpec(responseText);
    return refinedTasks.length > 0 ? refinedTasks : null;
  }

  private async executeTasksWithDependencies(options: {
    projectPath: string;
    featureId: string;
    workDir: string;
    tasks: ParsedTask[];
    planContent: string;
    userFeedback?: string;
    workerProvider: BaseProvider;
    workerBareModel: string;
    workerSdkOptions: {
      maxTurns?: number;
      systemPrompt?: ExecuteOptions['systemPrompt'];
      settingSources?: ExecuteOptions['settingSources'];
    };
    workerThinkingLevel?: ThinkingLevel;
    workerReasoningEffort?: ReasoningEffort;
    allowedTools?: string[];
    abortController: AbortController;
    mcpServers?: ExecuteOptions['mcpServers'];
    appendOutput: (text: string) => void;
  }): Promise<void> {
    const settings = await this.settingsService?.getGlobalSettings();
    const maxTaskConcurrency = Math.max(
      1,
      Math.min(settings?.maxConcurrency ?? DEFAULT_MAX_TASK_CONCURRENCY, MAX_TASK_CONCURRENCY_CAP)
    );

    const tasks = options.tasks;
    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    const taskOrder = new Map(tasks.map((task, index) => [task.id, index]));

    const missingDependencies = new Map<string, string[]>();

    for (const task of tasks) {
      task.status = task.status || 'pending';
      if (task.dependsOn && task.dependsOn.length > 0) {
        const missing = task.dependsOn.filter((depId) => !taskMap.has(depId));
        if (missing.length > 0) {
          missingDependencies.set(task.id, missing);
          task.status = 'blocked';
        }
      }
    }

    const syncPlanSpec = async (): Promise<void> => {
      const inProgressIds = tasks
        .filter((task) => task.status === 'in_progress')
        .map((task) => task.id);
      const completedCount = tasks.filter((task) => task.status === 'completed').length;
      await this.updatePlanSpecWithRetry(options.projectPath, options.featureId, (planSpec) => ({
        ...planSpec,
        tasks: tasks,
        tasksCompleted: completedCount,
        tasksTotal: tasks.length,
        currentTaskId: inProgressIds[0],
        currentTaskIds: inProgressIds,
      }));
    };

    if (missingDependencies.size > 0) {
      logger.warn(
        `Task dependency issues for ${options.featureId}: ` +
          Array.from(missingDependencies.entries())
            .map(([taskId, deps]) => `${taskId} missing ${deps.join(', ')}`)
            .join('; ')
      );
      await syncPlanSpec();
    }

    const isReady = (task: ParsedTask): boolean => {
      if (task.status !== 'pending') {
        return false;
      }
      const deps = task.dependsOn || [];
      return deps.every((depId) => taskMap.get(depId)?.status === 'completed');
    };

    const readyQueue: ParsedTask[] = tasks.filter((task) => isReady(task));
    const inFlight = new Map<string, Promise<{ id: string; status: 'completed' | 'failed' }>>();
    let hadFailure = false;

    const scheduleTask = async (task: ParsedTask) => {
      task.status = 'in_progress';
      await syncPlanSpec();

      this.emitAutoModeEvent('auto_mode_task_started', {
        featureId: options.featureId,
        projectPath: options.projectPath,
        taskId: task.id,
        taskDescription: task.description,
        taskIndex: taskOrder.get(task.id) ?? 0,
        tasksTotal: tasks.length,
      });

      const taskPrompt = this.buildTaskPrompt(
        task,
        tasks,
        taskOrder.get(task.id) ?? 0,
        options.planContent,
        options.userFeedback
      );

      const taskPromise = (async () => {
        const taskStream = options.workerProvider.executeQuery({
          prompt: taskPrompt,
          model: options.workerBareModel,
          maxTurns: Math.min(options.workerSdkOptions.maxTurns || 100, 50),
          cwd: options.workDir,
          allowedTools: options.allowedTools,
          abortController: options.abortController,
          systemPrompt: options.workerSdkOptions.systemPrompt,
          settingSources: options.workerSdkOptions.settingSources,
          thinkingLevel: options.workerThinkingLevel,
          reasoningEffort: options.workerReasoningEffort,
          mcpServers: options.mcpServers,
        });

        for await (const msg of taskStream) {
          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text') {
                const text = block.text || '';
                if (text) {
                  options.appendOutput(text);
                  this.emitAutoModeEvent('auto_mode_progress', {
                    featureId: options.featureId,
                    content: text,
                  });
                }
              } else if (block.type === 'tool_use') {
                this.emitAutoModeEvent('auto_mode_tool', {
                  featureId: options.featureId,
                  tool: block.name,
                  input: block.input,
                });
              }
            }
          } else if (msg.type === 'error') {
            throw new Error(msg.error || `Error during task ${task.id}`);
          } else if (msg.type === 'result' && msg.subtype === 'success') {
            if (msg.result) {
              options.appendOutput(msg.result);
            }
          }
        }

        return { id: task.id, status: 'completed' as const };
      })().catch((error) => {
        logger.error(`Task ${task.id} failed:`, error);
        return { id: task.id, status: 'failed' as const };
      });

      inFlight.set(task.id, taskPromise);
      taskPromise.finally(() => inFlight.delete(task.id));
    };

    while (true) {
      if (options.abortController.signal.aborted) {
        throw new Error('Feature execution aborted');
      }
      while (!hadFailure && inFlight.size < maxTaskConcurrency && readyQueue.length > 0) {
        const nextTask = readyQueue.shift();
        if (nextTask) {
          await scheduleTask(nextTask);
        }
      }

      if (inFlight.size === 0) {
        break;
      }

      const result = await Promise.race(inFlight.values());
      const finishedTask = taskMap.get(result.id);
      if (!finishedTask) {
        continue;
      }

      if (result.status === 'completed') {
        finishedTask.status = 'completed';
        this.emitAutoModeEvent('auto_mode_task_complete', {
          featureId: options.featureId,
          projectPath: options.projectPath,
          taskId: finishedTask.id,
          tasksCompleted: tasks.filter((task) => task.status === 'completed').length,
          tasksTotal: tasks.length,
        });
      } else {
        finishedTask.status = 'failed';
        hadFailure = true;
      }

      await syncPlanSpec();

      if (!hadFailure) {
        for (const task of tasks) {
          if (isReady(task) && !readyQueue.includes(task) && !inFlight.has(task.id)) {
            readyQueue.push(task);
          }
        }

        if (finishedTask.phase) {
          const phaseTasks = tasks.filter((task) => task.phase === finishedTask.phase);
          if (phaseTasks.length > 0 && phaseTasks.every((task) => task.status === 'completed')) {
            const phaseMatch = finishedTask.phase.match(/Phase\s*(\d+)/i);
            if (phaseMatch) {
              this.emitAutoModeEvent('auto_mode_phase_complete', {
                featureId: options.featureId,
                projectPath: options.projectPath,
                phaseNumber: parseInt(phaseMatch[1], 10),
              });
            }
          }
        }
      }
    }

    if (hadFailure) {
      for (const task of tasks) {
        if (task.status === 'pending') {
          task.status = 'blocked';
        }
      }
      await syncPlanSpec();
      throw new Error('One or more tasks failed during concurrent execution.');
    }

    const remaining = tasks.filter((task) => task.status === 'pending');
    if (remaining.length > 0) {
      for (const task of remaining) {
        task.status = 'blocked';
      }
      await syncPlanSpec();
      throw new Error('Task dependency cycle detected - pending tasks are blocked.');
    }
  }

  /**
   * Emit an auto-mode event wrapped in the correct format for the client.
   * All auto-mode events are sent as type "auto-mode:event" with the actual
   * event type and data in the payload.
   */
  private emitAutoModeEvent(eventType: string, data: Record<string, unknown>): void {
    // Wrap the event in auto-mode:event format expected by the client
    this.events.emit('auto-mode:event', {
      type: eventType,
      ...data,
    });
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, ms);

      // If signal is provided and already aborted, reject immediately
      if (signal?.aborted) {
        clearTimeout(timeout);
        reject(new Error('Aborted'));
        return;
      }

      // Listen for abort signal
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout);
            reject(new Error('Aborted'));
          },
          { once: true }
        );
      }
    });
  }

  // ============================================================================
  // Execution State Persistence - For recovery after server restart
  // ============================================================================

  /**
   * Save execution state to disk for recovery after server restart
   */
  private async saveExecutionState(projectPath: string): Promise<void> {
    try {
      await ensureAutomakerDir(projectPath);
      const statePath = getExecutionStatePath(projectPath);
      const state: ExecutionState = {
        version: 1,
        autoLoopWasRunning: this.autoLoopRunning,
        maxConcurrency: this.config?.maxConcurrency ?? 3,
        projectPath,
        runningFeatureIds: Array.from(this.runningFeatures.keys()),
        savedAt: new Date().toISOString(),
      };
      await secureFs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
      logger.info(`Saved execution state: ${state.runningFeatureIds.length} running features`);
    } catch (error) {
      logger.error('Failed to save execution state:', error);
    }
  }

  /**
   * Load execution state from disk
   */
  private async loadExecutionState(projectPath: string): Promise<ExecutionState> {
    try {
      const statePath = getExecutionStatePath(projectPath);
      const content = (await secureFs.readFile(statePath, 'utf-8')) as string;
      const state = JSON.parse(content) as ExecutionState;
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to load execution state:', error);
      }
      return DEFAULT_EXECUTION_STATE;
    }
  }

  /**
   * Clear execution state (called on successful shutdown or when auto-loop stops)
   */
  private async clearExecutionState(projectPath: string): Promise<void> {
    try {
      const statePath = getExecutionStatePath(projectPath);
      await secureFs.unlink(statePath);
      logger.info('Cleared execution state');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('Failed to clear execution state:', error);
      }
    }
  }

  /**
   * Check for and resume interrupted features after server restart
   * This should be called during server initialization
   */
  async resumeInterruptedFeatures(projectPath: string): Promise<void> {
    logger.info('Checking for interrupted features to resume...');

    // Load all features and find those that were interrupted
    const featuresDir = getFeaturesDir(projectPath);

    try {
      const entries = await secureFs.readdir(featuresDir, { withFileTypes: true });
      const interruptedFeatures: Feature[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const featurePath = path.join(featuresDir, entry.name, 'feature.json');
          try {
            const data = (await secureFs.readFile(featurePath, 'utf-8')) as string;
            const feature = JSON.parse(data) as Feature;

            // Check if feature was interrupted (in_progress or pipeline_*)
            if (
              feature.status === 'in_progress' ||
              (feature.status && feature.status.startsWith('pipeline_'))
            ) {
              // Verify it has existing context (agent-output.md)
              const featureDir = getFeatureDir(projectPath, feature.id);
              const contextPath = path.join(featureDir, 'agent-output.md');
              try {
                await secureFs.access(contextPath);
                interruptedFeatures.push(feature);
                logger.info(
                  `Found interrupted feature: ${feature.id} (${feature.title}) - status: ${feature.status}`
                );
              } catch {
                // No context file, skip this feature - it will be restarted fresh
                logger.info(`Interrupted feature ${feature.id} has no context, will restart fresh`);
              }
            }
          } catch {
            // Skip invalid features
          }
        }
      }

      if (interruptedFeatures.length === 0) {
        logger.info('No interrupted features found');
        return;
      }

      logger.info(`Found ${interruptedFeatures.length} interrupted feature(s) to resume`);

      // Emit event to notify UI
      this.emitAutoModeEvent('auto_mode_resuming_features', {
        message: `Resuming ${interruptedFeatures.length} interrupted feature(s) after server restart`,
        projectPath,
        featureIds: interruptedFeatures.map((f) => f.id),
        features: interruptedFeatures.map((f) => ({
          id: f.id,
          title: f.title,
          status: f.status,
        })),
      });

      // Resume each interrupted feature
      for (const feature of interruptedFeatures) {
        try {
          logger.info(`Resuming feature: ${feature.id} (${feature.title})`);
          // Use resumeFeature which will detect the existing context and continue
          await this.resumeFeature(projectPath, feature.id, true);
        } catch (error) {
          logger.error(`Failed to resume feature ${feature.id}:`, error);
          // Continue with other features
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info('No features directory found, nothing to resume');
      } else {
        logger.error('Error checking for interrupted features:', error);
      }
    }
  }

  /**
   * Extract and record learnings from a completed feature
   * Uses a quick Claude call to identify important decisions and patterns
   */
  private async recordLearningsFromFeature(
    projectPath: string,
    feature: Feature,
    agentOutput: string
  ): Promise<void> {
    if (!agentOutput || agentOutput.length < 100) {
      // Not enough output to extract learnings from
      console.log(
        `[AutoMode] Skipping learning extraction - output too short (${agentOutput?.length || 0} chars)`
      );
      return;
    }

    console.log(
      `[AutoMode] Extracting learnings from feature "${feature.title}" (${agentOutput.length} chars)`
    );

    // Limit output to avoid token limits
    const truncatedOutput = agentOutput.length > 10000 ? agentOutput.slice(-10000) : agentOutput;

    const userPrompt = `You are an Architecture Decision Record (ADR) extractor. Analyze this implementation and return ONLY JSON with learnings. No explanations.

Feature: "${feature.title}"

Implementation log:
${truncatedOutput}

Extract MEANINGFUL learnings - not obvious things. For each, capture:
- DECISIONS: Why this approach vs alternatives? What would break if changed?
- GOTCHAS: What was unexpected? What's the root cause? How to avoid?
- PATTERNS: Why this pattern? What problem does it solve? Trade-offs?

JSON format ONLY (no markdown, no text):
{"learnings": [{
  "category": "architecture|api|ui|database|auth|testing|performance|security|gotchas",
  "type": "decision|gotcha|pattern",
  "content": "What was done/learned",
  "context": "Problem being solved or situation faced",
  "why": "Reasoning - why this approach",
  "rejected": "Alternative considered and why rejected",
  "tradeoffs": "What became easier/harder",
  "breaking": "What breaks if this is changed/removed"
}]}

IMPORTANT: Only include NON-OBVIOUS learnings with real reasoning. Skip trivial patterns.
If nothing notable: {"learnings": []}`;

    try {
      // Get model from phase settings
      const settings = await this.settingsService?.getGlobalSettings();
      const phaseModelEntry =
        settings?.phaseModels?.memoryExtractionModel || DEFAULT_PHASE_MODELS.memoryExtractionModel;
      const { model } = resolvePhaseModel(phaseModelEntry);
      const hasClaudeKey = Boolean(process.env.ANTHROPIC_API_KEY);
      let resolvedModel = model;

      if (isClaudeModel(model) && !hasClaudeKey) {
        const fallbackModel = feature.model
          ? resolveModelString(feature.model, DEFAULT_MODELS.claude)
          : null;
        if (fallbackModel && !isClaudeModel(fallbackModel)) {
          console.log(
            `[AutoMode] Claude not configured for memory extraction; using feature model "${fallbackModel}".`
          );
          resolvedModel = fallbackModel;
        } else {
          console.log(
            '[AutoMode] Claude not configured for memory extraction; skipping learning extraction.'
          );
          return;
        }
      }

      const result = await simpleQuery({
        prompt: userPrompt,
        model: resolvedModel,
        cwd: projectPath,
        maxTurns: 1,
        allowedTools: [],
        systemPrompt:
          'You are a JSON extraction assistant. You MUST respond with ONLY valid JSON, no explanations, no markdown, no other text. Extract learnings from the provided implementation context and return them as JSON.',
      });

      const responseText = result.text;

      console.log(`[AutoMode] Learning extraction response: ${responseText.length} chars`);
      console.log(`[AutoMode] Response preview: ${responseText.substring(0, 300)}`);

      // Parse the response - handle JSON in markdown code blocks or raw
      let jsonStr: string | null = null;

      // First try to find JSON in markdown code blocks
      const codeBlockMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      if (codeBlockMatch) {
        console.log('[AutoMode] Found JSON in code block');
        jsonStr = codeBlockMatch[1];
      } else {
        // Fall back to finding balanced braces containing "learnings"
        // Use a more precise approach: find the opening brace before "learnings"
        const learningsIndex = responseText.indexOf('"learnings"');
        if (learningsIndex !== -1) {
          // Find the opening brace before "learnings"
          let braceStart = responseText.lastIndexOf('{', learningsIndex);
          if (braceStart !== -1) {
            // Find matching closing brace
            let braceCount = 0;
            let braceEnd = -1;
            for (let i = braceStart; i < responseText.length; i++) {
              if (responseText[i] === '{') braceCount++;
              if (responseText[i] === '}') braceCount--;
              if (braceCount === 0) {
                braceEnd = i;
                break;
              }
            }
            if (braceEnd !== -1) {
              jsonStr = responseText.substring(braceStart, braceEnd + 1);
            }
          }
        }
      }

      if (!jsonStr) {
        console.log('[AutoMode] Could not extract JSON from response');
        return;
      }

      console.log(`[AutoMode] Extracted JSON: ${jsonStr.substring(0, 200)}`);

      let parsed: { learnings?: unknown[] };
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        console.warn('[AutoMode] Failed to parse learnings JSON:', jsonStr.substring(0, 200));
        return;
      }

      if (!parsed.learnings || !Array.isArray(parsed.learnings)) {
        console.log('[AutoMode] No learnings array in parsed response');
        return;
      }

      console.log(`[AutoMode] Found ${parsed.learnings.length} potential learnings`);

      // Valid learning types
      const validTypes = new Set(['decision', 'learning', 'pattern', 'gotcha']);
      const createdAt = new Date().toISOString();
      const relatedFeatures = Array.from(
        new Set(
          [feature.id, feature.title].filter((value): value is string =>
            Boolean(value && value.trim())
          )
        )
      );
      const decisionsToRecord: ArchitecturalDecision[] = [];
      const rejectedToRecord: RejectedApproach[] = [];
      const patternsToRecord: CodePattern[] = [];
      let testStrategyUpdate: TestingStrategy | undefined;

      const normalizeText = (value: string): string => value.trim().replace(/\s+/g, ' ');
      const normalizeKey = (value: string): string => normalizeText(value).toLowerCase();
      const mergeRelatedFeatures = (existing: string[], incoming: string[]): string[] =>
        Array.from(new Set([...(existing || []), ...incoming].filter(Boolean)));
      const buildRationale = (input: {
        why?: string;
        context?: string;
        tradeoffs?: string;
        breaking?: string;
      }): string => {
        const parts: string[] = [];
        if (input.why) {
          parts.push(input.why);
        } else if (input.context) {
          parts.push(input.context);
        }
        if (input.tradeoffs) {
          parts.push(`Tradeoffs: ${input.tradeoffs}`);
        }
        if (input.breaking) {
          parts.push(`Breaks if changed: ${input.breaking}`);
        }
        return parts.join('; ');
      };
      const buildPatternName = (content: string): string => {
        const firstSentence = content.split(/[.!?]/)[0].trim();
        const candidate = firstSentence || content;
        return candidate.slice(0, 60);
      };
      const splitRejected = (
        rejected: string,
        fallbackReason?: string
      ): { approach: string; reason: string } => {
        const separators = [' because ', ' due to ', ' since ', ' - ', ' — ', ' – '];
        const lowered = rejected.toLowerCase();
        for (const separator of separators) {
          const index = lowered.indexOf(separator);
          if (index > 0) {
            return {
              approach: rejected.slice(0, index).trim(),
              reason: rejected.slice(index + separator.length).trim(),
            };
          }
        }
        return { approach: rejected.trim(), reason: fallbackReason?.trim() || '' };
      };
      const createMemoryKey = (prefix: string, seed: string, index: number): string => {
        const slug = seed
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        const compactStamp = createdAt.replace(/[^0-9]/g, '');
        return `${prefix}-${(slug || 'entry').slice(0, 40)}-${compactStamp}-${index}`;
      };
      const mergeNotes = (current?: string, next?: string): string | undefined => {
        if (!current && !next) return undefined;
        if (!current) return next;
        if (!next || current.includes(next)) return current;
        return `${current} ${next}`.trim();
      };

      // Record each learning
      for (const item of parsed.learnings) {
        // Validate required fields with proper type narrowing
        if (!item || typeof item !== 'object') continue;

        const learning = item as Record<string, unknown>;
        if (
          !learning.category ||
          typeof learning.category !== 'string' ||
          !learning.content ||
          typeof learning.content !== 'string' ||
          !learning.content.trim()
        ) {
          continue;
        }

        // Validate and normalize type
        const typeStr = typeof learning.type === 'string' ? learning.type : 'learning';
        const learningType = validTypes.has(typeStr)
          ? (typeStr as 'decision' | 'learning' | 'pattern' | 'gotcha')
          : 'learning';
        const content = learning.content.trim();
        const context = typeof learning.context === 'string' ? learning.context.trim() : undefined;
        const why = typeof learning.why === 'string' ? learning.why.trim() : undefined;
        const rejected =
          typeof learning.rejected === 'string' ? learning.rejected.trim() : undefined;
        const tradeoffs =
          typeof learning.tradeoffs === 'string' ? learning.tradeoffs.trim() : undefined;
        const breaking =
          typeof learning.breaking === 'string' ? learning.breaking.trim() : undefined;

        console.log(
          `[AutoMode] Appending learning: category=${learning.category}, type=${learningType}`
        );
        await appendLearning(
          projectPath,
          {
            category: learning.category,
            type: learningType,
            content,
            context,
            why,
            rejected,
            tradeoffs,
            breaking,
          },
          secureFs as Parameters<typeof appendLearning>[2]
        );

        if (learningType === 'decision') {
          const rationale = buildRationale({ why, context, tradeoffs, breaking });
          decisionsToRecord.push({
            decision: content,
            rationale: rationale || 'No rationale recorded.',
            timestamp: createdAt,
            relatedFeatures: relatedFeatures.slice(),
          });
        }

        if (learningType === 'pattern') {
          patternsToRecord.push({
            name: buildPatternName(content),
            description: content,
            rationale: why || undefined,
          });
        }

        if (rejected) {
          const fallbackReason = why || tradeoffs || context || breaking;
          const { approach, reason } = splitRejected(rejected, fallbackReason);
          if (approach) {
            rejectedToRecord.push({
              approach,
              reason: reason || 'No reason recorded.',
              timestamp: createdAt,
              relatedFeatures: relatedFeatures.slice(),
            });
          }
        }

        if (!testStrategyUpdate && learning.category.toLowerCase() === 'testing') {
          const notes = buildRationale({ why, context, tradeoffs, breaking });
          testStrategyUpdate = {
            approach: content,
            notes: notes || undefined,
          };
        }
      }

      if (
        decisionsToRecord.length > 0 ||
        rejectedToRecord.length > 0 ||
        patternsToRecord.length > 0 ||
        testStrategyUpdate
      ) {
        await updateArchitecturalMemory(
          projectPath,
          (memory) => {
            const updated = {
              ...memory,
              decisions: { ...memory.decisions },
              rejectedApproaches: { ...memory.rejectedApproaches },
              patterns: [...memory.patterns],
            };

            let decisionIndex = 0;
            for (const decision of decisionsToRecord) {
              const existingKey = Object.keys(updated.decisions).find(
                (key) =>
                  normalizeKey(updated.decisions[key].decision) === normalizeKey(decision.decision)
              );
              if (existingKey) {
                const existing = updated.decisions[existingKey];
                updated.decisions[existingKey] = {
                  ...existing,
                  rationale: existing.rationale || decision.rationale,
                  relatedFeatures: mergeRelatedFeatures(
                    existing.relatedFeatures,
                    decision.relatedFeatures
                  ),
                };
              } else {
                const key = createMemoryKey('decision', decision.decision, decisionIndex++);
                updated.decisions[key] = decision;
              }
            }

            let rejectedIndex = 0;
            for (const rejected of rejectedToRecord) {
              const existingKey = Object.keys(updated.rejectedApproaches).find(
                (key) =>
                  normalizeKey(updated.rejectedApproaches[key].approach) ===
                  normalizeKey(rejected.approach)
              );
              if (existingKey) {
                const existing = updated.rejectedApproaches[existingKey];
                updated.rejectedApproaches[existingKey] = {
                  ...existing,
                  reason: existing.reason || rejected.reason,
                  relatedFeatures: mergeRelatedFeatures(
                    existing.relatedFeatures,
                    rejected.relatedFeatures
                  ),
                };
              } else {
                const key = createMemoryKey('rejected', rejected.approach, rejectedIndex++);
                updated.rejectedApproaches[key] = rejected;
              }
            }

            for (const pattern of patternsToRecord) {
              const existingIndex = updated.patterns.findIndex(
                (entry) => normalizeKey(entry.name) === normalizeKey(pattern.name)
              );
              if (existingIndex === -1) {
                updated.patterns.push(pattern);
              } else {
                const existing = updated.patterns[existingIndex];
                updated.patterns[existingIndex] = {
                  ...existing,
                  rationale: existing.rationale || pattern.rationale,
                };
              }
            }

            if (testStrategyUpdate) {
              if (!updated.testStrategy) {
                updated.testStrategy = testStrategyUpdate;
              } else {
                updated.testStrategy = {
                  ...updated.testStrategy,
                  approach: updated.testStrategy.approach || testStrategyUpdate.approach,
                  tools: updated.testStrategy.tools?.length
                    ? updated.testStrategy.tools
                    : testStrategyUpdate.tools,
                  notes: mergeNotes(updated.testStrategy.notes, testStrategyUpdate.notes),
                };
              }
            }

            return updated;
          },
          secureFs as Parameters<typeof updateArchitecturalMemory>[2]
        );
      }

      const validLearnings = parsed.learnings.filter(
        (l) => l && typeof l === 'object' && (l as Record<string, unknown>).content
      );
      if (validLearnings.length > 0) {
        console.log(
          `[AutoMode] Recorded ${parsed.learnings.length} learning(s) from feature ${feature.id}`
        );
      }
    } catch (error) {
      console.warn(`[AutoMode] Failed to extract learnings from feature ${feature.id}:`, error);
    }
  }
}
