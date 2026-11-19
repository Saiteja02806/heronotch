// electron-builder afterPack hook.
//
// The macOS build has no Apple Developer certificate (`mac.identity: null`), so
// electron-builder does not sign it. Apple Silicon refuses to launch an arm64
// app whose signature is missing or broken ("Notch is damaged"), and packing
// changes Info.plist and the asar, which invalidates Electron's own ad-hoc
// signature. Re-sign the finished bundle ad hoc so it launches.
//
// Windows and Linux builds return immediately.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function adhocSignMac(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.platform !== 'darwin') {
    console.warn('  • skipping ad-hoc signing: codesign is only available on macOS')
    return
  }
  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)
  console.log(`  • ad-hoc signing ${appPath}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
}
