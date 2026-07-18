// Electron fuse plan (M11-01, §16.4). CJS so both the electron-builder
// afterPack hook and the security vitest suite load the SAME object — the
// security suite pins every value; loosening one must fail a test.
//
// resetAdHocDarwinSignature: flipping fuses invalidates the ad-hoc signature
// electron ships with on arm64 macOS; without a re-sign the app is killed on
// launch. Release signing (M12-02) re-signs on top.
module.exports = {
  version: 'V1',
  resetAdHocDarwinSignature: true,
  fuses: {
    runAsNode: false, // ELECTRON_RUN_AS_NODE cannot turn the app into a node interpreter
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false, // NODE_OPTIONS injection dead
    enableNodeCliInspectArguments: false, // --inspect/--inspect-brk dead
    enableEmbeddedAsarIntegrityValidation: true, // asar tamper check (macOS)
    onlyLoadAppFromAsar: true, // no app-folder shadowing next to the asar
  },
};
