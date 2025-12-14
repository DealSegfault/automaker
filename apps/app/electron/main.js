/**
 * Simplified Electron main process
 *
 * This version spawns the backend server and uses HTTP API for most operations.
 * Only native features (dialogs, shell) use IPC.
 */

const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");

// Load environment variables from .env file (development only)
if (!app.isPackaged) {
  try {
    require("dotenv").config({ path: path.join(__dirname, "../.env") });
  } catch (error) {
    console.warn("[Electron] dotenv not available:", error.message);
  }
}

let mainWindow = null;
let serverProcess = null;
let staticServer = null;
const SERVER_PORT = 3008;
const STATIC_PORT = 3007;

// Get icon path - works in both dev and production, cross-platform
function getIconPath() {
  // Different icon formats for different platforms
  let iconFile;
  if (process.platform === "win32") {
    iconFile = "icon.ico";
  } else if (process.platform === "darwin") {
    iconFile = "logo_larger.png";
  } else {
    // Linux
    iconFile = "logo_larger.png";
  }

  const iconPath = path.join(__dirname, "../public", iconFile);

  // Verify the icon exists
  if (!fs.existsSync(iconPath)) {
    console.warn(`[Electron] Icon not found at: ${iconPath}`);
    return null;
  }

  return iconPath;
}

/**
 * Start static file server for production builds
 */
async function startStaticServer() {
  const staticPath = path.join(__dirname, "../out");

  staticServer = http.createServer((request, response) => {
    // Parse the URL and remove query string
    let filePath = path.join(staticPath, request.url.split("?")[0]);

    // Default to index.html for directory requests
    if (filePath.endsWith("/")) {
      filePath = path.join(filePath, "index.html");
    } else if (!path.extname(filePath)) {
      filePath += ".html";
    }

    // Check if file exists
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        // Try index.html for SPA fallback
        filePath = path.join(staticPath, "index.html");
      }

      // Read and serve the file
      fs.readFile(filePath, (error, content) => {
        if (error) {
          response.writeHead(500);
          response.end("Server Error");
          return;
        }

        // Set content type based on file extension
        const ext = path.extname(filePath);
        const contentTypes = {
          ".html": "text/html",
          ".js": "application/javascript",
          ".css": "text/css",
          ".json": "application/json",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".gif": "image/gif",
          ".svg": "image/svg+xml",
          ".ico": "image/x-icon",
          ".woff": "font/woff",
          ".woff2": "font/woff2",
          ".ttf": "font/ttf",
          ".eot": "application/vnd.ms-fontobject",
        };

        response.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
        response.end(content);
      });
    });
  });

  return new Promise((resolve, reject) => {
    staticServer.listen(STATIC_PORT, (err) => {
      if (err) {
        reject(err);
      } else {
        console.log(`[Electron] Static server running at http://localhost:${STATIC_PORT}`);
        resolve();
      }
    });
  });
}

/**
 * Start the backend server
 */
