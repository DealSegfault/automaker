import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Cpu } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CodexModelId } from '@automaker/types';
import { CODEX_MODEL_MAP } from '@automaker/types';
import { OpenAIIcon } from '@/components/ui/provider-icon';

interface CodexModelConfigurationProps {
  enabledCodexModels: CodexModelId[];
  codexDefaultModel: CodexModelId;
  isSaving: boolean;
  onDefaultModelChange: (model: CodexModelId) => void;
  onModelToggle: (model: CodexModelId, enabled: boolean) => void;
}

interface CodexModelInfo {
  id: CodexModelId;
  label: string;
  description: string;
}

const CODEX_MODEL_INFO: Record<CodexModelId, CodexModelInfo> = {
  'gpt-5.2-codex': {
    id: 'gpt-5.2-codex',
    label: 'GPT-5.2-Codex',
    description: 'Most advanced agentic coding model for complex software engineering',
  },
  'gpt-5-codex': {
    id: 'gpt-5-codex',
    label: 'GPT-5-Codex',
    description: 'Purpose-built for Codex CLI with versatile tool use',
  },
  'gpt-5-codex-mini': {
    id: 'gpt-5-codex-mini',
    label: 'GPT-5-Codex-Mini',
    description: 'Faster workflows optimized for low-latency code Q&A and editing',
  },
  'codex-1': {
    id: 'codex-1',
    label: 'Codex-1',
    description: 'Version of o3 optimized for software engineering',
  },
  'codex-mini-latest': {
    id: 'codex-mini-latest',
    label: 'Codex-Mini-Latest',
    description: 'Version of o4-mini for Codex, optimized for faster workflows',
  },
  'gpt-5': {
    id: 'gpt-5',
    label: 'GPT-5',
    description: 'GPT-5 base flagship model',
  },
};

export function CodexModelConfiguration({
  enabledCodexModels,
  codexDefaultModel,
  isSaving,
  onDefaultModelChange,
  onModelToggle,
}: CodexModelConfigurationProps) {
  const availableModels = Object.values(CODEX_MODEL_INFO);

  return (
    <div
      className={cn(
        'rounded-2xl overflow-hidden',
        'border border-border/50',
        'bg-gradient-to-br from-card/90 via-card/70 to-card/80 backdrop-blur-xl',
        'shadow-sm shadow-black/5'
      )}
    >
      <div className="p-6 border-b border-border/50 bg-gradient-to-r from-transparent via-accent/5 to-transparent">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand-500/20 to-brand-600/10 flex items-center justify-center border border-brand-500/20">
            <OpenAIIcon className="w-5 h-5 text-brand-500" />
          </div>
          <h2 className="text-lg font-semibold text-foreground tracking-tight">
            Model Configuration
          </h2>
        </div>
        <p className="text-sm text-muted-foreground/80 ml-12">
          Configure which Codex models are available in the feature modal
        </p>
      </div>
      <div className="p-6 space-y-6">
        <div className="space-y-2">
          <Label>Default Model</Label>
          <Select
            value={codexDefaultModel}
            onValueChange={(v) => onDefaultModelChange(v as CodexModelId)}
            disabled={isSaving}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availableModels.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  <div className="flex items-center gap-2">
                    <span>{model.label}</span>
                    {supportsReasoningEffort(model.id) && (
                      <Badge variant="outline" className="text-xs">
                        Thinking
                      </Badge>
                    )}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-3">
          <Label>Available Models</Label>
          <div className="grid gap-3">
            {availableModels.map((model) => {
              const isEnabled = enabledCodexModels.includes(model.id);
              const isDefault = model.id === codexDefaultModel;

              return (
                <div
                  key={model.id}
                  className="flex items-center justify-between p-3 rounded-xl border border-border/50 bg-card/50 hover:bg-accent/30 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <Checkbox
                      checked={isEnabled}
                      onCheckedChange={(checked) => onModelToggle(model.id, !!checked)}
                      disabled={isSaving || isDefault}
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{model.label}</span>
                        {supportsReasoningEffort(model.id) && (
                          <Badge variant="outline" className="text-xs">
                            Thinking
                          </Badge>
                        )}
                        {isDefault && (
                          <Badge variant="secondary" className="text-xs">
                            Default
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{model.description}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function getModelDisplayName(modelId: string): string {
  const displayNames: Record<string, string> = {
    'gpt-5.2-codex': 'GPT-5.2-Codex',
    'gpt-5-codex': 'GPT-5-Codex',
    'gpt-5-codex-mini': 'GPT-5-Codex-Mini',
    'codex-1': 'Codex-1',
    'codex-mini-latest': 'Codex-Mini-Latest',
    'gpt-5': 'GPT-5',
  };
  return displayNames[modelId] || modelId;
}

function supportsReasoningEffort(modelId: string): boolean {
  const reasoningModels = ['gpt-5.2-codex', 'gpt-5-codex', 'gpt-5', 'codex-1'];
  return reasoningModels.includes(modelId);
}
