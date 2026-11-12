import {
  ArrowUpRight,
  Bell,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  FolderOpen,
  Info,
  Keyboard,
  Loader2,
  LogOut,
  Music2,
  NotebookPen,
  Palette,
  PanelTop,
  Power,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles
} from 'lucide-react'
import { motion } from 'framer-motion'
import {
  useEffect,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { Accent, NotchPosition, NotchStyle } from '../../../shared/types'
import { useApp } from '../state/AppContext'
import { useMedia } from '../state/MediaContext'
import { useVaultPicker } from '../hooks/useVaultPicker'
import { ACCENTS } from '../lib/theme'
import { formatTime } from '../lib/time'

type Section = 'appearance' | 'notch' | 'obsidian' | 'ai' | 'spotify' | 'about'

const SECTIONS: { id: Section; label: string; icon: typeof Palette }[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'notch', label: 'Notch', icon: PanelTop },
  { id: 'obsidian', label: 'Notes', icon: NotebookPen },
  { id: 'ai', label: 'AI', icon: Sparkles },
  { id: 'spotify', label: 'Spotify', icon: Music2 },
  { id: 'about', label: 'About', icon: Info }
]

function positionLabel(position: NotchPosition): string {
  const vertical = position.y <= 0.25 ? 'Top' : position.y >= 0.75 ? 'Bottom' : 'Middle'
  const horizontal = position.x <= 0.25 ? 'left' : position.x >= 0.75 ? 'right' : 'center'
  if (vertical === 'Middle' && horizontal === 'center') return 'Center'
  return `${vertical} ${horizontal}`
}

const NOTCH_STYLES: { id: NotchStyle; label: string; description: string }[] = [
  { id: 'full', label: 'Full', description: 'Art, track, timer, sessions.' },
  { id: 'compact', label: 'Compact', description: 'Art, track and live badges.' },
  { id: 'minimal', label: 'Notch', description: 'Bare tab, subtle play dots.' },
  { id: 'pill', label: 'Pill', description: 'Floating pill with track info.' },
  { id: 'pill-tiny', label: 'Pill tiny', description: 'Bare, extra small.' },
  { id: 'notch-wide', label: 'Notch wide', description: 'Bare, wide tab.' },
  { id: 'notch-micro', label: 'Notch micro', description: 'Bare, extra tiny.' }
]

function Toggle({
  checked,
  onChange,
  label,
  description
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  description?: string
}) {
  return (
    <button className="setting-row toggle-row" onClick={() => onChange(!checked)} role="switch" aria-checked={checked}>
      <span className="setting-copy">
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      <span className={`switch ${checked ? 'is-on' : ''}`}>
        <motion.span animate={{ x: checked ? 16 : 0 }} transition={{ type: 'spring', stiffness: 520, damping: 32 }} />
      </span>
    </button>
  )
}