async function startServer() {
  const isDev = !app.isPackaged;

  // Server entry point - use tsx in dev, compiled version in production
  let command, args, serverPath;
  if (isDev) {
    // In development, use tsx to run TypeScript directly
    // Use node from PATH (process.execPath in Electron points to Electron, not Node.js)
    // spawn() resolves "node" from PATH on all platforms (Windows, Linux, macOS)
    command = "node";
    serverPath = path.join(__dirname, "../../server/src/index.ts");

    // Find tsx CLI - check server node_modules first, then root
    const serverNodeModules = path.join(
      __dirname,
      "../../server/node_modules/tsx"
    );
    const rootNodeModules = path.join(__dirname, "../../../node_modules/tsx");

    let tsxCliPath;
    if (fs.existsSync(path.join(serverNodeModules, "dist/cli.mjs"))) {
      tsxCliPath = path.join(serverNodeModules, "dist/cli.mjs");
    } else if (fs.existsSync(path.join(rootNodeModules, "dist/cli.mjs"))) {
      tsxCliPath = path.join(rootNodeModules, "dist/cli.mjs");
    } else {
      // Last resort: try require.resolve
      try {
        tsxCliPath = require.resolve("tsx/cli.mjs", {
          paths: [path.join(__dirname, "../../server")],
        });
      } catch {
        throw new Error(
          "Could not find tsx. Please run 'npm install' in the server directory."
        );
      }
    }

    args = [tsxCliPath, "watch", serverPath];
  } else {
    // In production, use compiled JavaScript
    command = "node";
    serverPath = path.join(process.resourcesPath, "server", "index.js");
    args = [serverPath];

    // Verify server files exist
    if (!fs.existsSync(serverPath)) {
      throw new Error(`Server not found at: ${serverPath}`);
    }
  }

  // Set environment variables for server
  const serverNodeModules = app.isPackaged
    ? path.join(process.resourcesPath, "server", "node_modules")
    : path.join(__dirname, "../../server/node_modules");

  // Set default workspace directory to user's Documents/Automaker
  const defaultWorkspaceDir = path.join(app.getPath("documents"), "Automaker");

  // Ensure workspace directory exists
  if (!fs.existsSync(defaultWorkspaceDir)) {
    try {
      fs.mkdirSync(defaultWorkspaceDir, { recursive: true });
      console.log("[Electron] Created workspace directory:", defaultWorkspaceDir);
    } catch (error) {
      console.error("[Electron] Failed to create workspace directory:", error);
    }
  }

  const env = {
    ...process.env,
    PORT: SERVER_PORT.toString(),
    DATA_DIR: app.getPath("userData"),
    NODE_PATH: serverNodeModules,
    WORKSPACE_DIR: process.env.WORKSPACE_DIR || defaultWorkspaceDir,
  };

  console.log("[Electron] Starting backend server...");
  console.log("[Electron] Server path:", serverPath);
  console.log("[Electron] NODE_PATH:", serverNodeModules);

  serverProcess = spawn(command, args, {
    cwd: path.dirname(serverPath),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stdout.on("data", (data) => {
    console.log(`[Server] ${data.toString().trim()}`);
  });

  serverProcess.stderr.on("data", (data) => {
    console.error(`[Server Error] ${data.toString().trim()}`);
  });

  serverProcess.on("close", (code) => {
    console.log(`[Server] Process exited with code ${code}`);
    serverProcess = null;
  });

  serverProcess.on("error", (err) => {
    console.error(`[Server] Failed to start server process:`, err);
    serverProcess = null;
  });

  // Wait for server to be ready
  await waitForServer();
}

/**
 * Wait for server to be available
 */
async function waitForServer(maxAttempts = 30) {
  const http = require("http");

  for (let i = 0; i < maxAttempts; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(
          `http://localhost:${SERVER_PORT}/api/health`,
          (res) => {
            if (res.statusCode === 200) {
              resolve();
            } else {
              reject(new Error(`Status: ${res.statusCode}`));
            }
          }
        );
        req.on("error", reject);
        req.setTimeout(1000, () => {
          req.destroy();
          reject(new Error("Timeout"));
        });
      });
      console.log("[Electron] Server is ready");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  throw new Error("Server failed to start");
}

/**
 * Create the main window
 */
function createWindow() {
  const iconPath = getIconPath();
  const windowOptions = {
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0a0a0a",
  };

  // Only set icon if it exists
  if (iconPath) {
    windowOptions.icon = iconPath;
  }

  mainWindow = new BrowserWindow(windowOptions);

  // Load Next.js dev server in development or static server in production
  const isDev = !app.isPackaged;
  mainWindow.loadURL(`http://localhost:${STATIC_PORT}`);
  if (isDev && process.env.OPEN_DEVTOOLS === "true") {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Handle external links - open in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

// App lifecycle
app.whenReady().then(async () => {
  // Set app icon (dock icon on macOS)
  if (process.platform === "darwin" && app.dock) {
    const iconPath = getIconPath();
    if (iconPath) {
      try {
        app.dock.setIcon(iconPath);
      } catch (error) {
        console.warn("[Electron] Failed to set dock icon:", error.message);
      }
    }
  }

  try {
    // Start static file server in production
    if (app.isPackaged) {
      await startStaticServer();
    }

    // Start backend server
    await startServer();

    // Create window
    createWindow();
  } catch (error) {
    console.error("[Electron] Failed to start:", error);
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  // Kill server process
  if (serverProcess) {
    console.log("[Electron] Stopping server...");
    serverProcess.kill();
    serverProcess = null;
  }

  // Close static server
  if (staticServer) {
    console.log("[Electron] Stopping static server...");
    staticServer.close();
    staticServer = null;
  }
});

// ============================================
// IPC Handlers - Only native features
// ============================================

// Native file dialogs
ipcMain.handle("dialog:openDirectory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
  });
  return result;
});

ipcMain.handle("dialog:openFile", async (_, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    ...options,
  });
  return result;
});

ipcMain.handle("dialog:saveFile", async (_, options = {}) => {
  const result = await dialog.showSaveDialog(mainWindow, options);
  return result;
});

// Shell operations
ipcMain.handle("shell:openExternal", async (_, url) => {
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("shell:openPath", async (_, filePath) => {
  try {
    await shell.openPath(filePath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// App info
ipcMain.handle("app:getPath", async (_, name) => {
  return app.getPath(name);
});

ipcMain.handle("app:getVersion", async () => {
  return app.getVersion();
});

ipcMain.handle("app:isPackaged", async () => {
  return app.isPackaged;
});

// Ping - for connection check
ipcMain.handle("ping", async () => {
  return "pong";
});

// Get server URL for HTTP client
ipcMain.handle("server:getUrl", async () => {
  return `http://localhost:${SERVER_PORT}`;
});
