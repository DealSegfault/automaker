"use client";

import { useState, useEffect } from "react";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Settings,
  Key,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Zap,
  Sun,
  Moon,
  Palette,
  Terminal,
  Ghost,
  Snowflake,
  Flame,
  Sparkles,
  Eclipse,
  Trees,
  Cat,
  Atom,
  Radio,
  LayoutGrid,
  Minimize2,
  Square,
  Maximize2,
  FlaskConical,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";

export function SettingsView() {
  const {
    apiKeys,
    setApiKeys,
    setCurrentView,
    theme,
    setTheme,
    kanbanCardDetailLevel,
    setKanbanCardDetailLevel,
    defaultSkipTests,
    setDefaultSkipTests,
  } = useAppStore();
  const [anthropicKey, setAnthropicKey] = useState(apiKeys.anthropic);
  const [googleKey, setGoogleKey] = useState(apiKeys.google);
  const [showAnthropicKey, setShowAnthropicKey] = useState(false);
  const [showGoogleKey, setShowGoogleKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [testingGeminiConnection, setTestingGeminiConnection] = useState(false);
  const [geminiTestResult, setGeminiTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    setAnthropicKey(apiKeys.anthropic);
    setGoogleKey(apiKeys.google);
  }, [apiKeys]);

  const handleTestConnection = async () => {
    setTestingConnection(true);
    setTestResult(null);

    try {
      const response = await fetch("/api/claude/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ apiKey: anthropicKey }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setTestResult({
          success: true,
          message: data.message || "Connection successful! Claude responded.",
        });
      } else {
        setTestResult({
          success: false,
          message: data.error || "Failed to connect to Claude API.",
        });
      }
    } catch (error) {
      setTestResult({
        success: false,
        message: "Network error. Please check your connection.",
      });
    } finally {
      setTestingConnection(false);
    }
  };

  const handleTestGeminiConnection = async () => {
    setTestingGeminiConnection(true);
    setGeminiTestResult(null);

    try {
      const response = await fetch("/api/gemini/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ apiKey: googleKey }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setGeminiTestResult({
          success: true,
          message: data.message || "Connection successful! Gemini responded.",
        });
      } else {
        setGeminiTestResult({
          success: false,
          message: data.error || "Failed to connect to Gemini API.",
        });
      }
    } catch (error) {
      setGeminiTestResult({
        success: false,
        message: "Network error. Please check your connection.",
      });
    } finally {
      setTestingGeminiConnection(false);
    }
  };

  const handleSave = () => {
    setApiKeys({
      anthropic: anthropicKey,
      google: googleKey,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden content-bg"
      data-testid="settings-view"
    >
      {/* Header Section */}
      <div className="shrink-0 border-b border-border bg-glass backdrop-blur-md">
        <div className="px-8 py-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-linear-to-br from-brand-500 to-brand-600 shadow-lg shadow-brand-500/20 flex items-center justify-center">
              <Settings className="w-5 h-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Settings</h1>
              <p className="text-sm text-muted-foreground">
                Configure your API keys and preferences
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* API Keys Section */}
          <div className="rounded-xl border border-border bg-card backdrop-blur-md overflow-hidden">
            <div className="p-6 border-b border-border">
              <div className="flex items-center gap-2 mb-2">
                <Key className="w-5 h-5 text-brand-500" />
                <h2 className="text-lg font-semibold text-foreground">
                  API Keys
                </h2>
              </div>
              <p className="text-sm text-muted-foreground">
                Configure your AI provider API keys. Keys are stored locally in
                your browser.
              </p>
            </div>
            <div className="p-6 space-y-6">
              {/* Claude/Anthropic API Key */}
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Label htmlFor="anthropic-key" className="text-foreground">
                    Anthropic API Key (Claude)
                  </Label>
                  {apiKeys.anthropic && (
                    <CheckCircle2 className="w-4 h-4 text-brand-500" />
                  )}
                </div>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      id="anthropic-key"
                      type={showAnthropicKey ? "text" : "password"}
                      value={anthropicKey}
                      onChange={(e) => setAnthropicKey(e.target.value)}
                      placeholder="sk-ant-..."
                      className="pr-10 bg-input border-border text-foreground placeholder:text-muted-foreground"
                      data-testid="anthropic-api-key-input"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-0 top-0 h-full px-3 text-muted-foreground hover:text-foreground hover:bg-transparent"
                      onClick={() => setShowAnthropicKey(!showAnthropicKey)}
                      data-testid="toggle-anthropic-visibility"
                    >
                      {showAnthropicKey ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleTestConnection}
                    disabled={!anthropicKey || testingConnection}
                    className="bg-secondary hover:bg-accent text-secondary-foreground border border-border"
                    data-testid="test-claude-connection"
                  >
                    {testingConnection ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Testing...
                      </>
                    ) : (
                      <>
                        <Zap className="w-4 h-4 mr-2" />
                        Test
                      </>
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Used for Claude AI features. Get your key at{" "}
                  <a
                    href="https://console.anthropic.com/account/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-500 hover:text-brand-400 hover:underline"
                  >
                    console.anthropic.com
                  </a>
                  . Alternatively, the CLAUDE_CODE_OAUTH_TOKEN environment
                  variable can be used.
                </p>
                {testResult && (
                  <div
                    className={`flex items-center gap-2 p-3 rounded-lg ${
                      testResult.success
                        ? "bg-green-500/10 border border-green-500/20 text-green-400"
                        : "bg-red-500/10 border border-red-500/20 text-red-400"
                    }`}
                    data-testid="test-connection-result"
                  >
                    {testResult.success ? (
                      <CheckCircle2 className="w-4 h-4" />
                    ) : (
                      <AlertCircle className="w-4 h-4" />
                    )}
                    <span
                      className="text-sm"
                      data-testid="test-connection-message"
                    >
                      {testResult.message}
                    </span>
                  </div>
                )}
              </div>

              {/* Google API Key */}
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Label htmlFor="google-key" className="text-foreground">
                    Google API Key (Gemini)
                  </Label>
                  {apiKeys.google && (
                    <CheckCircle2 className="w-4 h-4 text-brand-500" />
                  )}
                </div>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      id="google-key"
                      type={showGoogleKey ? "text" : "password"}
                      value={googleKey}
                      onChange={(e) => setGoogleKey(e.target.value)}
                      placeholder="AIza..."
                      className="pr-10 bg-input border-border text-foreground placeholder:text-muted-foreground"
                      data-testid="google-api-key-input"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-0 top-0 h-full px-3 text-muted-foreground hover:text-foreground hover:bg-transparent"
                      onClick={() => setShowGoogleKey(!showGoogleKey)}
                      data-testid="toggle-google-visibility"
                    >
                      {showGoogleKey ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleTestGeminiConnection}
                    disabled={!googleKey || testingGeminiConnection}
                    className="bg-secondary hover:bg-accent text-secondary-foreground border border-border"
                    data-testid="test-gemini-connection"
                  >
                    {testingGeminiConnection ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Testing...
                      </>
                    ) : (
                      <>
                        <Zap className="w-4 h-4 mr-2" />
                        Test
                      </>
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Used for Gemini AI features (including image/design prompts).
                  Get your key at{" "}
                  <a
                    href="https://makersuite.google.com/app/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-500 hover:text-brand-400 hover:underline"
                  >
                    makersuite.google.com
                  </a>
                </p>
                {geminiTestResult && (
                  <div
                    className={`flex items-center gap-2 p-3 rounded-lg ${
                      geminiTestResult.success
                        ? "bg-green-500/10 border border-green-500/20 text-green-400"
                        : "bg-red-500/10 border border-red-500/20 text-red-400"
                    }`}
                    data-testid="gemini-test-connection-result"
                  >
                    {geminiTestResult.success ? (
                      <CheckCircle2 className="w-4 h-4" />
                    ) : (
                      <AlertCircle className="w-4 h-4" />
                    )}
                    <span
                      className="text-sm"
                      data-testid="gemini-test-connection-message"
                    >
                      {geminiTestResult.message}
                    </span>
                  </div>
                )}
              </div>

              {/* Security Notice */}
              <div className="flex items-start gap-3 p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                <AlertCircle className="w-5 h-5 text-yellow-500 mt-0.5 shrink-0" />
                <div className="text-sm">
                  <p className="font-medium text-yellow-500">Security Notice</p>
                  <p className="text-yellow-500/80 text-xs mt-1">
                    API keys are stored in your browser's local storage. Never
                    share your API keys or commit them to version control.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Appearance Section */}
          <div className="rounded-xl border border-border bg-card backdrop-blur-md overflow-hidden">
            <div className="p-6 border-b border-border">
              <div className="flex items-center gap-2 mb-2">
                <Palette className="w-5 h-5 text-brand-500" />
                <h2 className="text-lg font-semibold text-foreground">
                  Appearance
                </h2>
              </div>
              <p className="text-sm text-muted-foreground">
                Customize the look and feel of your application.
              </p>
            </div>
            <div className="p-6 space-y-4">
              <div className="space-y-3">
                <Label className="text-foreground">Theme</Label>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <button
                    onClick={() => setTheme("dark")}
                    className={`flex items-center justify-center gap-2 px-3 py-3 rounded-lg border transition-all ${
                      theme === "dark"
                        ? "bg-accent border-brand-500 text-foreground"
                        : "bg-input border-border text-muted-foreground hover:text-foreground hover:bg-accent"
                    }`}
                    data-testid="dark-mode-button"
                  >
                    <Moon className="w-4 h-4" />
                    <span className="font-medium text-sm">Dark</span>
                  </button>
                  <button
                    onClick={() => setTheme("light")}
                    className={`flex items-center justify-center gap-2 px-3 py-3 rounded-lg border transition-all ${
                      theme === "light"
                        ? "bg-accent border-brand-500 text-foreground"
                        : "bg-input border-border text-muted-foreground hover:text-foreground hover:bg-accent"
                    }`}
                    data-testid="light-mode-button"
                  >
                    <Sun className="w-4 h-4" />
                    <span className="font-medium text-sm">Light</span>
                  </button>
                  <button
                    onClick={() => setTheme("retro")}
                    className={`flex items-center justify-center gap-2 px-3 py-3 rounded-lg border transition-all ${
                      theme === "retro"
                        ? "bg-accent border-brand-500 text-foreground"
                        : "bg-input border-border text-muted-foreground hover:text-foreground hover:bg-accent"
                    }`}
                    data-testid="retro-mode-button"
                  >
                    <Terminal className="w-4 h-4" />
                    <span className="font-medium text-sm">Retro</span>
                  </button>
                  <button
                    onClick={() => setTheme("dracula")}
                    className={`flex items-center justify-center gap-2 px-3 py-3 rounded-lg border transition-all ${
                      theme === "dracula"
                        ? "bg-accent border-brand-500 text-foreground"
                        : "bg-input border-border text-muted-foreground hover:text-foreground hover:bg-accent"
                    }`}
                    data-testid="dracula-mode-button"
                  >
                    <Ghost className="w-4 h-4" />
                    <span className="font-medium text-sm">Dracula</span>
                  </button>
                  <button
                    onClick={() => setTheme("nord")}
                    className={`flex items-center justify-center gap-2 px-3 py-3 rounded-lg border transition-all ${
                      theme === "nord"
                        ? "bg-accent border-brand-500 text-foreground"
                        : "bg-input border-border text-muted-foreground hover:text-foreground hover:bg-accent"
                    }`}
                    data-testid="nord-mode-button"
                  >
                    <Snowflake className="w-4 h-4" />
                    <span className="font-medium text-sm">Nord</span>
                  </button>
                  <button
                    onClick={() => setTheme("monokai")}
                    className={`flex items-center justify-center gap-2 px-3 py-3 rounded-lg border transition-all ${
                      theme === "monokai"
                        ? "bg-accent border-brand-500 text-foreground"
                        : "bg-input border-border text-muted-foreground hover:text-foreground hover:bg-accent"
                    }`}
                    data-testid="monokai-mode-button"
                  >
                    <Flame className="w-4 h-4" />
                    <span className="font-medium text-sm">Monokai</span>
                  </button>
                  <button
                    onClick={() => setTheme("tokyonight")}
                    className={`flex items-center justify-center gap-2 px-3 py-3 rounded-lg border transition-all ${
                      theme === "tokyonight"
                        ? "bg-accent border-brand-500 text-foreground"
                        : "bg-input border-border text-muted-foreground hover:text-foreground hover:bg-accent"
                    }`}
                    data-testid="tokyonight-mode-button"
                  >
                    <Sparkles className="w-4 h-4" />
                    <span className="font-medium text-sm">Tokyo Night</span>
                  </button>
                  <button
                    onClick={() => setTheme("solarized")}
                    className={`flex items-center justify-center gap-2 px-3 py-3 rounded-lg border transition-all ${
                      theme === "solarized"
                        ? "bg-accent border-brand-500 text-foreground"
                        : "bg-input border-border text-muted-foreground hover:text-foreground hover:bg-accent"
                    }`}
                    data-testid="solarized-mode-button"
                  >
                    <Eclipse className="w-4 h-4" />
                    <span className="font-medium text-sm">Solarized</span>
                  </button>
                  <button
                    onClick={() => setTheme("gruvbox")}
                    className={`flex items-center justify-center gap-2 px-3 py-3 rounded-lg border transition-all ${
                      theme === "gruvbox"
                        ? "bg-accent border-brand-500 text-foreground"
                        : "bg-input border-border text-muted-foreground hover:text-foreground hover:bg-accent"
                    }`}
                    data-testid="gruvbox-mode-button"
                  >
                    <Trees className="w-4 h-4" />
                    <span className="font-medium text-sm">Gruvbox</span>
                  </button>
                  <button
                    onClick={() => setTheme("catppuccin")}
                    className={`flex items-center justify-center gap-2 px-3 py-3 rounded-lg border transition-all ${
                      theme === "catppuccin"
                        ? "bg-accent border-brand-500 text-foreground"
                        : "bg-input border-border text-muted-foreground hover:text-foreground hover:bg-accent"
                    }`}
                    data-testid="catppuccin-mode-button"
                  >
                    <Cat className="w-4 h-4" />
                    <span className="font-medium text-sm">Catppuccin</span>
                  </button>
                  <button
                    onClick={() => setTheme("onedark")}
                    className={`flex items-center justify-center gap-2 px-3 py-3 rounded-lg border transition-all ${
                      theme === "onedark"
                        ? "bg-accent border-brand-500 text-foreground"
                        : "bg-input border-border text-muted-foreground hover:text-foreground hover:bg-accent"
                    }`}
                    data-testid="onedark-mode-button"
                  >
                    <Atom className="w-4 h-4" />
                    <span className="font-medium text-sm">One Dark</span>
                  </button>
                  <button
                    onClick={() => setTheme("synthwave")}
                    className={`flex items-center justify-center gap-2 px-3 py-3 rounded-lg border transition-all ${
                      theme === "synthwave"
                        ? "bg-accent border-brand-500 text-foreground"
                        : "bg-input border-border text-muted-foreground hover:text-foreground hover:bg-accent"
                    }`}
                    data-testid="synthwave-mode-button"
                  >
                    <Radio className="w-4 h-4" />
                    <span className="font-medium text-sm">Synthwave</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Kanban Card Display Section */}
          <div className="rounded-xl border border-border bg-card backdrop-blur-md overflow-hidden">
            <div className="p-6 border-b border-border">
              <div className="flex items-center gap-2 mb-2">
                <LayoutGrid className="w-5 h-5 text-brand-500" />
                <h2 className="text-lg font-semibold text-foreground">
                  Kanban Card Display
                </h2>
              </div>
              <p className="text-sm text-muted-foreground">
                Control how much information is displayed on Kanban cards.
              </p>
            </div>
            <div className="p-6 space-y-4">
              <div className="space-y-3">
                <Label className="text-foreground">Detail Level</Label>
                <div className="grid grid-cols-3 gap-3">
                  <button
                    onClick={() => setKanbanCardDetailLevel("minimal")}
                    className={`flex flex-col items-center justify-center gap-2 px-4 py-4 rounded-lg border transition-all ${
                      kanbanCardDetailLevel === "minimal"
                        ? "bg-accent border-brand-500 text-foreground"
                        : "bg-input border-border text-muted-foreground hover:text-foreground hover:bg-accent"
                    }`}
                    data-testid="kanban-detail-minimal"
                  >
                    <Minimize2 className="w-5 h-5" />
                    <span className="font-medium text-sm">Minimal</span>
                    <span className="text-xs text-muted-foreground text-center">
                      Title & category only
                    </span>
                  </button>
                  <button
                    onClick={() => setKanbanCardDetailLevel("standard")}
                    className={`flex flex-col items-center justify-center gap-2 px-4 py-4 rounded-lg border transition-all ${
                      kanbanCardDetailLevel === "standard"
                        ? "bg-accent border-brand-500 text-foreground"
                        : "bg-input border-border text-muted-foreground hover:text-foreground hover:bg-accent"
                    }`}
                    data-testid="kanban-detail-standard"
                  >
                    <Square className="w-5 h-5" />
                    <span className="font-medium text-sm">Standard</span>
                    <span className="text-xs text-muted-foreground text-center">
                      Steps & progress
                    </span>
                  </button>
                  <button
                    onClick={() => setKanbanCardDetailLevel("detailed")}
                    className={`flex flex-col items-center justify-center gap-2 px-4 py-4 rounded-lg border transition-all ${
                      kanbanCardDetailLevel === "detailed"
                        ? "bg-accent border-brand-500 text-foreground"
                        : "bg-input border-border text-muted-foreground hover:text-foreground hover:bg-accent"
                    }`}
                    data-testid="kanban-detail-detailed"
                  >
                    <Maximize2 className="w-5 h-5" />
                    <span className="font-medium text-sm">Detailed</span>
                    <span className="text-xs text-muted-foreground text-center">
                      Model, tools & tasks
                    </span>
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  <strong>Minimal:</strong> Shows only title and category
                  <br />
                  <strong>Standard:</strong> Adds steps preview and progress bar
                  <br />
                  <strong>Detailed:</strong> Shows all info including model,
                  tool calls, task list, and summaries
                </p>
              </div>
            </div>
          </div>

          {/* Feature Defaults Section */}
          <div className="rounded-xl border border-border bg-card backdrop-blur-md overflow-hidden">
            <div className="p-6 border-b border-border">
              <div className="flex items-center gap-2 mb-2">
                <FlaskConical className="w-5 h-5 text-brand-500" />
                <h2 className="text-lg font-semibold text-foreground">
                  Feature Defaults
                </h2>
              </div>
              <p className="text-sm text-muted-foreground">
                Configure default settings for new features.
              </p>
            </div>
            <div className="p-6 space-y-4">
              <div className="space-y-3">
                <div className="flex items-start space-x-3">
                  <Checkbox
                    id="default-skip-tests"
                    checked={defaultSkipTests}
                    onCheckedChange={(checked) =>
                      setDefaultSkipTests(checked === true)
                    }
                    className="mt-0.5"
                    data-testid="default-skip-tests-checkbox"
                  />
                  <div className="space-y-1">
                    <Label
                      htmlFor="default-skip-tests"
                      className="text-foreground cursor-pointer font-medium"
                    >
                      Skip automated testing by default
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      When enabled, new features will default to manual
                      verification instead of TDD (test-driven development).
                      You can still override this for individual features.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Save Button */}
          <div className="flex items-center gap-4">
            <Button
              onClick={handleSave}
              data-testid="save-settings"
              className="min-w-[120px] bg-linear-to-r from-brand-500 to-brand-600 hover:from-brand-600 hover:to-brand-600 text-primary-foreground border-0"
            >
              {saved ? (
                <>
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                  Saved!
                </>
              ) : (
                "Save Settings"
              )}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setCurrentView("welcome")}
              className="bg-secondary hover:bg-accent text-secondary-foreground border border-border"
              data-testid="back-to-home"
            >
              Back to Home
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
