/**
 * Architectural Memory - Persistent, structured record of key decisions and patterns.
 */

import path from 'path';
import type {
  ArchitecturalMemory,
  ArchitecturalDecision,
  RejectedApproach,
  CodePattern,
  TestingStrategy,
} from '@automaker/types';
import { getMemoryDir, type MemoryFsModule } from './memory-loader.js';

const ARCHITECTURAL_MEMORY_FILE = 'architectural-memory.json';
const ARCHITECTURAL_MEMORY_VERSION = 1;

export function getArchitecturalMemoryPath(projectPath: string): string {
  return path.join(getMemoryDir(projectPath), ARCHITECTURAL_MEMORY_FILE);
}

export function createEmptyArchitecturalMemory(): ArchitecturalMemory {
  return {
    version: ARCHITECTURAL_MEMORY_VERSION,
    decisions: {},
    rejectedApproaches: {},
    patterns: [],
    testStrategy: undefined,
    updatedAt: new Date().toISOString(),
  };
}

export async function loadArchitecturalMemory(
  projectPath: string,
  fsModule: MemoryFsModule
): Promise<ArchitecturalMemory> {
  const filePath = getArchitecturalMemoryPath(projectPath);

  try {
    const content = (await fsModule.readFile(filePath, 'utf-8')) as string;
    const parsed = JSON.parse(content) as ArchitecturalMemory;
    return {
      ...createEmptyArchitecturalMemory(),
      ...parsed,
      decisions: parsed.decisions || {},
      rejectedApproaches: parsed.rejectedApproaches || {},
      patterns: parsed.patterns || [],
    };
  } catch {
    const empty = createEmptyArchitecturalMemory();
    await fsModule.mkdir(path.dirname(filePath), { recursive: true });
    await fsModule.writeFile(filePath, JSON.stringify(empty, null, 2));
    return empty;
  }
}

export async function writeArchitecturalMemory(
  projectPath: string,
  memory: ArchitecturalMemory,
  fsModule: MemoryFsModule
): Promise<void> {
  const filePath = getArchitecturalMemoryPath(projectPath);
  await fsModule.mkdir(path.dirname(filePath), { recursive: true });
  await fsModule.writeFile(filePath, JSON.stringify(memory, null, 2));
}

export async function updateArchitecturalMemory(
  projectPath: string,
  updater: (memory: ArchitecturalMemory) => ArchitecturalMemory,
  fsModule: MemoryFsModule
): Promise<ArchitecturalMemory> {
  const current = await loadArchitecturalMemory(projectPath, fsModule);
  const updated = updater(current);
  updated.updatedAt = new Date().toISOString();
  await writeArchitecturalMemory(projectPath, updated, fsModule);
  return updated;
}

export function formatArchitecturalMemory(memory: ArchitecturalMemory): string {
  const decisionEntries = Object.values(memory.decisions);
  const rejectedEntries = Object.values(memory.rejectedApproaches);

  const decisions =
    decisionEntries.length === 0
      ? 'None recorded.'
      : decisionEntries
          .map(
            (decision: ArchitecturalDecision) =>
              `- ${decision.decision} (${decision.timestamp})\n  - Rationale: ${decision.rationale}${
                decision.relatedFeatures?.length
                  ? `\n  - Related features: ${decision.relatedFeatures.join(', ')}`
                  : ''
              }`
          )
          .join('\n');

  const rejected =
    rejectedEntries.length === 0
      ? 'None recorded.'
      : rejectedEntries
          .map(
            (entry: RejectedApproach) =>
              `- ${entry.approach} (${entry.timestamp})\n  - Reason: ${entry.reason}${
                entry.relatedFeatures?.length
                  ? `\n  - Related features: ${entry.relatedFeatures.join(', ')}`
                  : ''
              }`
          )
          .join('\n');

  const patterns =
    memory.patterns.length === 0
      ? 'None recorded.'
      : memory.patterns
          .map((pattern: CodePattern) => {
            const details = [
              `- ${pattern.name}: ${pattern.description}`,
              pattern.rationale ? `  - Rationale: ${pattern.rationale}` : '',
              pattern.examples && pattern.examples.length > 0
                ? `  - Examples: ${pattern.examples.join(', ')}`
                : '',
            ]
              .filter(Boolean)
              .join('\n');
            return details;
          })
          .join('\n');

  const testStrategy = memory.testStrategy
    ? `Approach: ${memory.testStrategy.approach}${
        memory.testStrategy.tools?.length ? `\nTools: ${memory.testStrategy.tools.join(', ')}` : ''
      }${memory.testStrategy.notes ? `\nNotes: ${memory.testStrategy.notes}` : ''}`
    : 'None recorded.';

  return `# Architectural Memory

The following architectural decisions, rejected approaches, and patterns guide implementation.
Use these to avoid drift and to maintain consistency with past choices.

## Decisions
${decisions}

## Rejected Approaches
${rejected}

## Patterns
${patterns}

## Test Strategy
${testStrategy}
`;
}
