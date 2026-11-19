// Platform-specific wording for the renderer. The main process tells the
// preload which OS it runs on; everything else is copy.
export const isMac = window.notch.platform === 'darwin'

/** Modifier key label for shortcuts: Cmd on macOS, Ctrl elsewhere. */
export const MOD_KEY = isMac ? '⌘' : 'Ctrl'
export const MOD_KEY_TEXT = isMac ? 'Cmd' : 'Ctrl'

/** The system file manager. */
export const FILE_MANAGER = isMac ? 'Finder' : 'Explorer'

/** What "this computer" is called in user-facing copy. */
export const THIS_COMPUTER = isMac ? 'this Mac' : 'this PC'

/** Where local media control comes from. */
export const LOCAL_MEDIA_SOURCE = isMac ? 'macOS' : 'Windows'
export const LOCAL_MEDIA_SESSION = isMac ? 'the Spotify app on this Mac' : 'the Windows media session'

/** Where camera permissions live. */
export const CAMERA_SETTINGS_HINT = isMac
  ? 'Allow Notch in System Settings › Privacy & Security › Camera.'
  : 'Check Windows camera privacy settings.'
