// Runs the current native media source directly; no application build or saved-state writes.
const fs = require('node:fs')
const path = require('node:path')
const { stripTypeScriptTypes } = require('node:module')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
function sourceModule(file, bindings, names) {
  let source = stripTypeScriptTypes(fs.readFileSync(path.join(root, file), 'utf8'))
  source = source.replace(/^import\s[^\n]+\sfrom\s['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export /gm, '')
  return new Function(...Object.keys(bindings), `${source}\nreturn {${names.join(',')}}`)(...Object.values(bindings))
}
const follow = sourceModule('src/shared/mediaFollow.ts', {}, ['pickMediaSession','friendlyMediaName','followWithSpotifyApi','retainPlayback','playbackLabel','playbackMatchesPreference'])
const media = sourceModule('src/main/localMedia.ts', {
  ...require('node:child_process'), ...follow, getState: () => ({settings:{mediaSource:'auto'}})
}, ['startLocalMediaMonitor','stopLocalMediaMonitor','listMediaSources','getLocalPlayback','performLocalAction','runControl'])
const sleep = ms => new Promise(r=>setTimeout(r,ms))
function snapshot(id) {
  const p = media.getLocalPlayback(id)
  return {id:p.localSessionId, title:p.track?.name, playing:p.playing, available:p.connected, progress:p.track?.progress}
}
async function main() {
  media.startLocalMediaMonitor()
  await sleep(3000)
  const [mode='inspect', target, other] = process.argv.slice(2)
  if(mode==='inspect') {
    console.log(JSON.stringify(media.listMediaSources().map(s=>({...s,...snapshot(s.id)}))))
    return
  }
  assert(target && other, 'Supply exact target and other session IDs')
  const before = snapshot(other)
  assert(before.available, 'Other player must be present')
  if(mode==='cycle') {
    const original = snapshot(target)
    assert(original.available, 'Target must be present')
    for(const type of ['pause','play','pause']) {
      const result = await media.performLocalAction({type},target)
      await sleep(1400)
      const after = snapshot(other)
      assert.equal(result.localSessionId,target)
      assert.equal(snapshot(target).playing,type==='play')
      assert.equal(after.title,before.title)
      assert.equal(after.playing,before.playing)
      console.log(`PASS ${type}: exact target changed, other player unchanged`)
    }
    if(original.playing) await media.performLocalAction({type:'play'},target)
  } else if(mode==='missing') {
    assert.equal(snapshot(target).available,false,'Target must be closed')
    for(const type of ['play','pause','next','previous','seek']) {
      const action = type==='seek'?{type,position:1000}:{type}
      await assert.rejects(media.performLocalAction(action,target),/unavailable/)
      // Exercise the actual native lookup too, representing a stale monitor snapshot.
      const result = await media.runControl(action,target)
      assert.equal(result.ok,false)
      await sleep(1200)
      const after=snapshot(other)
      assert.equal(after.title,before.title)
      assert.equal(after.playing,before.playing)
      assert.equal(snapshot(target).available,false)
      console.log(`PASS closed target ${type}: JS rejected, native rejected, other player unchanged`)
    }
  } else throw new Error('Unknown mode')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>media.stopLocalMediaMonitor())
