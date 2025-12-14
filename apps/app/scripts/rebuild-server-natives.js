#!/usr/bin/env node

/**
 * Electron-builder afterPack hook
 * Rebuilds native modules in the server bundle for the target architecture
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execAsync = promisify(exec);

exports.default = async function(context) {
  const { appOutDir, electronPlatformName, arch, packager } = context;
  const electronVersion = packager.config.electronVersion;

  // Convert arch to string if it's a number (electron-builder sometimes passes indices)
  const archNames = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];
  const archStr = typeof arch === 'number' ? archNames[arch] : arch;

  console.log(`\n🔨 Rebuilding server native modules for ${electronPlatformName}-${archStr}...`);

  // Path to server node_modules in the packaged app
  let serverNodeModulesPath;
  if (electronPlatformName === 'darwin') {
    serverNodeModulesPath = path.join(
      appOutDir,
      `${packager.appInfo.productName}.app`,
      'Contents',
      'Resources',
      'server',
      'node_modules'
    );
  } else if (electronPlatformName === 'win32') {
    serverNodeModulesPath = path.join(
      appOutDir,
      'resources',
      'server',
      'node_modules'
    );
  } else {
    serverNodeModulesPath = path.join(
      appOutDir,
      'resources',
      'server',
      'node_modules'
    );
  }

  try {
    // Rebuild native modules for the target architecture
    const rebuildCmd = `npx --yes @electron/rebuild --version=${electronVersion} --arch=${archStr} --force --module-dir="${serverNodeModulesPath}/.."`;

    console.log(`   Command: ${rebuildCmd}`);

    const { stdout, stderr } = await execAsync(rebuildCmd);
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    console.log(`✅ Server native modules rebuilt successfully for ${archStr}\n`);
  } catch (error) {
    console.error(`❌ Failed to rebuild server native modules:`, error.message);
    // Don't fail the build, just warn
  }
};
