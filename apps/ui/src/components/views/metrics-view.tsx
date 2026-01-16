import { useCallback, useEffect, useMemo, useState } from 'react';
import { createLogger } from '@automaker/utils/logger';
import { Activity, RefreshCw, Gauge } from 'lucide-react';
import type { AutoModeMetricsSnapshot, AutoModeFeatureRunMetrics } from '@automaker/types';
import { getElectronAPI } from '@/lib/electron';
import { useAppStore } from '@/store/app-store';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const logger = createLogger('MetricsView');

const formatPercent = (value?: number): string =>
  typeof value === 'number' ? `${Math.round(value * 100)}%` : 'n/a';

const formatDuration = (value?: number): string =>
  typeof value === 'number' ? `${Math.round(value / 1000)}s` : 'n/a';

const formatNumber = (value?: number, decimals = 2): string =>
  typeof value === 'number' ? value.toFixed(decimals) : 'n/a';

const statusVariant = (status: AutoModeFeatureRunMetrics['status']) => {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'error';
  return 'info';
};

export function MetricsView() {
  const { currentProject } = useAppStore();
  const [metrics, setMetrics] = useState<AutoModeMetricsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchMetrics = useCallback(async () => {
    if (!currentProject) {
      setMetrics(null);
      setLoading(false);
      return;
    }

    try {
      const api = getElectronAPI();
      if (!api.autoMode?.metrics) {
        setMetrics(null);
        return;
      }
      const result = await api.autoMode.metrics(currentProject.path);
      if (result.success && result.metrics) {
        setMetrics(result.metrics);
      } else {
        setMetrics(null);
      }
    } catch (error) {
      logger.error('Failed to load auto mode metrics:', error);
      setMetrics(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [currentProject]);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  useEffect(() => {
    if (!currentProject) return;
    const api = getElectronAPI();
    if (!api.autoMode) return;

    const unsubscribe = api.autoMode.onEvent((event) => {
      if (event.type === 'auto_mode_metrics_updated') {
        if (!event.projectPath || event.projectPath === currentProject.path) {
          fetchMetrics();
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, [currentProject, fetchMetrics]);

  const summaryCards = useMemo(() => {
    const summary = metrics?.summary;
    return [
      {
        label: 'Success Rate',
        value: formatPercent(summary?.successRate),
        hint: 'Completed runs that passed gates',
      },
      {
        label: 'Revision Rate',
        value: formatNumber(summary?.revisionRate),
        hint: 'Average revisions per run',
      },
      {
        label: 'Avg Duration',
        value: formatDuration(summary?.averageDurationMs),
        hint: 'Mean feature runtime',
      },
      {
        label: 'Utilization',
        value: formatPercent(summary?.utilization),
        hint: 'Workers in use',
      },
      {
        label: 'Token Efficiency',
        value: summary?.tokenEfficiency
          ? `${formatNumber(summary.tokenEfficiency)} tok/line`
          : 'n/a',
        hint: 'Estimated tokens per changed line',
      },
      {
        label: 'Bottleneck',
        value: summary?.bottleneck || 'n/a',
        hint: 'Longest average stage',
      },
    ];
  }, [metrics]);

  const recentRuns = useMemo(() => {
    if (!metrics?.runs?.length) return [];
    return [...metrics.runs].slice(-8).reverse();
  }, [metrics]);

  const complexityDurations = metrics?.summary?.averageDurationByComplexity;

  if (!currentProject) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        Select a project to view metrics.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-brand-500/10">
            <Gauge className="h-6 w-6 text-brand-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Agent Metrics</h1>
            <p className="text-sm text-muted-foreground">
              Live quality and throughput signals for auto mode runs
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setRefreshing(true);
            fetchMetrics();
          }}
          disabled={refreshing}
        >
          <RefreshCw className={cn('h-4 w-4 mr-2', refreshing && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {!metrics || metrics.runs.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <div className="p-4 rounded-full bg-muted/50 mb-4">
            <Activity className="h-12 w-12 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-medium mb-2">No Metrics Yet</h2>
          <p className="text-muted-foreground max-w-md">
            Metrics will appear after auto mode completes a feature run.
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-auto space-y-6">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {summaryCards.map((card) => (
              <Card key={card.label}>
                <CardHeader>
                  <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
                    {card.label}
                  </CardTitle>
                  <div className="text-2xl font-semibold">{card.value}</div>
                  <CardDescription>{card.hint}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Average Time by Complexity</CardTitle>
              <CardDescription>Rolling mean duration per task complexity</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-3">
              {(['low', 'medium', 'high'] as const).map((level) => (
                <div
                  key={level}
                  className="flex items-center justify-between rounded-lg border border-border/60 px-4 py-3"
                >
                  <span className="text-sm font-medium capitalize">{level}</span>
                  <span className="text-sm text-muted-foreground">
                    {formatDuration(complexityDurations?.[level])}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent Runs</CardTitle>
              <CardDescription>Latest auto mode executions</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {recentRuns.map((run) => (
                <div
                  key={run.runId}
                  className="flex flex-col gap-2 rounded-lg border border-border/60 px-4 py-3 md:flex-row md:items-center md:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{run.title || run.featureId}</span>
                      <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Duration: {formatDuration(run.durationMs)} · Attempts: {run.attempts} ·
                      Revisions: {run.revisions}
                    </div>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Complexity: {run.complexity || 'n/a'}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
