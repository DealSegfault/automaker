# Feature List Protection Strategy

## Problem

The `.automaker/feature_list.json` file is the single source of truth for all project features and their status. If an AI agent accidentally clears or corrupts this file, it results in catastrophic data loss - potentially erasing hours or days of planning work.

**Incident:** An agent attempted to update the feature list and completely cleared it out, leaving only `[]`.

## Solution: Multi-Layered Protection

We've implemented a defense-in-depth strategy with multiple layers of protection to prevent this from ever happening again.

---

## Layer 1: Explicit Prompt-Level Warnings

### Location
All agent system prompts now include prominent warnings at the top:

- `app/electron/services/prompt-builder.js`:
  - `getCodingPrompt()` - Used by feature implementation agents
  - `getVerificationPrompt()` - Used by verification agents
- `app/electron/agent-service.js`:
  - `getSystemPrompt()` - Used by the general chat agent
- `.automaker/initializer_prompt.md` - Used by the initialization agent

### Content
Each prompt now starts with:

```
🚨 CRITICAL FILE PROTECTION - READ THIS FIRST 🚨

THE FOLLOWING FILE IS ABSOLUTELY FORBIDDEN FROM DIRECT MODIFICATION:
- .automaker/feature_list.json

YOU MUST NEVER:
- Use the Write tool on feature_list.json
- Use the Edit tool on feature_list.json
- Use any Bash command that writes to feature_list.json (echo, sed, awk, etc.)
- Attempt to read and rewrite feature_list.json
- UNDER ANY CIRCUMSTANCES touch this file directly

CATASTROPHIC CONSEQUENCES:
Directly modifying feature_list.json can:
- Erase all project features permanently
- Corrupt the project state beyond recovery
- Destroy hours/days of planning work
- This is a FIREABLE OFFENSE - you will be terminated if you do this

THE ONLY WAY to update features:
Use the mcp__automaker-tools__UpdateFeatureStatus tool with featureId, status, and summary parameters.
```

### Why This Works
- Uses attention-grabbing emoji and formatting
- Places warnings at the very top of prompts (high visibility)
- Uses strong language ("CATASTROPHIC", "FIREABLE OFFENSE")
- Explicitly lists all forbidden actions
- Provides the correct alternative (UpdateFeatureStatus tool)

---

## Layer 2: Dedicated MCP Tool

### Location
`app/electron/services/mcp-server-factory.js`

### How It Works
The `UpdateFeatureStatus` tool provides a safe, controlled interface for updating features:

```javascript
tool(
  "UpdateFeatureStatus",
  "Update the status of a feature in the feature list. Use this tool instead of directly modifying feature_list.json...",
  {
    featureId: z.string(),
    status: z.enum(["backlog", "in_progress", "verified"]),
    summary: z.string().optional()
  },
  async (args) => {
    // Calls featureLoader.updateFeatureStatus with validation
  }
)
```

### Why This Works
- Provides a single, well-defined API for status updates
- Only accepts specific, validated parameters
- Cannot be misused to clear the entire file
- Tool description explicitly states it should be used instead of direct edits

---

## Layer 3: File-Level Validation & Auto-Backup

### Location
`app/electron/services/feature-loader.js` - `updateFeatureStatus()` method

### Protection Mechanisms

#### 3.1 Automatic Backup Before Every Write
```javascript
// Create .automaker/feature_list.backup.json before any modification
const backupPath = path.join(projectPath, ".automaker", "feature_list.backup.json");
await fs.writeFile(backupPath, originalContent, "utf-8");
```

**Benefit:** If corruption occurs, we can manually restore from the backup.

#### 3.2 Array Validation
```javascript
if (!Array.isArray(features)) {
  throw new Error("CRITICAL: features is not an array - aborting to prevent data loss");
}
```

**Benefit:** Prevents writing if the loaded data is corrupted.

#### 3.3 Empty Array Detection & Auto-Restore
```javascript
if (features.length === 0) {
  console.warn("WARNING: Feature list is empty. This may indicate corruption.");
  // Try to restore from backup
  const backupFeatures = JSON.parse(await fs.readFile(backupPath, "utf-8"));
  if (Array.isArray(backupFeatures) && backupFeatures.length > 0) {
    features.push(...backupFeatures);
  }
}
```

**Benefit:** If the file is somehow cleared, the tool automatically attempts to restore from backup.

#### 3.4 Pre-Write Validation
```javascript
if (!Array.isArray(toSave) || toSave.length === 0) {
  throw new Error("CRITICAL: Attempted to save empty feature list - aborting to prevent data loss");
}
```

**Benefit:** Final safety check - will never write an empty array to the file.

#### 3.5 Backup File Ignored by Git
Created `.automaker/.gitignore`:
```
feature_list.backup.json
```

**Benefit:** Backup files don't clutter the git repository.

---

## Layer 4: Tool Access Control

### Location
`app/electron/services/feature-executor.js` and `feature-verifier.js`

### Allowed Tools
The agents only have access to these tools:
```javascript
allowedTools: [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "WebSearch",
  "WebFetch",
  "mcp__automaker-tools__UpdateFeatureStatus",
]
```

### Future Enhancement Opportunity
We could create a custom wrapper around Write/Edit that blocks access to specific files:
```javascript
// Potential future enhancement
if (filePath.includes('feature_list.json')) {
  throw new Error('BLOCKED: feature_list.json can only be updated via UpdateFeatureStatus tool');
}
```

---

## Testing the Protection

To verify the protection works:

1. **Prompt-Level Protection Test:**
   - Ask an agent to update feature_list.json directly
   - Agent should refuse and explain it must use UpdateFeatureStatus tool

2. **Tool Protection Test:**
   - Use UpdateFeatureStatus with valid data
   - Verify backup is created in `.automaker/feature_list.backup.json`
   - Verify feature is updated correctly

3. **Corruption Recovery Test:**
   - Manually corrupt feature_list.json (e.g., set to `[]`)
   - Call UpdateFeatureStatus
   - Verify it auto-restores from backup

4. **Empty Array Prevention Test:**
   - Attempt to save empty array programmatically
   - Verify the error is thrown and file is not written

---

## Recovery Procedures

### If feature_list.json Gets Cleared

1. **Immediate Recovery:**
   ```bash
   cd .automaker
   cp feature_list.backup.json feature_list.json
   ```

2. **Check Git History:**
   ```bash
   git log --all --full-history -- .automaker/feature_list.json
   git show <commit>:.automaker/feature_list.json > .automaker/feature_list.json
   ```

3. **Verify Recovery:**
   ```bash
   cat .automaker/feature_list.json | jq length
   # Should show number of features, not 0
   ```

---

## Summary

We now have **four layers of protection**:

1. ✅ **Explicit prompt warnings** - Agents are told in strong language never to touch the file
2. ✅ **Dedicated MCP tool** - UpdateFeatureStatus provides the only safe way to update
3. ✅ **File validation & auto-backup** - Automatic backups and validation prevent corruption
4. ✅ **Tool access control** - Agents have limited tool access (could be enhanced further)

This defense-in-depth approach ensures that even if one layer fails, others will prevent data loss.

---

## Files Modified

1. `app/electron/services/prompt-builder.js` - Added protection warnings to getCodingPrompt() and getVerificationPrompt()
2. `app/electron/agent-service.js` - Added protection warnings to getSystemPrompt()
3. `.automaker/initializer_prompt.md` - Added warning for initializer agent
4. `app/electron/services/feature-loader.js` - Added backup, validation, and auto-restore logic
5. `.automaker/.gitignore` - Added backup file ignore rule
6. `FEATURE_LIST_PROTECTION.md` - This documentation file
