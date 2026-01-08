/**
 * Codex Model Definitions
 *
 * Official Codex CLI models as documented at https://developers.openai.com/codex/models/
 */

import { CODEX_MODEL_MAP } from '@automaker/types';
import type { ModelDefinition } from './types.js';

const CONTEXT_WINDOW_200K = 200000;
const CONTEXT_WINDOW_128K = 128000;
const MAX_OUTPUT_32K = 32000;
const MAX_OUTPUT_16K = 16000;

/**
 * All available Codex models with their specifications
 */
export const CODEX_MODELS: ModelDefinition[] = [
  // ========== Codex-Specific Models ==========
  {
    id: CODEX_MODEL_MAP.gpt52Codex,
    name: 'GPT-5.2-Codex',
    modelString: CODEX_MODEL_MAP.gpt52Codex,
    provider: 'openai',
    description:
      'Most advanced agentic coding model for complex software engineering (default for ChatGPT users).',
    contextWindow: CONTEXT_WINDOW_200K,
    maxOutputTokens: MAX_OUTPUT_32K,
    supportsVision: true,
    supportsTools: true,
    tier: 'premium' as const,
    default: true,
    hasReasoning: true,
  },
  {
    id: CODEX_MODEL_MAP.gpt5Codex,
    name: 'GPT-5-Codex',
    modelString: CODEX_MODEL_MAP.gpt5Codex,
    provider: 'openai',
    description: 'Purpose-built for Codex CLI with versatile tool use (default for CLI users).',
    contextWindow: CONTEXT_WINDOW_200K,
    maxOutputTokens: MAX_OUTPUT_32K,
    supportsVision: true,
    supportsTools: true,
    tier: 'standard' as const,
    hasReasoning: true,
  },
  {
    id: CODEX_MODEL_MAP.gpt5CodexMini,
    name: 'GPT-5-Codex-Mini',
    modelString: CODEX_MODEL_MAP.gpt5CodexMini,
    provider: 'openai',
    description: 'Faster workflows optimized for low-latency code Q&A and editing.',
    contextWindow: CONTEXT_WINDOW_128K,
    maxOutputTokens: MAX_OUTPUT_16K,
    supportsVision: false,
    supportsTools: true,
    tier: 'basic' as const,
    hasReasoning: false,
  },
  {
    id: CODEX_MODEL_MAP.codex1,
    name: 'Codex-1',
    modelString: CODEX_MODEL_MAP.codex1,
    provider: 'openai',
    description: 'Version of o3 optimized for software engineering with advanced reasoning.',
    contextWindow: CONTEXT_WINDOW_200K,
    maxOutputTokens: MAX_OUTPUT_32K,
    supportsVision: true,
    supportsTools: true,
    tier: 'premium' as const,
    hasReasoning: true,
  },
  {
    id: CODEX_MODEL_MAP.codexMiniLatest,
    name: 'Codex-Mini-Latest',
    modelString: CODEX_MODEL_MAP.codexMiniLatest,
    provider: 'openai',
    description: 'Version of o4-mini designed for Codex with faster workflows.',
    contextWindow: CONTEXT_WINDOW_128K,
    maxOutputTokens: MAX_OUTPUT_16K,
    supportsVision: true,
    supportsTools: true,
    tier: 'standard' as const,
    hasReasoning: false,
  },

  // ========== Base GPT-5 Model ==========
  {
    id: CODEX_MODEL_MAP.gpt5,
    name: 'GPT-5',
    modelString: CODEX_MODEL_MAP.gpt5,
    provider: 'openai',
    description: 'GPT-5 base flagship model with strong general-purpose capabilities.',
    contextWindow: CONTEXT_WINDOW_200K,
    maxOutputTokens: MAX_OUTPUT_32K,
    supportsVision: true,
    supportsTools: true,
    tier: 'standard' as const,
    hasReasoning: true,
  },
];

/**
 * Get model definition by ID
 */
export function getCodexModelById(modelId: string): ModelDefinition | undefined {
  return CODEX_MODELS.find((m) => m.id === modelId || m.modelString === modelId);
}

/**
 * Get all models that support reasoning
 */
export function getReasoningModels(): ModelDefinition[] {
  return CODEX_MODELS.filter((m) => m.hasReasoning);
}

/**
 * Get models by tier
 */
export function getModelsByTier(tier: 'premium' | 'standard' | 'basic'): ModelDefinition[] {
  return CODEX_MODELS.filter((m) => m.tier === tier);
}
