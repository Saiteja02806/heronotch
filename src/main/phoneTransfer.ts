import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createRequire } from 'node:module'

export interface Parcel {
  name: string
  bytes: Uint8Array
  text: boolean
}
const limit = 16 * 1024 * 1024
/** Text is shown inline on the phone; past this it is a download like a file. */
const inlineTextLimit = 200_000

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const styles = `:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0}
body{min-height:100vh;padding:26px 18px 44px;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:radial-gradient(90% 60% at 50% 0%,#17191b,#0a0b0c 70%);color:#e8e5de;display:flex;justify-content:center;-webkit-text-size-adjust:100%}
main{width:100%;max-width:26rem;display:flex;flex-direction:column;gap:18px}
.eyebrow{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#8b8983}
h1{margin:5px 0 0;font-size:28px;line-height:1.1;font-weight:560;letter-spacing:-.025em}
.card{border:1px solid rgba(255,255,255,.09);border-radius:18px;background:linear-gradient(165deg,rgba(255,255,255,.05),rgba(255,255,255,.015));padding:16px}
h2{margin:0 0 12px;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:#8b8983;font-weight:600}
pre{margin:0 0 14px;max-height:42vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:15px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:#f0ece5;background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:12px}
.meta{margin:0 0 14px;font-size:14px;color:#b7b4ad;overflow-wrap:anywhere}
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:46px;width:100%;padding:0 18px;border-radius:13px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);color:#f2efe8;font:inherit;font-weight:520;text-decoration:none;cursor:pointer;-webkit-tap-highlight-color:transparent}
button.primary,.button.primary{background:#f5f1e8;border-color:#f5f1e8;color:#121314}
button:disabled{opacity:.4;cursor:default}
button:active:not(:disabled){transform:scale(.99)}
label.file{display:flex;align-items:center;justify-content:center;min-height:88px;padding:14px;border:1px dashed rgba(255,255,255,.18);border-radius:14px;color:#a9a69f;font-size:14px;text-align:center;overflow-wrap:anywhere;cursor:pointer}
label.file.has-file{border-style:solid;border-color:rgba(255,255,255,.3);color:#e8e5de}
label.file input{display:none}
textarea{width:100%;min-height:104px;margin:0;padding:12px;border-radius:13px;border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.28);color:#f0ece5;font:15px/1.5 inherit;resize:vertical}
textarea::placeholder{color:#7c7a75}
textarea:focus,label.file:focus-within,button:focus-visible{outline:2px solid rgba(255,255,255,.35);outline-offset:2px}
.stack{display:flex;flex-direction:column;gap:10px}
.divider{display:flex;align-items:center;gap:10px;margin:2px 0;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6f6d68}
.divider::before,.divider::after{content:"";flex:1;height:1px;background:rgba(255,255,255,.08)}
.status{min-height:20px;margin:0;font-size:13px;color:#9d9a93;text-align:center}
.status.is-error{color:#ff9f92}
footer{font-size:11.5px;color:#6f6d68;text-align:center}
`

function fromLaptop(outgoing: Parcel | null): string {
  if (!outgoing) return ''
  const body = outgoing.text ? Buffer.from(outgoing.bytes).toString('utf8') : ''
  if (outgoing.text && body.length <= inlineTextLimit) {
    return `<section class="card">
  <h2>From your laptop</h2>
  <pre id="outgoing">${escapeHtml(body)}</pre>
  <button class="primary" id="copy" type="button">Copy text</button>
</section>`
  }
  return `<section class="card">
  <h2>From your laptop</h2>
  <p class="meta">${escapeHtml(outgoing.name)} · ${sizeLabel(outgoing.bytes.length)}</p>
  <a class="button primary" href="download" download="${escapeHtml(outgoing.name)}">
    ${outgoing.text ? 'Download text file' : 'Download file'}
  </a>
</section>`
}

