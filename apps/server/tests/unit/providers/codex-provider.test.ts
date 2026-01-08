import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import { CodexProvider } from '../../../src/providers/codex-provider.js';
import type { ProviderMessage } from '../../../src/providers/types.js';
import { collectAsyncGenerator } from '../../utils/helpers.js';
import {
  spawnJSONLProcess,
  findCodexCliPath,
  secureFs,
  getCodexConfigDir,
  getCodexAuthIndicators,
} from '@automaker/platform';

const OPENAI_API_KEY_ENV = 'OPENAI_API_KEY';
const originalOpenAIKey = process.env[OPENAI_API_KEY_ENV];

const codexRunMock = vi.fn();

vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(_opts: { apiKey: string }) {}
    startThread() {
      return {
        id: 'thread-123',
        run: codexRunMock,
      };
    }
    resumeThread() {
      return {
        id: 'thread-123',
        run: codexRunMock,
      };
    }
  },
}));

const EXEC_SUBCOMMAND = 'exec';

vi.mock('@automaker/platform', () => ({
  spawnJSONLProcess: vi.fn(),
  spawnProcess: vi.fn(),
  findCodexCliPath: vi.fn(),
  getCodexAuthIndicators: vi.fn().mockResolvedValue({
    hasAuthFile: false,
    hasOAuthToken: false,
    hasApiKey: false,
  }),
  getCodexConfigDir: vi.fn().mockReturnValue('/home/test/.codex'),
  secureFs: {
    readFile: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
  },
  getDataDirectory: vi.fn(),
}));

vi.mock('@/services/settings-service.js', () => ({
  SettingsService: class {
    async getGlobalSettings() {
      return {
        codexAutoLoadAgents: false,
        codexSandboxMode: 'workspace-write',
        codexApprovalPolicy: 'on-request',
      };
    }
  },
}));

