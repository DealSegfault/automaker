import { createFileRoute } from '@tanstack/react-router';
import { MetricsView } from '@/components/views/metrics-view';

export const Route = createFileRoute('/metrics')({
  component: MetricsView,
});
