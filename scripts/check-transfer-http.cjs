const fs = require('node:fs')
const { stripTypeScriptTypes } = require('node:module')
const assert = require('node:assert/strict')
async function main() {
  const source = stripTypeScriptTypes(fs.readFileSync('src/main/phoneTransfer.ts','utf8'))
  const {startTransfer,qrImage} = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))
  const bytes = Buffer.from([0,17,255,90])
  const session = await startTransfer('127.0.0.1',{name:'notch-test.bin',bytes,text:false})
  try {
    assert(qrImage(session.url,process.cwd()).startsWith('data:image/svg+xml;base64,'))
    const filePage = await (await fetch(session.url)).text()
    assert.equal((await fetch(session.url)).status,200)
    assert(filePage.includes('href="download"'),'a file offer links to the download')
    assert(!filePage.includes('id="outgoing"'),'a file offer does not print file bytes inline')
    assert.deepEqual(Buffer.from(await (await fetch(session.url+'download')).arrayBuffer()),bytes)
    assert.equal((await fetch(new URL('/wrong/download',session.url))).status,404)
    for (const kind of ['file','text']) {
      const upload=()=>fetch(session.url+'receive',{method:'POST',headers:{'X-Notch-Name':'test','X-Notch-Kind':kind},body:bytes})
      assert.equal((await upload()).status,201)
      assert.equal((await upload()).status,409)
      assert.deepEqual(session.peek().bytes,bytes)
      assert.equal(session.peek().text,kind==='text')
      session.collected(session.peek())
    }
    console.log('PASS real HTTP: page, exact binary download/upload, text upload, inbox collection, token isolation; QR generated.')
  } finally {session.stop()}
  await assert.rejects(fetch(session.url))
  console.log('PASS ended transfer refuses connection.')

  // Text from the laptop is shown on the phone page itself, ready to copy.
  const note = '<b>2 + 2 < 5</b> & a link: https://example.com/x?a=1&b=2'
  const textSession = await startTransfer('127.0.0.1',{name:'note.txt',bytes:Buffer.from(note,'utf8'),text:true})
  try {
    const page = await (await fetch(textSession.url)).text()
    assert(page.includes('id="outgoing"'),'text is printed inline')
    assert(page.includes('&lt;b&gt;2 + 2 &lt; 5&lt;/b&gt; &amp; a link'),'text is escaped, not parsed as HTML')
    assert(page.includes('Copy text'),'the phone gets a copy button')
    assert(!page.includes('href="download"'),'short text is not offered as a download')
    console.log('PASS text offer renders inline with escaping and a copy button.')
  } finally {textSession.stop()}

  // Long text falls back to a download so the page stays light.
  const big = 'x'.repeat(200001)
  const bigSession = await startTransfer('127.0.0.1',{name:'note.txt',bytes:Buffer.from(big,'utf8'),text:true})
  try {
    const page = await (await fetch(bigSession.url)).text()
    assert(!page.includes('id="outgoing"'),'a huge text is not inlined')
    assert(page.includes('Download text file'),'a huge text downloads as text')
  } finally {bigSession.stop()}
  console.log('PASS long text falls back to a text download.')
}
main().catch(error=>{console.error(error);process.exitCode=1})