export function SettingsPage() {
  const {
    state,
    update,
    updateSettings,
    showToast,
    setPinned,
    pinned,
    setExpanded,
    setPage,
    settingsSection,
    setSettingsSection
  } = useApp()
  const { status, connecting, connect, disconnect } = useMedia()
  const { chooseVault } = useVaultPicker()
  const [version, setVersion] = useState('')
  const [aiTesting, setAiTesting] = useState(false)
  useEffect(() => {
    void window.notch.getVersion().then(setVersion)
  }, [])
  const section = settingsSection as Section
  const setSection = setSettingsSection
  const [name, setName] = useState(state.settings.userName)
  const [clientId, setClientId] = useState(state.settings.spotifyClientId)
  const [port, setPort] = useState(String(state.settings.spotifyRedirectPort))
  const [position, setPosition] = useState<NotchPosition>(
    state.settings.notchPosition || { x: 0.5, y: 0 }
  )
  const [draggingPlacement, setDraggingPlacement] = useState(false)
  const [focusMin, setFocusMin] = useState(String(state.timer.durations.focus))
  const [shortMin, setShortMin] = useState(String(state.timer.durations.short))
  const [longMin, setLongMin] = useState(String(state.timer.durations.long))
  const [copied, setCopied] = useState(false)
  const [savingSpotify, setSavingSpotify] = useState(false)
  const [showSpotifyAdvanced, setShowSpotifyAdvanced] = useState(false)

  // Keep the form in sync if state is recovered or updated from another view.
  useEffect(() => {
    setClientId(state.settings.spotifyClientId)
  }, [state.settings.spotifyClientId])
  useEffect(() => {
    setPort(String(state.settings.spotifyRedirectPort))
  }, [state.settings.spotifyRedirectPort])
  useEffect(() => {
    setName(state.settings.userName)
  }, [state.settings.userName])

  useEffect(() => {
    if (!draggingPlacement) {
      setPosition(state.settings.notchPosition || { x: 0.5, y: 0 })
    }
  }, [state.settings.notchPosition, draggingPlacement])
  const active = SECTIONS.find((item) => item.id === section) || SECTIONS[0]
  const ActiveIcon = active.icon
  const accent = ACCENTS[state.settings.accent]
  const vaultName = state.settings.vaultPath?.split(/[\\/]/).filter(Boolean).pop()
  const redirectUri = status?.redirectUri || `http://127.0.0.1:${state.settings.spotifyRedirectPort}/callback`

  const saveName = (): void => {
    updateSettings({ userName: name.trim() })
    showToast('Saved', name.trim() ? `Calling you ${name.trim()}.` : 'Name cleared.', 'success')
  }

  const saveSpotify = async (): Promise<void> => {
    setSavingSpotify(true)
    try {
      const cleanPort = Math.max(1024, Math.min(65535, Number(port) || 43821))
      setPort(String(cleanPort))
      await window.notch.setState({
        settings: {
          spotifyClientId: clientId.trim(),
          spotifyRedirectPort: cleanPort
        }
      })
      showToast('Spotify settings saved', 'You can connect whenever you are ready.', 'success')
    } catch (error) {
      showToast('Could not save', error instanceof Error ? error.message : 'Try again.', 'error')
    } finally {
      setSavingSpotify(false)
    }
  }

  const connectSpotify = async (): Promise<void> => {
    if (!clientId.trim()) {
      showToast('Add a Client ID first', 'Paste the Client ID from your Spotify app.', 'error')
      return
    }
    await saveSpotify()
    await connect()
  }

  const copyRedirect = (): void => {
    window.notch.copyText(redirectUri)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const commitPosition = (next: NotchPosition): void => {
    setPosition(next)
    updateSettings({ notchPosition: next })
    showToast(
      'Notch position saved',
      `It will open at the ${positionLabel(next).toLowerCase()} of the screen.`,
      'success'
    )
  }

  const movePositionFromPointer = (
    event: ReactPointerEvent<HTMLDivElement>,
    commit: boolean
  ): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    const next: NotchPosition = {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height)))
    }
    setPosition(next)
    if (commit) commitPosition(next)
  }

  const startPlacementDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId)
    setDraggingPlacement(true)
    movePositionFromPointer(event, false)
  }

  const movePlacementDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!draggingPlacement) return
    movePositionFromPointer(event, false)
  }

  const endPlacementDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!draggingPlacement) return
    setDraggingPlacement(false)
    movePositionFromPointer(event, true)
  }

  const saveRhythm = (): void => {
    const focus = Math.min(180, Math.max(1, Number(focusMin) || 25))
    const short = Math.min(60, Math.max(1, Number(shortMin) || 5))
    const long = Math.min(120, Math.max(1, Number(longMin) || 15))
    const durations = { focus, short, long }
    setFocusMin(String(focus))
    setShortMin(String(short))
    setLongMin(String(long))
    update({
      timer: {
        ...state.timer,
        durations,
        running: false,
        endsAt: null,
        remaining: durations[state.timer.mode] * 60
      }
    })
    showToast('Focus lengths saved', `${focus} min focus · ${short} min short · ${long} min long`, 'success')
  }

  const testAi = async (): Promise<void> => {
    if (!state.settings.aiApiKey.trim()) {
      showToast('Add an API key first', 'Create a free key at build.nvidia.com.', 'error')
      return
    }
    setAiTesting(true)
    try {
      const text = await window.notch.ai.chat([
        { role: 'user', content: 'Reply with the single word: ready' }
      ])
      showToast('NVIDIA connected', text.slice(0, 80), 'success')
    } catch (error) {
      showToast(
        'Connection failed',
        error instanceof Error ? error.message : 'Check the key and model.',
        'error'
      )
    } finally {
      setAiTesting(false)
    }
  }

  return (
    <div className="settings-page">
      <aside className="settings-rail">
        <div className="settings-rail-head">
          <span className="eyebrow">Preferences</span>
          <h2>Settings</h2>
          <p>Make the notch feel like yours.</p>
        </div>
        <nav>
          {SECTIONS.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={`settings-nav ${section === item.id ? 'is-active' : ''}`}
                onClick={() => setSection(item.id)}
              >
                {section === item.id && (
                  <motion.span layoutId="settings-active" className="settings-nav-bg" transition={{ type: 'spring', stiffness: 430, damping: 34 }} />
                )}
                <Icon size={14} />
                {item.label}
              </button>
            )
          })}
        </nav>
        <div className="settings-rail-foot">
          <span className="status-dot online" />
          Notch {version}
        </div>
      </aside>

      <main className="settings-main">
        <motion.div
          key={section}
          initial={{ opacity: 0, y: 7 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          className="settings-content"
        >
          <div className="settings-title">
            <span className="eyebrow"><ActiveIcon size={12} /> {active.label}</span>
            <h1>
              {section === 'appearance' && 'A little more you.'}
              {section === 'notch' && 'Tune the notch.'}
              {section === 'obsidian' && 'Your notes, connected.'}
          {section === 'ai' && 'Notes, with a little help.'}
              {section === 'spotify' && 'Let the music in.'}
              {section === 'about' && 'Small app, big flow.'}
            </h1>
          </div>

          {section === 'appearance' && (
            <div className="settings-sections">
              <section className="setting-group">
                <div className="setting-group-head">
                  <h3>Accent</h3>
                  <p>The thread of color across timer, tasks and controls.</p>
                </div>
                <div className="accent-picker">
                  {(Object.keys(ACCENTS) as Accent[]).map((key) => {
                    const value = ACCENTS[key]
                    return (
                      <button
                        key={key}
                        className={`accent-swatch ${state.settings.accent === key ? 'is-active' : ''}`}
                        onClick={() => updateSettings({ accent: key })}
                        title={value.label}
                      >
                        <span style={{ background: value.color }} />
                        <small>{value.label}</small>
                        {state.settings.accent === key && <Check size={11} />}
                      </button>
                    )
                  })}
                </div>
                <div className="accent-preview" style={{ '--preview-accent': accent.color } as CSSProperties}>
                  <div className="preview-notch">
                    <span className="preview-dot" />
                    <span className="preview-lines">
                      <i /><i />
                    </span>
                    <span className="preview-time">24:18</span>
                  </div>
                  <div className="preview-caption">
                    <span>Live preview</span>
                    <strong>{accent.label} mood</strong>
                  </div>
                </div>
              </section>

              <section className="setting-group">
                <div className="setting-group-head">
                  <h3>Personal</h3>
                  <p>A name for the small moments.</p>
                </div>
                <label className="setting-field">
                  <span>What should Notch call you?</span>
                  <div className="inline-field">
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Your name"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') saveName()
                      }}
                    />
                    <button className="soft-button compact" onClick={saveName}>
                      <Save size={12} /> Save
                    </button>
                  </div>
                </label>
              </section>
            </div>
          )}

          {section === 'notch' && (
            <div className="settings-sections">
              <section className="setting-group">
                <div className="setting-group-head">
                  <h3>Style</h3>
                  <p>Pick how the collapsed notch looks.</p>
                </div>
                <div className="notch-style-grid">
                  {NOTCH_STYLES.map((style) => (
                    <button
                      key={style.id}
                      className={`notch-style-card ${
                        state.settings.notchStyle === style.id ? 'is-active' : ''
                      }`}
                      onClick={() => updateSettings({ notchStyle: style.id })}
                    >
                      <span className="notch-style-stage">
                        <span className={`notch-style-bar bar-${style.id}`}>
                          {style.id === 'minimal' ||
                          style.id === 'pill-tiny' ||
                          style.id === 'notch-wide' ||
                          style.id === 'notch-micro' ? (
                            <span className="preview-dots">
                              <i />
                              <i />
                              <i />
                            </span>
                          ) : (
                            <>
                              <span className="preview-art" />
                              <span className="preview-lines">
                                <i />
                                <i />
                              </span>
                              {style.id === 'full' && <span className="preview-badge" />}
                            </>
                          )}
                        </span>
                      </span>
                      <strong>{style.label}</strong>
                      <small>{style.description}</small>
                    </button>
                  ))}
                </div>
              </section>
              <section className="setting-group">
                <div className="setting-group-head">
                  <h3>Placement</h3>
                  <p>Drag the notch anywhere on the screen map.</p>
                </div>
                <div
                  className={`placement-map ${draggingPlacement ? 'is-dragging' : ''}`}
                  onPointerDown={startPlacementDrag}
                  onPointerMove={movePlacementDrag}
                  onPointerUp={endPlacementDrag}
                  onPointerCancel={() => setDraggingPlacement(false)}
                  role="application"
                  aria-label="Notch placement map. Drag to choose where the notch sits."
                >
                  <span className="placement-map-grid" aria-hidden="true" />
                  <span
                    className="placement-preview"
                    style={{
                      left: `calc(${position.x} * (100% - 58px))`,
                      top: `calc(${position.y} * (100% - 20px))`
                    }}
                  >
                    <i />
                    <i />
                    <em />
                  </span>
                  <span className="placement-map-caption">{positionLabel(position)}</span>
                </div>
                <div className="placement-footer">
                  <span>Saved automatically. The notch reopens in this spot.</span>
                  <div className="placement-buttons">
                    <button
                      className="soft-button compact"
                      onClick={() => commitPosition({ x: 0.5, y: 0 })}
                    >
                      Reset
                    </button>
                    <button
                      className="soft-button compact"
                      onClick={() => setExpanded(false)}
                      title="Collapse the notch to see it in its new position"
                    >
                      Preview
                    </button>
                  </div>
                </div>
              </section>
              <section className="setting-group">
                <div className="setting-group-head">
                  <h3>Behavior</h3>
                  <p>How the notch opens, sits and stays out of the way.</p>
                </div>
                <Toggle
                  checked={state.settings.pinOnOpen}
                  onChange={setPinned}
                  label="Keep the notch pinned"
                  description="Stop it collapsing when the pointer leaves."
                />
                <Toggle
                  checked={state.settings.launchAtLogin}
                  onChange={(value) => updateSettings({ launchAtLogin: value })}
                  label="Launch at login"
                  description="Have the notch waiting after you sign in."
                />
                <Toggle
                  checked={state.settings.notifications}
                  onChange={(value) => updateSettings({ notifications: value })}
                  label="Reminder notifications"
                  description="System alerts for tasks and completed focus sessions."
                />
                <div className="setting-row">
                  <span className="setting-copy">
                    <strong>Open with</strong>
                    <small>Hover over the tab, or open it only when you click.</small>
                  </span>
                  <select
                    className="setting-select"
                    value={state.settings.openTrigger}
                    onChange={(event) =>
                      updateSettings({ openTrigger: event.target.value as 'hover' | 'click' })
                    }
                  >
                    <option value="hover">Hover</option>
                    <option value="click">Click</option>
                  </select>
                </div>
                <div className="setting-row">
                  <span className="setting-copy">
                    <strong>Open delay</strong>
                    <small>
                      {state.settings.openTrigger === 'click'
                        ? 'Only used when opening on hover.'
                        : 'How long to hover before the notch blooms.'}
                    </small>
                  </span>
                  <select
                    className="setting-select"
                    value={state.settings.hoverDelay}
                    disabled={state.settings.openTrigger === 'click'}
                    onChange={(event) => updateSettings({ hoverDelay: Number(event.target.value) })}
                  >
                    <option value={0}>Instant</option>
                    <option value={100}>100 ms</option>
                    <option value={140}>140 ms</option>
                    <option value={200}>200 ms</option>
                    <option value={400}>400 ms</option>
                  </select>
                </div>
              </section>
              <section className="setting-group">
                <div className="setting-group-head">
                  <h3>Shortcut</h3>
                  <p>The notch is always one keystroke away.</p>
                </div>
                <div className="shortcut-card">
                  <span><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>Space</kbd></span>
                  <strong>Toggle the notch</strong>
                </div>
              </section>
              <section className="setting-group">
                <div className="setting-group-head">
                  <h3>Focus lengths</h3>
                  <p>Set the three timer presets to match the way you work.</p>
                </div>
                <div className="number-grid three">
                  <label>
                    <span>Focus (min)</span>
                    <input type="number" min={1} max={180} value={focusMin} onChange={(event) => setFocusMin(event.target.value)} />
                  </label>
                  <label>
                    <span>Short break (min)</span>
                    <input type="number" min={1} max={60} value={shortMin} onChange={(event) => setShortMin(event.target.value)} />
                  </label>
                  <label>
                    <span>Long break (min)</span>
                    <input type="number" min={1} max={120} value={longMin} onChange={(event) => setLongMin(event.target.value)} />
                  </label>
                </div>
                <div className="button-row">
                  <button className="soft-button" onClick={saveRhythm}>
                    <Save size={13} /> Save focus lengths
                  </button>
                  <span className="settings-note">Saving resets the timer to the new focus length.</span>
                </div>
              </section>
            </div>
          )}

          {section === 'obsidian' && (
            <div className="settings-sections">
              <section className="setting-group">
                <div className="setting-group-head">
                  <h3>Notes folder</h3>
                  <p>Notch edits your local Markdown files directly. No sync layer, no account.</p>
                </div>
                {state.settings.vaultPath ? (
                  <div className="vault-connected">
                    <span className="vault-avatar large">{vaultName?.slice(0, 1).toUpperCase()}</span>
                    <div className="vault-connected-copy">
                      <strong>{vaultName}</strong>
                      <span>{state.settings.vaultPath}</span>
                    </div>
                    <span className="connected-pill"><ShieldCheck size={11} /> Connected</span>
                  </div>
                ) : (
                  <div className="vault-disconnected">
                    <FolderOpen size={22} />
                    <div>
                      <strong>No folder connected</strong>
                      <span>Choose the folder that holds your notes, folders and attachments.</span>
                    </div>
                  </div>
                )}
                <div className="button-row">
                  <button className="primary-button" onClick={() => void chooseVault()}>
                    <FolderOpen size={14} />
                    {state.settings.vaultPath ? 'Change folder' : 'Open folder'}
                  </button>
                  {state.settings.vaultPath && (
                    <>
                      <button className="soft-button" onClick={() => void window.notch.obsidian.reveal(state.settings.vaultPath!, null)}>
                        <ExternalLink size={13} /> Show in Explorer
                      </button>
                      <button className="soft-button" onClick={() => setPage('notes')}>
                        <NotebookPen size={13} /> Open notes
                      </button>
                    </>
                  )}
                </div>
              </section>
              <section className="setting-group">
                <div className="setting-group-head">
                  <h3>What you can do</h3>
                </div>
                <div className="feature-grid">
                  <div><NotebookPen size={14} /><strong>Read & edit</strong><span>Markdown notes with autosave and preview.</span></div>
                  <div><Sparkles size={14} /><strong>Create</strong><span>Notes and folders anywhere inside it.</span></div>
                  <div><ArrowUpRight size={14} /><strong>Open elsewhere</strong><span>Open any file in your default app.</span></div>
                  <div><ShieldCheck size={14} /><strong>Stay local</strong><span>Notes stay on this machine unless you use Enhance.</span></div>
                </div>
              </section>
            </div>
          )}

          {section === 'ai' && (
            <div className="settings-sections">
              <section className="setting-group">
                <div className="setting-group-head">
                  <h3>NVIDIA API</h3>
                  <p>Free hosted models from build.nvidia.com. The key stays on this machine.</p>
                </div>
                <div className="setting-row">
                  <span className="setting-copy">
                    <strong>API key</strong>
                    <small>Create a free key at build.nvidia.com and paste it here.</small>
                  </span>
                  <input
                    className="setting-input"
                    type="password"
                    value={state.settings.aiApiKey}
                    onChange={(event) => updateSettings({ aiApiKey: event.target.value })}
                    placeholder="nvapi-..."
                    spellCheck={false}
                    autoComplete="off"
                  />
                </div>
                <div className="setting-row">
                  <span className="setting-copy">
                    <strong>Model</strong>
                    <small>The model id from the NVIDIA catalog.</small>
                  </span>
                  <input
                    className="setting-input"
                    value={state.settings.aiModel}
                    onChange={(event) => updateSettings({ aiModel: event.target.value })}
                    placeholder="nvidia/llama-3.1-nemotron-70b-instruct"
                    spellCheck={false}
                  />
                </div>
                <div className="button-row">
                  <button
                    className="soft-button"
                    onClick={() => window.notch.openExternal('https://build.nvidia.com/')}
                  >
                    <ExternalLink size={13} /> Get a free key
                  </button>
                  <button className="primary-button" onClick={() => void testAi()} disabled={aiTesting}>
                    {aiTesting ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                    {aiTesting ? 'Testing…' : 'Test connection'}
                  </button>
                </div>
                <p className="settings-note">
                  Only the note you are editing is sent, and only when you press Enhance or send a
                  message.
                </p>
              </section>
            </div>
          )}

          {section === 'spotify' && (
            <div className="settings-sections">
              <section className="setting-group">
                <div className="setting-group-head">
                  <h3>Connection</h3>
                  <p>
                    {status?.connected
                      ? 'Full Spotify control is connected.'
                      : status?.localAvailable
                        ? 'Spotify Desktop is detected — no setup needed for basic controls.'
                        : 'Open Spotify on this computer to use the local session.'}
                  </p>
                </div>
                {status?.connected ? (
                  <div className="spotify-connected">
                    {status.profile?.image ? (
                      <img src={status.profile.image} alt="" />
                    ) : (
                      <span className="profile-fallback">{status.profile?.name?.slice(0, 1) || 'S'}</span>
                    )}
                    <div>
                      <strong>{status.profile?.name || 'Spotify listener'}</strong>
                      <span>{status.profile?.product === 'premium' ? 'Premium' : 'Free'} account · connected</span>
                    </div>
                    <button className="soft-button compact" onClick={() => void disconnect()}>
                      <LogOut size={12} /> Disconnect
                    </button>
                  </div>
                ) : status?.localAvailable ? (
                  <>
                    <div className="spotify-local-connected">
                      <span className="local-spotify-icon"><Music2 size={18} /></span>
                      <div>
                        <strong>Spotify Desktop</strong>
                        <span>
                          {status.localTitle
                            ? `${status.localTitle}${status.localArtist ? ` · ${status.localArtist}` : ''}`
                            : 'Connected through the Windows media session'}
                        </span>
                      </div>
                      <span className="connected-pill"><ShieldCheck size={11} /> Local</span>
                    </div>
                    <p className="settings-note">
                      <ShieldCheck size={12} /> Current track, play/pause, previous/next and seek work
                      without a Spotify app. Queue, volume, shuffle and repeat need the optional full
                      connection.
                    </p>
                    <div className="button-row">
                      <button className="primary-button" onClick={() => setShowSpotifyAdvanced(true)}>
                        <SlidersHorizontal size={13} /> Unlock queue & full controls
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="spotify-not-connected">
                    <Music2 size={20} />
                    <div>
                      <strong>No Spotify session detected</strong>
                      <span>Open Spotify, then the notch can control it through Windows. Full queue controls are optional below.</span>
                    </div>
                  </div>
                )}
              </section>
              {(showSpotifyAdvanced || status?.connected || !status?.localAvailable) && (
                <section className="setting-group">
                  <div className="setting-group-head">
                    <h3>{status?.localAvailable && !status?.connected ? 'Optional: full Spotify connection' : 'App credentials'}</h3>
                    <p>
                      {status?.localAvailable && !status?.connected
                        ? 'Adds queue, next track, volume, shuffle and repeat.'
                        : 'Create an app at '}
                      {status?.localAvailable && !status?.connected ? null : (
                        <button className="inline-link" onClick={() => window.notch.openExternal('https://developer.spotify.com/dashboard')}>
                          developer.spotify.com <ArrowUpRight size={10} />
                        </button>
                      )}
                    </p>
                  </div>
                  <label className="setting-field">
                    <span>Client ID</span>
                    <input
                      value={clientId}
                      onChange={(event) => setClientId(event.target.value)}
                      placeholder="Paste your Spotify Client ID"
                    />
                  </label>
                  <div className="setting-field">
                    <span>Redirect URI <small>add this to your Spotify app</small></span>
                    <button className="redirect-copy" onClick={copyRedirect}>
                      <code>{redirectUri}</code>
                      {copied ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  </div>
                  <label className="setting-field narrow">
                    <span>Loopback port</span>
                    <input value={port} onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, ''))} />
                  </label>
                  <div className="button-row">
                    <button className="soft-button" onClick={() => void saveSpotify()} disabled={savingSpotify}>
                      {savingSpotify ? <Loader2 size={13} className="spin" /> : <Save size={13} />}
                      Save credentials
                    </button>
                    <button className="primary-button" onClick={() => void connectSpotify()} disabled={connecting}>
                      {connecting ? <Loader2 size={14} className="spin" /> : <Music2 size={14} />}
                      {connecting ? 'Waiting for browser…' : status?.connected ? 'Reconnect Spotify' : 'Connect Spotify'}
                    </button>
                  </div>
                  <p className="settings-note">
                    <ShieldCheck size={12} /> Notch never asks for a client secret. Playback control requires Spotify Premium.
                  </p>
                </section>
              )}
            </div>
          )}

          {section === 'about' && (
            <div className="settings-sections">
              <section className="setting-group about-card">
                <div className="about-mark">
                  <span className="about-notch" />
                  <span className="about-dot" />
                </div>
                <div>
                  <span className="eyebrow">Notch {version}</span>
                  <h3>A calmer top of screen.</h3>
                  <p>
                    Notes, music, focus, coding sessions and the day ahead — folded into the
                    place you already look. Built with Electron and a lot of care for the small
                    things.
                  </p>
                </div>
              </section>
              <section className="setting-group">
                <div className="setting-group-head">
                  <h3>Keyboard</h3>
                </div>
                <div className="shortcut-list">
                  <div><span><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>Space</kbd></span><strong>Toggle notch</strong></div>
                  <div><span><kbd>Esc</kbd></span><strong>Collapse</strong></div>
                  <div><span><kbd>1</kbd>–<kbd>7</kbd></span><strong>Switch sections</strong></div>
                  <div><span><kbd>Ctrl</kbd><kbd>K</kbd></span><strong>Search notes</strong></div>
                  <div><span><kbd>Ctrl</kbd><kbd>S</kbd></span><strong>Save note</strong></div>
                </div>
              </section>
              <section className="setting-group">
                <div className="setting-group-head">
                  <h3>Links</h3>
                </div>
                <div className="button-row">
                  <button className="soft-button" onClick={() => window.notch.openExternal('https://open.spotify.com')}>
                    <ExternalLink size={13} /> Spotify
                  </button>
                  <button className="soft-button danger-text" onClick={() => window.notch.quit()}>
                    <Power size={13} /> Quit Notch
                  </button>
                </div>
              </section>
            </div>
          )}
        </motion.div>
      </main>
    </div>
  )
}
