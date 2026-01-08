/**
 * Codex CLI Model IDs
 * Based on OpenAI Codex CLI official models
 * Reference: https://developers.openai.com/codex/models/
 */
export type CodexModelId =
  | 'gpt-5.2-codex' // Most advanced agentic coding model for complex software engineering
  | 'gpt-5-codex' // Purpose-built for Codex CLI with versatile tool use
  | 'gpt-5-codex-mini' // Faster workflows optimized for low-latency code Q&A and editing
  | 'codex-1' // Version of o3 optimized for software engineering
  | 'codex-mini-latest' // Version of o4-mini for Codex, optimized for faster workflows
  | 'gpt-5'; // GPT-5 base flagship model

/**
 * Codex model metadata
 */
export interface CodexModelConfig {
  id: CodexModelId;
  label: string;
  description: string;
  hasThinking: boolean;
  /** Whether the model supports vision/image inputs */
  supportsVision: boolean;
}

/**
 * Complete model map for Codex CLI
 */
export const CODEX_MODEL_CONFIG_MAP: Record<CodexModelId, CodexModelConfig> = {
  'gpt-5.2-codex': {
    id: 'gpt-5.2-codex',
    label: 'GPT-5.2-Codex',
    description: 'Most advanced agentic coding model for complex software engineering',
    hasThinking: true,
    supportsVision: true, // GPT-5 supports vision
  },
  'gpt-5-codex': {
    id: 'gpt-5-codex',
    label: 'GPT-5-Codex',
    description: 'Purpose-built for Codex CLI with versatile tool use',
    hasThinking: true,
    supportsVision: true,
  },
  'gpt-5-codex-mini': {
    id: 'gpt-5-codex-mini',
    label: 'GPT-5-Codex-Mini',
    description: 'Faster workflows optimized for low-latency code Q&A and editing',
    hasThinking: false,
    supportsVision: true,
  },
  'codex-1': {
    id: 'codex-1',
    label: 'Codex-1',
    description: 'Version of o3 optimized for software engineering',
    hasThinking: true,
    supportsVision: true,
  },
  'codex-mini-latest': {
    id: 'codex-mini-latest',
    label: 'Codex-Mini-Latest',
    description: 'Version of o4-mini for Codex, optimized for faster workflows',
    hasThinking: false,
    supportsVision: true,
  },
  'gpt-5': {
    id: 'gpt-5',
    label: 'GPT-5',
    description: 'GPT-5 base flagship model',
    hasThinking: true,
    supportsVision: true,
  },
};

/**
 * Helper: Check if model has thinking capability
 */
export function codexModelHasThinking(modelId: CodexModelId): boolean {
  return CODEX_MODEL_CONFIG_MAP[modelId]?.hasThinking ?? false;
}

/**
 * Helper: Get display name for model
 */
export function getCodexModelLabel(modelId: CodexModelId): string {
  return CODEX_MODEL_CONFIG_MAP[modelId]?.label ?? modelId;
}

/**
 * Helper: Get all Codex model IDs
 */
export function getAllCodexModelIds(): CodexModelId[] {
  return Object.keys(CODEX_MODEL_CONFIG_MAP) as CodexModelId[];
}

/**
 * Helper: Check if Codex model supports vision
 */
export function codexModelSupportsVision(modelId: CodexModelId): boolean {
  return CODEX_MODEL_CONFIG_MAP[modelId]?.supportsVision ?? true;
}
