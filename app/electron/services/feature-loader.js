const path = require("path");
const fs = require("fs/promises");

/**
 * Feature Loader - Handles loading and selecting features from feature_list.json
 */
class FeatureLoader {
  /**
   * Load features from .automaker/feature_list.json
   */
  async loadFeatures(projectPath) {
    const featuresPath = path.join(
      projectPath,
      ".automaker",
      "feature_list.json"
    );

    try {
      const content = await fs.readFile(featuresPath, "utf-8");
      const features = JSON.parse(content);

      // Ensure each feature has an ID
      return features.map((f, index) => ({
        ...f,
        id: f.id || `feature-${index}-${Date.now()}`,
      }));
    } catch (error) {
      console.error("[FeatureLoader] Failed to load features:", error);
      return [];
    }
  }

  /**
   * Update feature status in .automaker/feature_list.json
   * @param {string} featureId - The ID of the feature to update
   * @param {string} status - The new status
   * @param {string} projectPath - Path to the project
   * @param {string} [summary] - Optional summary of what was done
   */
  async updateFeatureStatus(featureId, status, projectPath, summary) {
    const featuresPath = path.join(
      projectPath,
      ".automaker",
      "feature_list.json"
    );

    // 🛡️ SAFETY: Create backup before any modification
    const backupPath = path.join(
      projectPath,
      ".automaker",
      "feature_list.backup.json"
    );

    try {
      const originalContent = await fs.readFile(featuresPath, "utf-8");
      await fs.writeFile(backupPath, originalContent, "utf-8");
      console.log(`[FeatureLoader] Created backup at ${backupPath}`);
    } catch (error) {
      console.warn(`[FeatureLoader] Could not create backup: ${error.message}`);
    }

    const features = await this.loadFeatures(projectPath);

    // 🛡️ VALIDATION: Ensure we loaded features successfully
    if (!Array.isArray(features)) {
      throw new Error("CRITICAL: features is not an array - aborting to prevent data loss");
    }

    if (features.length === 0) {
      console.warn(`[FeatureLoader] WARNING: Feature list is empty. This may indicate corruption.`);
      // Try to restore from backup
      try {
        const backupContent = await fs.readFile(backupPath, "utf-8");
        const backupFeatures = JSON.parse(backupContent);
        if (Array.isArray(backupFeatures) && backupFeatures.length > 0) {
          console.log(`[FeatureLoader] Restored ${backupFeatures.length} features from backup`);
          // Use backup features instead
          features.length = 0;
          features.push(...backupFeatures);
        }
      } catch (backupError) {
        console.error(`[FeatureLoader] Could not restore from backup: ${backupError.message}`);
      }
    }

    const feature = features.find((f) => f.id === featureId);

    if (!feature) {
      console.error(`[FeatureLoader] Feature ${featureId} not found`);
      return;
    }

    // Update the status field
    feature.status = status;

    // Update the summary field if provided
    if (summary) {
      feature.summary = summary;
    }

    // Save back to file
    const toSave = features.map((f) => {
      const featureData = {
        id: f.id,
        category: f.category,
        description: f.description,
        steps: f.steps,
        status: f.status,
      };
      // Preserve optional fields if they exist
      if (f.skipTests !== undefined) {
        featureData.skipTests = f.skipTests;
      }
      if (f.images !== undefined) {
        featureData.images = f.images;
      }
      if (f.imagePaths !== undefined) {
        featureData.imagePaths = f.imagePaths;
      }
      if (f.startedAt !== undefined) {
        featureData.startedAt = f.startedAt;
      }
      if (f.summary !== undefined) {
        featureData.summary = f.summary;
      }
      return featureData;
    });

    // 🛡️ FINAL VALIDATION: Ensure we're not writing an empty array
    if (!Array.isArray(toSave) || toSave.length === 0) {
      throw new Error("CRITICAL: Attempted to save empty feature list - aborting to prevent data loss");
    }

    await fs.writeFile(featuresPath, JSON.stringify(toSave, null, 2), "utf-8");
    console.log(`[FeatureLoader] Updated feature ${featureId}: status=${status}${summary ? `, summary="${summary}"` : ""}`);
    console.log(`[FeatureLoader] Successfully saved ${toSave.length} features to feature_list.json`);
  }

  /**
   * Select the next feature to implement
   * Prioritizes: earlier features in the list that are not verified or waiting_approval
   */
  selectNextFeature(features) {
    // Find first feature that is in backlog or in_progress status
    // Skip verified and waiting_approval (which needs user input)
    return features.find((f) => f.status !== "verified" && f.status !== "waiting_approval");
  }
}

module.exports = new FeatureLoader();
