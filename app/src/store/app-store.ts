import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Project } from "@/lib/electron";

export type ViewMode =
  | "welcome"
  | "spec"
  | "board"
  | "agent"
  | "settings"
  | "tools"
  | "interview"
  | "context";

export type ThemeMode =
  | "light"
  | "dark"
  | "system"
  | "retro"
  | "dracula"
  | "nord"
  | "monokai"
  | "tokyonight"
  | "solarized"
  | "gruvbox"
  | "catppuccin"
  | "onedark"
  | "synthwave";

export type KanbanCardDetailLevel = "minimal" | "standard" | "detailed";

export interface ApiKeys {
  anthropic: string;
  google: string;
}

export interface ImageAttachment {
  id: string;
  data: string; // base64 encoded image data
  mimeType: string; // e.g., "image/png", "image/jpeg"
  filename: string;
  size: number; // file size in bytes
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  images?: ImageAttachment[];
}

export interface ChatSession {
  id: string;
  title: string;
  projectId: string;
  messages: ChatMessage[];
  createdAt: Date;
  updatedAt: Date;
  archived: boolean;
}

export interface FeatureImage {
  id: string;
  data: string; // base64 encoded
  mimeType: string;
  filename: string;
  size: number;
}

export interface FeatureImagePath {
  id: string;
  path: string; // Path to the temp file
  filename: string;
  mimeType: string;
}

export interface Feature {
  id: string;
  category: string;
  description: string;
  steps: string[];
  status: "backlog" | "in_progress" | "waiting_approval" | "verified";
  images?: FeatureImage[];
  imagePaths?: FeatureImagePath[]; // Paths to temp files for agent context
  startedAt?: string; // ISO timestamp for when the card moved to in_progress
  skipTests?: boolean; // When true, skip TDD approach and require manual verification
  summary?: string; // Summary of what was done/modified by the agent
}

export interface AppState {
  // Project state
  projects: Project[];
  currentProject: Project | null;

  // View state
  currentView: ViewMode;
  sidebarOpen: boolean;

  // Theme
  theme: ThemeMode;

  // Features/Kanban
  features: Feature[];

  // App spec
  appSpec: string;

  // IPC status
  ipcConnected: boolean;

  // API Keys
  apiKeys: ApiKeys;

  // Chat Sessions
  chatSessions: ChatSession[];
  currentChatSession: ChatSession | null;
  chatHistoryOpen: boolean;

  // Auto Mode
  isAutoModeRunning: boolean;
  runningAutoTasks: string[]; // Feature IDs being worked on (supports concurrent tasks)
  autoModeActivityLog: AutoModeActivity[];
  maxConcurrency: number; // Maximum number of concurrent agent tasks

  // Kanban Card Display Settings
  kanbanCardDetailLevel: KanbanCardDetailLevel; // Level of detail shown on kanban cards

  // Feature Default Settings
  defaultSkipTests: boolean; // Default value for skip tests when creating new features
}

export interface AutoModeActivity {
  id: string;
  featureId: string;
  timestamp: Date;
  type:
    | "start"
    | "progress"
    | "tool"
    | "complete"
    | "error"
    | "planning"
    | "action"
    | "verification";
  message: string;
  tool?: string;
  passes?: boolean;
  phase?: "planning" | "action" | "verification";
}

export interface AppActions {
  // Project actions
  setProjects: (projects: Project[]) => void;
  addProject: (project: Project) => void;
  removeProject: (projectId: string) => void;
  setCurrentProject: (project: Project | null) => void;

  // View actions
  setCurrentView: (view: ViewMode) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;

  // Theme actions
  setTheme: (theme: ThemeMode) => void;

  // Feature actions
  setFeatures: (features: Feature[]) => void;
  updateFeature: (id: string, updates: Partial<Feature>) => void;
  addFeature: (feature: Omit<Feature, "id">) => void;
  removeFeature: (id: string) => void;
  moveFeature: (id: string, newStatus: Feature["status"]) => void;

  // App spec actions
  setAppSpec: (spec: string) => void;

  // IPC actions
  setIpcConnected: (connected: boolean) => void;

  // API Keys actions
  setApiKeys: (keys: Partial<ApiKeys>) => void;

