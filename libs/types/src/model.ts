/**
 * Model alias mapping for Claude models
 */
export const CLAUDE_MODEL_MAP: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-5-20250929',
  opus: 'claude-opus-4-5-20251101',
} as const;

/**
 * Codex/OpenAI model identifiers
 * Based on OpenAI Codex CLI official models
 * See: https://developers.openai.com/codex/models/
 */
export const CODEX_MODEL_MAP = {
  // Codex-specific models
  /** Most advanced agentic coding model for complex software engineering (default for ChatGPT users) */
  gpt52Codex: 'gpt-5.2-codex',
  /** Purpose-built for Codex CLI with versatile tool use (default for CLI users) */
  gpt5Codex: 'gpt-5-codex',
  /** Faster workflows optimized for low-latency code Q&A and editing */
  gpt5CodexMini: 'gpt-5-codex-mini',
  /** Version of o3 optimized for software engineering */
  codex1: 'codex-1',
  /** Version of o4-mini for Codex, optimized for faster workflows */
  codexMiniLatest: 'codex-mini-latest',

  // Base GPT-5 model (also available in Codex)
  /** GPT-5 base flagship model */
  gpt5: 'gpt-5',
} as const;

export const CODEX_MODEL_IDS = Object.values(CODEX_MODEL_MAP);

/**
 * Models that support reasoning effort configuration
 * These models can use reasoning.effort parameter
 */
export const REASONING_CAPABLE_MODELS = new Set([
  CODEX_MODEL_MAP.gpt52Codex,
  CODEX_MODEL_MAP.gpt5Codex,
  CODEX_MODEL_MAP.gpt5,
  CODEX_MODEL_MAP.codex1, // o3-based model
]);

/**
 * Check if a model supports reasoning effort configuration
 */
export function supportsReasoningEffort(modelId: string): boolean {
  return REASONING_CAPABLE_MODELS.has(modelId as any);
}

/**
 * Get all Codex model IDs as an array
 */
export function getAllCodexModelIds(): CodexModelId[] {
  return CODEX_MODEL_IDS as CodexModelId[];
}

/**
 * Default models per provider
 */
export const DEFAULT_MODELS = {
  claude: 'claude-opus-4-5-20251101',
  cursor: 'auto', // Cursor's recommended default
  codex: CODEX_MODEL_MAP.gpt52Codex, // GPT-5.2-Codex is the most advanced agentic coding model
} as const;

export type ModelAlias = keyof typeof CLAUDE_MODEL_MAP;
export type CodexModelId = (typeof CODEX_MODEL_MAP)[keyof typeof CODEX_MODEL_MAP];

/**
 * AgentModel - Alias for ModelAlias for backward compatibility
 * Represents available models across providers
 */
export type AgentModel = ModelAlias | CodexModelId;
