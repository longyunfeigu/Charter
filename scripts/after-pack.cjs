// electron-builder afterPack hook: flip Electron fuses on the packed binary
// (M11-01, §16.4). CJS because electron-builder require()s hooks.
const path = require('node:path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const plan = require('./fuse-plan.cjs');

function electronBinaryPath(context) {
  const name = context.packager.appInfo.productFilename;
  switch (context.electronPlatformName) {
    case 'darwin':
      return path.join(context.appOutDir, `${name}.app`, 'Contents', 'MacOS', name);
    case 'win32':
      return path.join(context.appOutDir, `${name}.exe`);
    default:
      return path.join(context.appOutDir, name.toLowerCase());
  }
}

exports.default = async function afterPack(context) {
  const binary = electronBinaryPath(context);
  await flipFuses(binary, {
    version: FuseVersion[plan.version],
    resetAdHocDarwinSignature: plan.resetAdHocDarwinSignature,
    [FuseV1Options.RunAsNode]: plan.fuses.runAsNode,
    [FuseV1Options.EnableCookieEncryption]: plan.fuses.enableCookieEncryption,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]:
      plan.fuses.enableNodeOptionsEnvironmentVariable,
    [FuseV1Options.EnableNodeCliInspectArguments]: plan.fuses.enableNodeCliInspectArguments,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]:
      plan.fuses.enableEmbeddedAsarIntegrityValidation,
    [FuseV1Options.OnlyLoadAppFromAsar]: plan.fuses.onlyLoadAppFromAsar,
  });
  console.log(`[after-pack] fuses flipped on ${binary}`);
};
