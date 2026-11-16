import { useEffect, useRef, useState } from 'react'
import { Wifi } from 'lucide-react'
import { useApp } from '../state/AppContext'

export function PhoneTransfer({
  bare = false,
  section = false,
  split = false,
}: {
  bare?: boolean
  section?: boolean
  split?: boolean
}) {
  const [session, setSession] = useState<Awaited<ReturnType<typeof window.notch.phone.status>>>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const { showToast } = useApp()

  useEffect(() => {
    let active = true
    const refresh = () =>
      window.notch.phone
        .status()
        .then((s) => {
          if (active) setSession(s)
        })
        .catch(() => {})
    void refresh()
    const timer = setInterval(refresh, 2000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])

  async function run(task: () => Promise<unknown>) {
    setBusy(true)
    try {
      await task()
      setSession(await window.notch.phone.status())
    } catch (e) {
      showToast('Phone transfer', String(e).replace(/^Error:\s*/, ''), 'error')
    } finally {
      setBusy(false)
    }
  }

  function start(options?: { clipboard?: boolean; text?: string }) {
    void run(async () => {
      const text = options?.text ?? ''
      if (text.length > 200_000) throw Error('Keep text under 200,000 characters, or send it as a file.')
      await window.notch.phone.start(null, { ...options, text })
      if (text) setDraft('')
    })
  }

  function sendFile(file: File) {
    void run(async () => {
      if (file.size > 16 * 1024 * 1024) throw Error('Maximum file size is 16 MB.')
      await window.notch.phone.start(
        { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
        {}
      )
    })
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const dropped = e.dataTransfer.files[0]
    if (!busy && !session && dropped) sendFile(dropped)
  }

  const draftForm = (
    <>
      <p className="phone-copy">
        Send a file, or type something below. Your phone scans the code and gets it.
      </p>

      <label className="phone-draft">
        <span>Text or link to send</span>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          placeholder="Paste anything here — a link, an address, a line of code."
          spellCheck={false}
        />
      </label>

      <div className="phone-actions">
        <button className="soft-button" disabled={busy || !draft.trim()} onClick={() => start({ text: draft })}>
          Send this text
        </button>
        <button className="soft-button" disabled={busy} onClick={() => start({ clipboard: true })}>
          Send clipboard
        </button>
        <button className="soft-button" disabled={busy} onClick={() => fileInput.current?.click()}>
          Send a file
        </button>
        <button className="soft-button" disabled={busy} onClick={() => start()}>
          Receive from phone
        </button>
      </div>

      <input
        ref={fileInput}
        className="phone-file-input"
        type="file"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) sendFile(file)
          e.target.value = ''
        }}
      />
    </>
  )

  // The Phone section page lays the transfer out across the whole panel: the
  // compose card on the left, the scan zone (code, steps) on the right.
  if (split) {
    return (
      <>
        <article className="phone-panel phone-compose" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          {session ? (
            <div className="phone-running">
              <span className="phone-running-dot" aria-hidden="true" />
              <p className="phone-copy">
                Transfer is running — scan the code with your phone. Files or text your phone sends
                appear here when it is done.
              </p>
              {session.received && (
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => void run(() => window.notch.phone.collect())}
                >
                  {session.received.text ? 'Copy received text' : `Save ${session.received.name}`}
                </button>
              )}
            </div>
          ) : (
            draftForm
          )}
        </article>

        <article className={`phone-panel phone-scan${session ? ' has-session' : ''}`}>
          {session ? (
            <div className="phone-session is-large">
              <img className="phone-qr is-large" src={session.qr} alt="Scan to transfer on the same Wi-Fi" />
              <p className="phone-copy">
                Scan with your phone camera. Your phone must be on the same Wi-Fi as this laptop —
                mobile data or another network will not reach it. The link lasts five minutes.
              </p>
              <div className="phone-actions">
                <button className="soft-button" disabled={busy} onClick={() => void run(() => window.notch.phone.stop())}>
                  End transfer
                </button>
              </div>
            </div>
          ) : (
            <div className="phone-scan-idle">
              <span className="phone-pill">
                <Wifi size={10} aria-hidden="true" />
                Same Wi-Fi only
              </span>
              <ol className="phone-steps">
                <li>Pick a file or this clipboard, or wait for your phone to send.</li>
                <li>Scan the code with your phone camera.</li>
                <li>The link expires after five minutes.</li>
              </ol>
              <div className="phone-mock" aria-hidden="true">
                <div className="phone-mock-screen">
                  <span className="phone-mock-notch" />
                  <span className="phone-mock-line is-accent" />
                  <span className="phone-mock-line" />
                  <span className="phone-mock-line is-short" />
                  <span className="phone-mock-chip" />
                </div>
              </div>
            </div>
          )}
        </article>
      </>
    )
  }

  return (
    <article
      className={bare ? `phone-transfer is-bare${section ? ' is-section' : ''}` : 'card phone-transfer'}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {!bare && (
        <div className="card-heading">
          <div>
            <span className="eyebrow">Same Wi-Fi</span>
            <h2 className="card-title">Phone transfer</h2>
          </div>
        </div>
      )}

      {session ? (
        <div className="phone-session">
          <img className="phone-qr" src={session.qr} alt="Scan to transfer on the same Wi-Fi" />
          <div className="phone-copy">
            <p>Scan with your phone camera. Your phone must be on the same Wi-Fi as this laptop — mobile data or another network will not reach it. The link lasts five minutes.</p>
            <div className="phone-actions">
              {session.received && (
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => void run(() => window.notch.phone.collect())}
                >
                  {session.received.text ? 'Copy received text' : `Save ${session.received.name}`}
                </button>
              )}
              <button className="soft-button" disabled={busy} onClick={() => void run(() => window.notch.phone.stop())}>
                End transfer
              </button>
            </div>
          </div>
        </div>
      ) : (
        draftForm
      )}
    </article>
  )
}