function pageFor(outgoing: Parcel | null): string {
  const hasInlineText = Boolean(
    outgoing?.text && Buffer.from(outgoing.bytes).toString('utf8').length <= inlineTextLimit
  )
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0a0b0c">
<title>Notch transfer</title>
<style>${styles}</style>
<main>
  <header>
    <span class="eyebrow">Notch transfer</span>
    <h1>Same Wi-Fi.<br>Nothing uploaded.</h1>
  </header>

  ${fromLaptop(outgoing)}

  <section class="card">
    <h2>Send to laptop</h2>
    <div class="stack">
      <label class="file" id="file-label">
        <input id="file" type="file">
        <span id="file-name">Tap to choose a file</span>
      </label>
      <button class="primary" id="upload" type="button" disabled>Send file</button>
      <div class="divider">or</div>
      <textarea id="note" placeholder="Type or paste text here…" aria-label="Text to send"></textarea>
      <button class="primary" id="send" type="button" disabled>Send text</button>
    </div>
  </section>

  <p class="status" id="msg" role="status"></p>
  <footer>The link works for five minutes.<br>Phone and laptop must be on the same Wi-Fi — it will not work over mobile data or another network.</footer>
</main>
<script>
(function () {
  var msg = document.getElementById('msg')
  var file = document.getElementById('file')
  var label = document.getElementById('file-label')
  var fileName = document.getElementById('file-name')
  var upload = document.getElementById('upload')
  var note = document.getElementById('note')
  var send = document.getElementById('send')

  function say(text, isError) {
    msg.textContent = text
    msg.className = isError ? 'status is-error' : 'status'
  }

  file.addEventListener('change', function () {
    var picked = file.files && file.files[0]
    fileName.textContent = picked ? picked.name + ' · ' + Math.max(1, Math.round(picked.size / 1024)) + ' KB' : 'Tap to choose a file'
    label.className = picked ? 'file has-file' : 'file'
    upload.disabled = !picked
  })

  note.addEventListener('input', function () {
    send.disabled = !note.value.trim()
  })

  function put(body, name, kind) {
    say(kind === 'text' ? 'Sending text…' : 'Sending file…')
    fetch('receive', {
      method: 'POST',
      headers: { 'X-Notch-Name': encodeURIComponent(name), 'X-Notch-Kind': kind },
      body: body
    }).then(function (res) {
      if (res.ok) {
        say('Sent. Finish on the laptop.')
        upload.disabled = true
        send.disabled = true
        if (kind === 'text') note.value = ''
        return
      }
      return res.text().then(function (text) {
        throw new Error(text || 'Could not send that.')
      })
    }).catch(function (error) {
      say(error.message || 'Could not send that.', true)
    })
  }

  upload.addEventListener('click', function () {
    var picked = file.files && file.files[0]
    if (!picked) return say('Choose a file first.', true)
    put(picked, picked.name, 'file')
  })

  send.addEventListener('click', function () {
    var text = note.value
    if (!text.trim()) return say('Type something first.', true)
    put(text, 'note.txt', 'text')
  })

  var copy = document.getElementById('copy')
  var outgoing = document.getElementById('outgoing')
  if (copy && outgoing) {
    copy.addEventListener('click', function () {
      var text = outgoing.textContent
      var scratch = document.createElement('textarea')
      scratch.value = text
      scratch.setAttribute('readonly', '')
      scratch.style.position = 'fixed'
      scratch.style.top = '-1000px'
      scratch.style.opacity = '0'
      document.body.appendChild(scratch)
      scratch.select()
      scratch.setSelectionRange(0, text.length)
      var ok = false
      try { ok = document.execCommand('copy') } catch (e) { ok = false }
      scratch.remove()
      if (ok) say('Copied to your clipboard.')
      else say('Press and hold the text to copy it.', true)
    })
  }
})()
</script>
</html>`
}

export async function startTransfer(host: string, outgoing: Parcel | null) {
  if (outgoing && outgoing.bytes.length > limit) throw new Error('Choose a file up to 16 MB.')
  const token = randomBytes(24).toString('hex')
  let received: Parcel | null = null
  let uploading = false
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    const route = req.url
    const base = '/' + token + '/'
    if (!route?.startsWith(base)) {
      res.writeHead(404).end()
      return
    }
    if (req.method === 'GET' && route === base) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(pageFor(outgoing))
    } else if (req.method === 'GET' && route === base + 'download' && outgoing) {
      res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(outgoing.name))
      res.setHeader('Content-Type', outgoing.text ? 'text/plain; charset=utf-8' : 'application/octet-stream')
      res.end(outgoing.bytes)
    } else if (req.method === 'POST' && route === base + 'receive' && typeof req.headers['x-notch-name'] === 'string') {
      if (received || uploading) {
        res.writeHead(409).end('Collect the previous item on the laptop first.')
        return
      }
      uploading = true
      req.setTimeout(30_000, () => {
        req.destroy()
      })
      try {
        const name =
          decodeURIComponent(req.headers['x-notch-name'])
            .split(/[/\\]/)
            .pop()
            ?.replace(/[<>:"|?*\x00-\x1f]/g, '_')
            .slice(0, 120) || 'received'
        const parts: Buffer[] = []
        let size = 0
        for await (const part of req) {
          size += part.length
          if (size > limit) {
            res.setHeader('Connection', 'close')
            res.writeHead(413).end('Maximum 16 MB', () => req.destroy())
            return
          }
          parts.push(part)
        }
        received = { name, bytes: Buffer.concat(parts), text: req.headers['x-notch-kind'] === 'text' }
        res.writeHead(201).end()
      } catch {
        if (!res.headersSent) res.writeHead(400).end()
      } finally {
        uploading = false
      }
    } else {
      res.writeHead(404).end('No item available.')
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  server.on('error', () => undefined)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not open transfer')
  const url = 'http://' + host + ':' + address.port + '/' + token + '/'
  const stop = () => {
    server.close()
    server.closeAllConnections()
    clearTimeout(timer)
  }
  const expires = Date.now() + 300000
  const timer = setTimeout(stop, 300000)
  return {
    url,
    expires,
    stop,
    peek: () => received,
    collected: (item: Parcel) => {
      if (item === received) received = null
    }
  }
}

export function phoneHost() {
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses || [])
      .filter(
        (a) =>
          a.family === 'IPv4' &&
          !a.internal &&
          /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)
      )
      .map((a) => ({ name, address: a.address }))
  )
  const host = candidates.find((a) => /wi-?fi|wlan/i.test(a.name)) || candidates[0]
  if (!host) throw new Error('Connect your laptop to the same Wi-Fi as your phone.')
  return host.address
}
export function qrImage(url: string, appPath: string) {
  const QR = createRequire(join(appPath, 'package.json'))('./resources/QRCode')
  const qr = new QR(6, 1)
  qr.addData(url)
  qr.make()
  const paths: string[] = []
  for (let y = 0; y < qr.moduleCount; y++)
    for (let x = 0; x < qr.moduleCount; x++) if (qr.isDark(y, x)) paths.push(`M${x + 4} ${y + 4}h1v1h-1z`)
  return (
    'data:image/svg+xml;base64,' +
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${qr.moduleCount + 8} ${qr.moduleCount + 8}"><rect width="100%" height="100%" fill="white"/><path d="${paths.join('')}"/></svg>`
    ).toString('base64')
  )
}
