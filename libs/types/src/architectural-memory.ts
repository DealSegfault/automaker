/**
 * Architectural memory structures for persistent decisions and patterns.
 */

export interface ArchitecturalDecision {
  decision: string;
  rationale: string;
  timestamp: string;
  relatedFeatures: string[];
}

export interface RejectedApproach {
  approach: string;
  reason: string;
  timestamp: string;
  relatedFeatures: string[];
}

export interface CodePattern {
  name: string;
  description: string;
  rationale?: string;
  examples?: string[];
}

export interface TestingStrategy {
  approach: string;
  tools?: string[];
  notes?: string;
}

export interface ArchitecturalMemory {
  version: number;
  decisions: Record<string, ArchitecturalDecision>;
  rejectedApproaches: Record<string, RejectedApproach>;
  patterns: CodePattern[];
  testStrategy?: TestingStrategy;
  updatedAt: string;
}
