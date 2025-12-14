/**
 * Templates routes
 * Provides API for cloning GitHub starter templates
 */

import { Router, type Request, type Response } from "express";
import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import { addAllowedPath } from "../lib/security.js";

export function createTemplatesRoutes(): Router {
  const router = Router();

  /**
   * Clone a GitHub template to a new project directory
   * POST /api/templates/clone
   * Body: { repoUrl: string, projectName: string, parentDir: string }
   */
  router.post("/clone", async (req: Request, res: Response) => {
    try {
      const { repoUrl, projectName, parentDir } = req.body as {
        repoUrl: string;
        projectName: string;
        parentDir: string;
      };

      // Validate inputs
      if (!repoUrl || !projectName || !parentDir) {
        res.status(400).json({
          success: false,
          error: "repoUrl, projectName, and parentDir are required",
        });
        return;
      }

      console.log(`[Templates] Clone request - Repo: ${repoUrl}, Project: ${projectName}, Parent: ${parentDir}`);

      // Validate repo URL is a valid GitHub URL
      const githubUrlPattern = /^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/;
      if (!githubUrlPattern.test(repoUrl)) {
        res.status(400).json({
          success: false,
          error: "Invalid GitHub repository URL",
        });
        return;
      }

      // Sanitize project name (allow alphanumeric, dash, underscore)
      const sanitizedName = projectName.replace(/[^a-zA-Z0-9-_]/g, "-");
      if (sanitizedName !== projectName) {
        console.log(
          `[Templates] Sanitized project name: ${projectName} -> ${sanitizedName}`
        );
      }

      // Build full project path
      const projectPath = path.join(parentDir, sanitizedName);

      const resolvedParent = path.resolve(parentDir);
      const resolvedProject = path.resolve(projectPath);
      const relativePath = path.relative(resolvedParent, resolvedProject);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return res.status(400).json({
          success: false,
          error: "Invalid project name; potential path traversal attempt.",
        });
      }

      // Check if directory already exists
      try {
        await fs.access(projectPath);
        res.status(400).json({
          success: false,
          error: `Directory "${sanitizedName}" already exists in ${parentDir}`,
        });
        return;
      } catch {
        // Directory doesn't exist, which is what we want
      }

      // Ensure parent directory exists
      try {
        // Check if parentDir is a root path (Windows: C:\, D:\, etc. or Unix: /)
        const isWindowsRoot = /^[A-Za-z]:\\?$/.test(parentDir);
        const isUnixRoot = parentDir === '/' || parentDir === '';
        const isRoot = isWindowsRoot || isUnixRoot;

        if (isRoot) {
          // Root paths always exist, just verify access
          console.log(`[Templates] Using root path: ${parentDir}`);
          await fs.access(parentDir);
        } else {
          // Check if parent directory exists
          const parentExists = await fs.access(parentDir).then(() => true).catch(() => false);

          if (!parentExists) {
            console.log(`[Templates] Creating parent directory: ${parentDir}`);
            await fs.mkdir(parentDir, { recursive: true });
          } else {
            console.log(`[Templates] Parent directory exists: ${parentDir}`);
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("[Templates] Failed to access parent directory:", parentDir, error);
        res.status(500).json({
          success: false,
          error: `Failed to access parent directory: ${errorMessage}`,
        });
        return;
      }

      console.log(`[Templates] Cloning ${repoUrl} to ${projectPath}`);

      // Clone the repository
      const cloneResult = await new Promise<{
        success: boolean;
        error?: string;
      }>((resolve) => {
        const gitProcess = spawn("git", ["clone", repoUrl, projectPath], {
          cwd: parentDir,
        });

        let stderr = "";

        gitProcess.stderr.on("data", (data) => {
          stderr += data.toString();
        });

        gitProcess.on("close", (code) => {
          if (code === 0) {
            resolve({ success: true });
          } else {
            resolve({
              success: false,
              error: stderr || `Git clone failed with code ${code}`,
            });
          }
        });

        gitProcess.on("error", (error) => {
          resolve({
            success: false,
            error: `Failed to spawn git: ${error.message}`,
          });
        });
      });

      if (!cloneResult.success) {
        res.status(500).json({
          success: false,
          error: cloneResult.error || "Failed to clone repository",
        });
        return;
      }

      // Remove .git directory to start fresh
      try {
        const gitDir = path.join(projectPath, ".git");
        await fs.rm(gitDir, { recursive: true, force: true });
        console.log("[Templates] Removed .git directory");
      } catch (error) {
        console.warn("[Templates] Could not remove .git directory:", error);
        // Continue anyway - not critical
      }

      // Initialize a fresh git repository
      await new Promise<void>((resolve) => {
        const gitInit = spawn("git", ["init"], {
          cwd: projectPath,
        });

        gitInit.on("close", () => {
          console.log("[Templates] Initialized fresh git repository");
          resolve();
        });

        gitInit.on("error", () => {
          console.warn("[Templates] Could not initialize git");
          resolve();
        });
      });

      // Add to allowed paths
      addAllowedPath(projectPath);

      console.log(`[Templates] Successfully cloned template to ${projectPath}`);

      res.json({
        success: true,
        projectPath,
        projectName: sanitizedName,
      });
    } catch (error) {
      console.error("[Templates] Clone error:", error);
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ success: false, error: message });
    }
  });

  return router;
}