describe('codex-provider.ts', () => {
  let provider: CodexProvider;

  afterAll(() => {
    if (originalOpenAIKey !== undefined) {
      process.env[OPENAI_API_KEY_ENV] = originalOpenAIKey;
    } else {
      delete process.env[OPENAI_API_KEY_ENV];
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCodexConfigDir).mockReturnValue('/home/test/.codex');
    vi.mocked(findCodexCliPath).mockResolvedValue('/usr/bin/codex');
    vi.mocked(getCodexAuthIndicators).mockResolvedValue({
      hasAuthFile: true,
      hasOAuthToken: true,
      hasApiKey: false,
    });
    delete process.env[OPENAI_API_KEY_ENV];
    provider = new CodexProvider();
  });

  describe('executeQuery', () => {
    it('emits tool_use and tool_result with shared tool_use_id for command execution', async () => {
      const mockEvents = [
        {
          type: 'item.started',
          item: {
            type: 'command_execution',
            id: 'cmd-1',
            command: 'ls',
          },
        },
        {
          type: 'item.completed',
          item: {
            type: 'command_execution',
            id: 'cmd-1',
            output: 'file1\nfile2',
          },
        },
      ];

      vi.mocked(spawnJSONLProcess).mockReturnValue(
        (async function* () {
          for (const event of mockEvents) {
            yield event;
          }
        })()
      );
      const results = await collectAsyncGenerator<ProviderMessage>(
        provider.executeQuery({
          prompt: 'List files',
          model: 'gpt-5.2',
          cwd: '/tmp',
        })
      );

      expect(results).toHaveLength(2);
      const toolUse = results[0];
      const toolResult = results[1];

      expect(toolUse.type).toBe('assistant');
      expect(toolUse.message?.content[0].type).toBe('tool_use');
      const toolUseId = toolUse.message?.content[0].tool_use_id;
      expect(toolUseId).toBeDefined();

      expect(toolResult.type).toBe('assistant');
      expect(toolResult.message?.content[0].type).toBe('tool_result');
      expect(toolResult.message?.content[0].tool_use_id).toBe(toolUseId);
      expect(toolResult.message?.content[0].content).toBe('file1\nfile2');
    });

    it('adds output schema and max turn overrides when configured', async () => {
      vi.mocked(spawnJSONLProcess).mockReturnValue((async function* () {})());

      const schema = { type: 'object', properties: { ok: { type: 'string' } } };
      await collectAsyncGenerator(
        provider.executeQuery({
          prompt: 'Return JSON',
          model: 'gpt-5.2',
          cwd: '/tmp',
          maxTurns: 5,
          allowedTools: ['Read'],
          outputFormat: { type: 'json_schema', schema },
        })
      );

      const call = vi.mocked(spawnJSONLProcess).mock.calls[0][0];
      expect(call.args).toContain('--output-schema');
      const schemaIndex = call.args.indexOf('--output-schema');
      const schemaPath = call.args[schemaIndex + 1];
      expect(schemaPath).toBe(path.join('/tmp', '.codex', 'output-schema.json'));
      expect(secureFs.writeFile).toHaveBeenCalledWith(
        schemaPath,
        JSON.stringify(schema, null, 2),
        'utf-8'
      );
      expect(call.args).toContain('--config');
      expect(call.args).toContain('max_turns=5');
      expect(call.args).not.toContain('--search');
    });

    it('overrides approval policy when MCP auto-approval is enabled', async () => {
      vi.mocked(spawnJSONLProcess).mockReturnValue((async function* () {})());

      await collectAsyncGenerator(
        provider.executeQuery({
          prompt: 'Test approvals',
          model: 'gpt-5.2',
          cwd: '/tmp',
          mcpServers: { mock: { type: 'stdio', command: 'node' } },
          mcpAutoApproveTools: true,
          codexSettings: { approvalPolicy: 'untrusted' },
        })
      );

      const call = vi.mocked(spawnJSONLProcess).mock.calls[0][0];
      const approvalConfigIndex = call.args.indexOf('--config');
      const execIndex = call.args.indexOf(EXEC_SUBCOMMAND);
      const searchConfigIndex = call.args.indexOf('--config');
      expect(call.args[approvalConfigIndex + 1]).toBe('approval_policy=never');
      expect(approvalConfigIndex).toBeGreaterThan(-1);
      expect(execIndex).toBeGreaterThan(-1);
      expect(approvalConfigIndex).toBeGreaterThan(execIndex);
      // Search should be in config, not as direct flag
      const hasSearchConfig = call.args.some(
        (arg, index) =>
          arg === '--config' && call.args[index + 1] === 'features.web_search_request=true'
      );
      expect(hasSearchConfig).toBe(true);
    });

    it('injects user and project instructions when auto-load is enabled', async () => {
      vi.mocked(spawnJSONLProcess).mockReturnValue((async function* () {})());

      const userPath = path.join('/home/test/.codex', 'AGENTS.md');
      const projectPath = path.join('/tmp/project', '.codex', 'AGENTS.md');
      vi.mocked(secureFs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath === userPath) {
          return 'User rules';
        }
        if (filePath === projectPath) {
          return 'Project rules';
        }
        throw new Error('missing');
      });

      await collectAsyncGenerator(
        provider.executeQuery({
          prompt: 'Hello',
          model: 'gpt-5.2',
          cwd: '/tmp/project',
          codexSettings: { autoLoadAgents: true },
        })
      );

      const call = vi.mocked(spawnJSONLProcess).mock.calls[0][0];
      const promptText = call.stdinData;
      expect(promptText).toContain('User rules');
      expect(promptText).toContain('Project rules');
    });

    it('disables sandbox mode when running in cloud storage paths', async () => {
      vi.mocked(spawnJSONLProcess).mockReturnValue((async function* () {})());

      const cloudPath = path.join(os.homedir(), 'Dropbox', 'project');
      await collectAsyncGenerator(
        provider.executeQuery({
          prompt: 'Hello',
          model: 'gpt-5.2',
          cwd: cloudPath,
          codexSettings: { sandboxMode: 'workspace-write' },
        })
      );

      const call = vi.mocked(spawnJSONLProcess).mock.calls[0][0];
      const sandboxIndex = call.args.indexOf('--sandbox');
      expect(call.args[sandboxIndex + 1]).toBe('danger-full-access');
    });

    it('uses the SDK when no tools are requested and an API key is present', async () => {
      process.env[OPENAI_API_KEY_ENV] = 'sk-test';
      codexRunMock.mockResolvedValue({ finalResponse: 'Hello from SDK' });

      const results = await collectAsyncGenerator<ProviderMessage>(
        provider.executeQuery({
          prompt: 'Hello',
          model: 'gpt-5.2',
          cwd: '/tmp',
          allowedTools: [],
        })
      );

      expect(results[0].message?.content[0].text).toBe('Hello from SDK');
      expect(results[1].result).toBe('Hello from SDK');
    });

    it('uses the CLI when tools are requested even if an API key is present', async () => {
      process.env[OPENAI_API_KEY_ENV] = 'sk-test';
      vi.mocked(spawnJSONLProcess).mockReturnValue((async function* () {})());

      await collectAsyncGenerator(
        provider.executeQuery({
          prompt: 'Read files',
          model: 'gpt-5.2',
          cwd: '/tmp',
          allowedTools: ['Read'],
        })
      );

      expect(codexRunMock).not.toHaveBeenCalled();
      expect(spawnJSONLProcess).toHaveBeenCalled();
    });

    it('falls back to CLI when no tools are requested and no API key is available', async () => {
      vi.mocked(spawnJSONLProcess).mockReturnValue((async function* () {})());

      await collectAsyncGenerator(
        provider.executeQuery({
          prompt: 'Hello',
          model: 'gpt-5.2',
          cwd: '/tmp',
          allowedTools: [],
        })
      );

      expect(codexRunMock).not.toHaveBeenCalled();
      expect(spawnJSONLProcess).toHaveBeenCalled();
    });
  });
});