  // Chat Session actions
  createChatSession: (title?: string) => ChatSession;
  updateChatSession: (sessionId: string, updates: Partial<ChatSession>) => void;
  addMessageToSession: (sessionId: string, message: ChatMessage) => void;
  setCurrentChatSession: (session: ChatSession | null) => void;
  archiveChatSession: (sessionId: string) => void;
  unarchiveChatSession: (sessionId: string) => void;
  deleteChatSession: (sessionId: string) => void;
  setChatHistoryOpen: (open: boolean) => void;
  toggleChatHistory: () => void;

  // Auto Mode actions
  setAutoModeRunning: (running: boolean) => void;
  addRunningTask: (taskId: string) => void;
  removeRunningTask: (taskId: string) => void;
  clearRunningTasks: () => void;
  addAutoModeActivity: (
    activity: Omit<AutoModeActivity, "id" | "timestamp">
  ) => void;
  clearAutoModeActivity: () => void;
  setMaxConcurrency: (max: number) => void;

  // Kanban Card Settings actions
  setKanbanCardDetailLevel: (level: KanbanCardDetailLevel) => void;

  // Feature Default Settings actions
  setDefaultSkipTests: (skip: boolean) => void;

  // Reset
  reset: () => void;
}

const initialState: AppState = {
  projects: [],
  currentProject: null,
  currentView: "welcome",
  sidebarOpen: true,
  theme: "dark",
  features: [],
  appSpec: "",
  ipcConnected: false,
  apiKeys: {
    anthropic: "",
    google: "",
  },
  chatSessions: [],
  currentChatSession: null,
  chatHistoryOpen: false,
  isAutoModeRunning: false,
  runningAutoTasks: [],
  autoModeActivityLog: [],
  maxConcurrency: 3, // Default to 3 concurrent agents
  kanbanCardDetailLevel: "standard", // Default to standard detail level
  defaultSkipTests: false, // Default to TDD mode (tests enabled)
};

