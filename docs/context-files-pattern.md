# Context Files System

This document describes how context files work in Automaker and how to use them in agent prompts.

## Overview

Context files are user-defined documents stored in `.automaker/context/` that provide project-specific rules, conventions, and guidelines for AI agents. They are automatically loaded and prepended to agent prompts.

## Directory Structure

```
{projectPath}/.automaker/context/
├── CLAUDE.md              # Project rules and conventions
├── CODE_QUALITY.md        # Code quality guidelines
├── context-metadata.json  # File descriptions
└── ... (any .md or .txt files)
```

Memory files are stored separately:

```
{projectPath}/.automaker/memory/
├── gotchas.md                   # High-priority pitfalls
├── ... (other .md memory files)
└── architectural-memory.json    # Structured decisions & patterns
```

## Metadata

File descriptions are stored in `context-metadata.json`:

```json
{
  "files": {
    "CLAUDE.md": {
      "description": "Project-specific rules including package manager, commit conventions, and architectural patterns"
    },
    "CODE_QUALITY.md": {
      "description": "Code quality standards, testing requirements, and linting rules"
    }
  }
}
```

## Shared Utility

The `loadContextFiles` function from `@automaker/utils` provides a unified way to load context files:

```typescript
import { loadContextFiles } from '@automaker/utils';

// Load context files from a project
const { formattedPrompt, files } = await loadContextFiles({
  projectPath: '/path/to/project',
  // Optional: inject custom fs module for secure operations
  fsModule: secureFs,
});

// formattedPrompt contains the formatted system prompt
// files contains metadata about each loaded file
```

### Return Value

```typescript
interface ContextFilesResult {
  files: ContextFileInfo[]; // Individual file info
  memoryFiles: MemoryFileInfo[]; // Selected memory file info
  architecturalMemory?: ArchitecturalMemory; // Structured architectural memory
  formattedPrompt: string; // Formatted prompt ready to use
}

interface ContextFileInfo {
  name: string; // File name (e.g., "CLAUDE.md")
  path: string; // Full path to file
  content: string; // File contents
  description?: string; // From metadata (explains when/why to use)
}

interface MemoryFileInfo {
  name: string; // File name (e.g., "gotchas.md")
  path: string; // Full path to file
  content: string; // File contents
  category: string; // Category derived from file name
}

interface ArchitecturalMemory {
  version: number;
  decisions: Record<string, ArchitecturalDecision>;
  rejectedApproaches: Record<string, RejectedApproach>;
  patterns: CodePattern[];
  testStrategy?: TestingStrategy;
  updatedAt: string;
}
```

## Usage in Services

### Auto-Mode Service (Feature Execution)

```typescript
import { loadContextFiles } from '@automaker/utils';
import * as secureFs from '../lib/secure-fs.js';

// In executeFeature() or followUpFeature()
const { formattedPrompt: contextFilesPrompt } = await loadContextFiles({
  projectPath,
  fsModule: secureFs as Parameters<typeof loadContextFiles>[0]['fsModule'],
});

// Pass as system prompt
await this.runAgent(workDir, featureId, prompt, abortController, projectPath, imagePaths, model, {
  projectPath,
  systemPrompt: contextFilesPrompt || undefined,
});
```

### Agent Service (Chat Sessions)

```typescript
import { loadContextFiles } from '@automaker/utils';
import * as secureFs from '../lib/secure-fs.js';

// In sendMessage()
const { formattedPrompt: contextFilesPrompt } = await loadContextFiles({
  projectPath: effectiveWorkDir,
  fsModule: secureFs as Parameters<typeof loadContextFiles>[0]['fsModule'],
});

// Combine with base system prompt
const combinedSystemPrompt = contextFilesPrompt
  ? `${contextFilesPrompt}\n\n${baseSystemPrompt}`
  : baseSystemPrompt;
```

## Formatted Prompt Structure

The formatted prompt includes:

1. **Header** - Emphasizes that these are project-specific rules
2. **File Entries** - Each file with:
   - File name
   - Full path (for agents to read more if needed)
   - Purpose/description (from metadata)
   - Full file content
3. **Memory** - Selected learnings and decisions from `.automaker/memory/`
4. **Architectural Memory** - Structured decisions/patterns from `architectural-memory.json`
5. **Reminder** - Reinforces that agents must follow the conventions

Example output:

```markdown
# Project Context Files

The following context files provide project-specific rules, conventions, and guidelines.
Each file serves a specific purpose - use the description to understand when to reference it.
If you need more details about a context file, you can read the full file at the path provided.

**IMPORTANT**: You MUST follow the rules and conventions specified in these files.

- Follow ALL commands exactly as shown (e.g., if the project uses `pnpm`, NEVER use `npm` or `npx`)
- Follow ALL coding conventions, commit message formats, and architectural patterns specified
- Reference these rules before running ANY shell commands or making commits

---

## CLAUDE.md

**Path:** `/path/to/project/.automaker/context/CLAUDE.md`
**Purpose:** Project-specific rules including package manager, commit conventions, and architectural patterns

[File content here]

---

## CODE_QUALITY.md

**Path:** `/path/to/project/.automaker/context/CODE_QUALITY.md`
**Purpose:** Code quality standards, testing requirements, and linting rules

[File content here]

---

**REMINDER**: Before taking any action, verify you are following the conventions specified above.
```

## Best Practices

1. **Add descriptions** - Always add descriptions to `context-metadata.json` so agents understand when to reference each file
2. **Be specific** - Context files should contain concrete rules, not general guidelines
3. **Include examples** - Show correct command usage, commit formats, etc.
4. **Keep focused** - Each file should have a single purpose

## File Locations

- **Shared Utility**: `libs/utils/src/context-loader.ts`
- **Auto-Mode Service**: `apps/server/src/services/auto-mode-service.ts`
- **Agent Service**: `apps/server/src/services/agent-service.ts`
