/**
 * POST /metrics endpoint - Get auto mode metrics
 */

import type { Request, Response } from 'express';
import type { AutoModeService } from '../../../services/auto-mode-service.js';
import { getErrorMessage, logError } from '../common.js';

export function createMetricsHandler(autoModeService: AutoModeService) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const { projectPath } = req.body as { projectPath: string };
      const metrics = await autoModeService.getMetricsSnapshot(projectPath);
      res.json({ success: true, metrics });
    } catch (error) {
      logError(error, 'Get metrics failed');
      res.status(500).json({ success: false, error: getErrorMessage(error) });
    }
  };
}