export const useAppStore = create<AppState & AppActions>()(
  persist(
    (set, get) => ({
      ...initialState,

      // Project actions
      setProjects: (projects) => set({ projects }),

      addProject: (project) => {
        const projects = get().projects;
        const existing = projects.findIndex((p) => p.path === project.path);
        if (existing >= 0) {
          const updated = [...projects];
          updated[existing] = {
            ...project,
            lastOpened: new Date().toISOString(),
          };
          set({ projects: updated });
        } else {
          set({
            projects: [
              ...projects,
              { ...project, lastOpened: new Date().toISOString() },
            ],
          });
        }
      },

      removeProject: (projectId) => {
        set({ projects: get().projects.filter((p) => p.id !== projectId) });
      },

      setCurrentProject: (project) => {
        set({ currentProject: project });
        if (project) {
          set({ currentView: "board" });
        } else {
          set({ currentView: "welcome" });
        }
      },

      // View actions
      setCurrentView: (view) => set({ currentView: view }),
      toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),

      // Theme actions
      setTheme: (theme) => set({ theme }),

      // Feature actions
      setFeatures: (features) => set({ features }),

      updateFeature: (id, updates) => {
        set({
          features: get().features.map((f) =>
            f.id === id ? { ...f, ...updates } : f
          ),
        });
      },

      addFeature: (feature) => {
        const id = `feature-${Date.now()}-${Math.random()
          .toString(36)
          .substr(2, 9)}`;
        set({ features: [...get().features, { ...feature, id }] });
      },

      removeFeature: (id) => {
        set({ features: get().features.filter((f) => f.id !== id) });
      },

      moveFeature: (id, newStatus) => {
        set({
          features: get().features.map((f) =>
            f.id === id ? { ...f, status: newStatus } : f
          ),
        });
      },

      // App spec actions
      setAppSpec: (spec) => set({ appSpec: spec }),

      // IPC actions
      setIpcConnected: (connected) => set({ ipcConnected: connected }),

      // API Keys actions
      setApiKeys: (keys) => set({ apiKeys: { ...get().apiKeys, ...keys } }),

      // Chat Session actions
      createChatSession: (title) => {
        const currentProject = get().currentProject;
        if (!currentProject) {
          throw new Error("No project selected");
        }

        const now = new Date();
        const session: ChatSession = {
          id: `chat-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          title:
            title ||
            `Chat ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`,
          projectId: currentProject.id,
          messages: [
            {
              id: "welcome",
              role: "assistant",
              content:
                "Hello! I'm the Automaker Agent. I can help you build software autonomously. What would you like to create today?",
              timestamp: now,
            },
          ],
          createdAt: now,
          updatedAt: now,
          archived: false,
        };

        set({
          chatSessions: [...get().chatSessions, session],
          currentChatSession: session,
        });

        return session;
      },

      updateChatSession: (sessionId, updates) => {
        set({
          chatSessions: get().chatSessions.map((session) =>
            session.id === sessionId
              ? { ...session, ...updates, updatedAt: new Date() }
              : session
          ),
        });

        // Update current session if it's the one being updated
        const currentSession = get().currentChatSession;
        if (currentSession && currentSession.id === sessionId) {
          set({
            currentChatSession: {
              ...currentSession,
              ...updates,
              updatedAt: new Date(),
            },
          });
        }
      },

      addMessageToSession: (sessionId, message) => {
        const sessions = get().chatSessions;
        const sessionIndex = sessions.findIndex((s) => s.id === sessionId);

        if (sessionIndex >= 0) {
          const updatedSessions = [...sessions];
          updatedSessions[sessionIndex] = {
            ...updatedSessions[sessionIndex],
            messages: [...updatedSessions[sessionIndex].messages, message],
            updatedAt: new Date(),
          };

          set({ chatSessions: updatedSessions });

          // Update current session if it's the one being updated
          const currentSession = get().currentChatSession;
          if (currentSession && currentSession.id === sessionId) {
            set({
              currentChatSession: updatedSessions[sessionIndex],
            });
          }
        }
      },

      setCurrentChatSession: (session) => {
        set({ currentChatSession: session });
      },

      archiveChatSession: (sessionId) => {
        get().updateChatSession(sessionId, { archived: true });
      },

      unarchiveChatSession: (sessionId) => {
        get().updateChatSession(sessionId, { archived: false });
      },

      deleteChatSession: (sessionId) => {
        const currentSession = get().currentChatSession;
        set({
          chatSessions: get().chatSessions.filter((s) => s.id !== sessionId),
          currentChatSession:
            currentSession?.id === sessionId ? null : currentSession,
        });
      },

      setChatHistoryOpen: (open) => set({ chatHistoryOpen: open }),

      toggleChatHistory: () => set({ chatHistoryOpen: !get().chatHistoryOpen }),

      // Auto Mode actions
      setAutoModeRunning: (running) => set({ isAutoModeRunning: running }),

      addRunningTask: (taskId) => {
        const current = get().runningAutoTasks;
        if (!current.includes(taskId)) {
          set({ runningAutoTasks: [...current, taskId] });
        }
      },

      removeRunningTask: (taskId) => {
        set({
          runningAutoTasks: get().runningAutoTasks.filter(
            (id) => id !== taskId
          ),
        });
      },

      clearRunningTasks: () => set({ runningAutoTasks: [] }),

      addAutoModeActivity: (activity) => {
        const id = `activity-${Date.now()}-${Math.random()
          .toString(36)
          .substr(2, 9)}`;
        const newActivity: AutoModeActivity = {
          ...activity,
          id,
          timestamp: new Date(),
        };

        // Keep only the last 100 activities to avoid memory issues
        const currentLog = get().autoModeActivityLog;
        const updatedLog = [...currentLog, newActivity].slice(-100);

        set({ autoModeActivityLog: updatedLog });
      },

      clearAutoModeActivity: () => set({ autoModeActivityLog: [] }),

      setMaxConcurrency: (max) => set({ maxConcurrency: max }),

      // Kanban Card Settings actions
      setKanbanCardDetailLevel: (level) =>
        set({ kanbanCardDetailLevel: level }),

      // Feature Default Settings actions
      setDefaultSkipTests: (skip) => set({ defaultSkipTests: skip }),

      // Reset
      reset: () => set(initialState),
    }),
    {
      name: "automaker-storage",
      partialize: (state) => ({
        projects: state.projects,
        currentProject: state.currentProject,
        currentView: state.currentView,
        theme: state.theme,
        sidebarOpen: state.sidebarOpen,
        apiKeys: state.apiKeys,
        chatSessions: state.chatSessions,
        chatHistoryOpen: state.chatHistoryOpen,
        maxConcurrency: state.maxConcurrency,
        kanbanCardDetailLevel: state.kanbanCardDetailLevel,
        defaultSkipTests: state.defaultSkipTests,
      }),
    }
  )
);
