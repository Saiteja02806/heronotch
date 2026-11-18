/**
 * Errors that cross the main/renderer boundary arrive with two layers of
 * plumbing attached:
 *
 *   Error invoking remote method 'spotify:action': SpotifyControlError: …
 *
 * None of that helps the person reading a toast, so reduce it to the sentence
 * the app actually wrote. Kept in `shared` so it can be unit-tested without
 * starting Electron.
 */

const INVOKE_PREFIX = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/
const ERROR_NAME_PREFIX = /^[A-Za-z_$][\w$]*(?:Error|Exception):\s*/

export function plainErrorMessage(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause ?? '')
  return (
    raw.replace(INVOKE_PREFIX, '').replace(ERROR_NAME_PREFIX, '').trim() ||
    'That did not work. Try again.'
  )
}
