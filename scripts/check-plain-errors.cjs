const fs = require('node:fs')
const assert = require('node:assert/strict')
const { stripTypeScriptTypes } = require('node:module')

async function main() {
  const source = stripTypeScriptTypes(fs.readFileSync('src/shared/errors.ts', 'utf8'))
  const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))

  // Electron's wrapper plus a main-process error class.
  assert.equal(
    mod.plainErrorMessage(
      new Error(
        "Error invoking remote method 'spotify:action': SpotifyControlError: Spotify is not open yet. Open the Spotify app or the web player, then press Play again."
      )
    ),
    'Spotify is not open yet. Open the Spotify app or the web player, then press Play again.'
  )

  // Wrapper plus a plain Error.
  assert.equal(
    mod.plainErrorMessage(new Error("Error invoking remote method 'phone:start': Error: A transfer is already open.")),
    'A transfer is already open.'
  )

  // A normal sentence is left alone.
  assert.equal(mod.plainErrorMessage(new Error('A transfer is already open.')), 'A transfer is already open.')

  // Something that is not an Error still produces a sentence.
  assert.equal(mod.plainErrorMessage('Spotify said no.'), 'Spotify said no.')
  assert.equal(mod.plainErrorMessage(''), 'That did not work. Try again.')
  assert.equal(mod.plainErrorMessage(null), 'That did not work. Try again.')

  // Only the plumbing is removed; a colon inside the message survives.
  assert.equal(
    mod.plainErrorMessage(new Error("Error invoking remote method 'agent:setup': Error: Codex: paste this config.")),
    'Codex: paste this config.'
  )

  // A user-visible message never keeps the technical prefix or a class name.
  const sample = mod.plainErrorMessage(
    new Error(
      "Error invoking remote method 'spotify:action': Error: No Spotify player is open. Open Spotify, then press Play again."
    )
  )
  assert(!/remote method|SpotifyControlError|^Error:/.test(sample))

  console.log('PASS plain errors: wrapper, class name, plain text, empty, and inner colon all handled.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
