"use client";

import { useState, useEffect } from "react";
import { FolderOpen, Folder, ChevronRight, Home, ArrowLeft, HardDrive } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface DirectoryEntry {
  name: string;
  path: string;
}

interface BrowseResult {
  success: boolean;
  currentPath: string;
  parentPath: string | null;
  directories: DirectoryEntry[];
  drives?: string[];
  error?: string;
}

interface FileBrowserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
  title?: string;
  description?: string;
}

export function FileBrowserDialog({
  open,
  onOpenChange,
  onSelect,
  title = "Select Project Directory",
  description = "Navigate to your project folder",
}: FileBrowserDialogProps) {
  const [currentPath, setCurrentPath] = useState<string>("");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [directories, setDirectories] = useState<DirectoryEntry[]>([]);
  const [drives, setDrives] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const browseDirectory = async (dirPath?: string) => {
    setLoading(true);
    setError("");

    try {
      // Get server URL from environment or default
      const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3008";

      const response = await fetch(`${serverUrl}/api/fs/browse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dirPath }),
      });

      const result: BrowseResult = await response.json();

      if (result.success) {
        setCurrentPath(result.currentPath);
        setParentPath(result.parentPath);
        setDirectories(result.directories);
        setDrives(result.drives || []);
      } else {
        setError(result.error || "Failed to browse directory");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load directories");
    } finally {
      setLoading(false);
    }
  };

  // Load home directory on mount
  useEffect(() => {
    if (open && !currentPath) {
      browseDirectory();
    }
  }, [open]);

  const handleSelectDirectory = (dir: DirectoryEntry) => {
    browseDirectory(dir.path);
  };

  const handleGoToParent = () => {
    if (parentPath) {
      browseDirectory(parentPath);
    }
  };

  const handleGoHome = () => {
    browseDirectory();
  };

  const handleSelectDrive = (drivePath: string) => {
    browseDirectory(drivePath);
  };

  const handleSelect = () => {
    if (currentPath) {
      onSelect(currentPath);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader className="pb-2">
          <DialogTitle className="flex items-center gap-2">
            <FolderOpen className="w-5 h-5 text-brand-500" />
            {title}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {description}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 min-h-[400px] flex-1 overflow-hidden py-2">
          {/* Drives selector (Windows only) */}
          {drives.length > 0 && (
            <div className="flex flex-wrap gap-2 p-3 rounded-lg bg-sidebar-accent/10 border border-sidebar-border">
              <div className="flex items-center gap-1 text-xs text-muted-foreground mr-2">
                <HardDrive className="w-3 h-3" />
                <span>Drives:</span>
              </div>
              {drives.map((drive) => (
                <Button
                  key={drive}
                  variant={currentPath.startsWith(drive) ? "default" : "outline"}
                  size="sm"
                  onClick={() => handleSelectDrive(drive)}
                  className="h-7 px-3 text-xs"
                  disabled={loading}
                >
                  {drive.replace("\\", "")}
                </Button>
              ))}
            </div>
          )}

          {/* Current path breadcrumb */}
          <div className="flex items-center gap-2 p-3 rounded-lg bg-sidebar-accent/10 border border-sidebar-border">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleGoHome}
              className="h-7 px-2"
              disabled={loading}
            >
              <Home className="w-4 h-4" />
            </Button>
            {parentPath && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleGoToParent}
                className="h-7 px-2"
                disabled={loading}
              >
                <ArrowLeft className="w-4 h-4" />
              </Button>
            )}
            <div className="flex-1 font-mono text-sm truncate text-muted-foreground">
              {currentPath || "Loading..."}
            </div>
          </div>

          {/* Directory list */}
          <div className="flex-1 overflow-y-auto border border-sidebar-border rounded-lg">
            {loading && (
              <div className="flex items-center justify-center h-full p-8">
                <div className="text-sm text-muted-foreground">Loading directories...</div>
              </div>
            )}

            {error && (
              <div className="flex items-center justify-center h-full p-8">
                <div className="text-sm text-destructive">{error}</div>
              </div>
            )}

            {!loading && !error && directories.length === 0 && (
              <div className="flex items-center justify-center h-full p-8">
                <div className="text-sm text-muted-foreground">No subdirectories found</div>
              </div>
            )}

            {!loading && !error && directories.length > 0 && (
              <div className="divide-y divide-sidebar-border">
                {directories.map((dir) => (
                  <button
                    key={dir.path}
                    onClick={() => handleSelectDirectory(dir)}
                    className="w-full flex items-center gap-3 p-3 hover:bg-sidebar-accent/10 transition-colors text-left group"
                  >
                    <Folder className="w-5 h-5 text-brand-500 shrink-0" />
                    <span className="flex-1 truncate text-sm">{dir.name}</span>
                    <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="text-xs text-muted-foreground">
            Click on a folder to navigate. Select the current folder or navigate to a subfolder.
          </div>
        </div>

        <DialogFooter className="border-t border-border pt-4 gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSelect} disabled={!currentPath || loading}>
            <FolderOpen className="w-4 h-4 mr-2" />
            Select Current Folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
