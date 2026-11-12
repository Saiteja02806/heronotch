import DOMPurify from 'dompurify'
import { marked } from 'marked'
import {
  Bold,
  Check,
  CheckSquare,
  ChevronRight,
  Code2,
  Eye,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Heading2,
  Italic,
  Link2,
  List,
  ListTree,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Sparkles,
  SquarePen,
  Trash2,
  Wand2,
  X
} from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import type { NoteSearchResult, VaultNode } from '../../../shared/types'
import { useApp } from '../state/AppContext'
import { useVaultPicker } from '../hooks/useVaultPicker'
import { Modal } from '../components/Modal'
import { formatDateShort } from '../lib/time'

interface EntryDialog {
  mode: 'note' | 'folder' | 'rename'
  targetPath?: string
  targetName?: string
  parent?: string
}

function flattenFolders(nodes: VaultNode[], output: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type === 'folder') {
      output.push(node.path)
      flattenFolders(node.children || [], output)
    }
  }
  return output
}

function countNotes(nodes: VaultNode[]): number {
  let total = 0
  for (const node of nodes) {
    if (node.type === 'folder') total += countNotes(node.children || [])
    else if (node.ext === '.md' || node.ext === '.markdown') total += 1
  }
  return total
}

interface AiPanelMessage {
  role: 'user' | 'assistant'
  content: string
  replace?: boolean
}

const AI_ACTIONS = [
  {
    label: 'Improve',
    prompt:
      'Rewrite the note to be clearer and more natural. Keep the meaning, tone and Markdown structure. Return only the rewritten note.',
    replace: true
  },
  {
    label: 'Summarize',
    prompt: 'Summarize the note in 4–6 concise bullet points.'
  },
  {
    label: 'Shorten',
    prompt:
      'Rewrite the note more concisely without losing important details. Return only the rewritten note.',
    replace: true
  },
  {
    label: 'Fix grammar',
    prompt:
      'Fix grammar, spelling and punctuation. Keep the wording as close to the original as possible. Return only the corrected note.',
    replace: true
  },
  {
    label: 'Continue',
    prompt: 'Continue the note naturally from where it ends. Return only the new text, not the existing text.'
  }
]

export function NotesPage() {
  const {
    state,
    update,
    updateSettings,
    showToast,
    pendingNote,
    setPendingNote,
    vaultRevision,
    openSettings
  } = useApp()
  const { chooseVault } = useVaultPicker()
  const vaultPath = state.settings.vaultPath

  const [tree, setTree] = useState<VaultNode[]>([])
  const [loadingTree, setLoadingTree] = useState(false)
  const [treeReady, setTreeReady] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<NoteSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [loadingNote, setLoadingNote] = useState(false)
  const [preview, setPreview] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [entryDialog, setEntryDialog] = useState<EntryDialog | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  const [dragPath, setDragPath] = useState<string | null>(null)
  const [rootDrop, setRootDrop] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiMessages, setAiMessages] = useState<AiPanelMessage[]>([])
  const [aiInput, setAiInput] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const aiEndRef = useRef<HTMLDivElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const titleSkipCommit = useRef(false)
  const currentFolder = selectedPath?.split('/').slice(0, -1).join('/') || ''
  const searchRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dirtyRef = useRef(false)
  const contentRef = useRef('')
  const pathRef = useRef<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previousVault = useRef<string | null | undefined>(undefined)
  const vaultRef = useRef<string | null>(vaultPath)

  const loadTree = useCallback(
    async (silent = false) => {
      if (!vaultPath) {
        setTree([])
        return
      }
      if (!silent) setLoadingTree(true)
      try {
        const next = await window.notch.obsidian.tree(vaultPath)
        setTree(next)
        setTreeReady(true)
      } catch (error) {
        if (!silent) {
          showToast('Folder unavailable', error instanceof Error ? error.message : 'Could not read the folder.', 'error')
        }
      } finally {
        setLoadingTree(false)
      }
    },
    [vaultPath, showToast]
  )

  useEffect(() => {
    void loadTree()
  }, [loadTree, vaultRevision])

  useEffect(() => {
    const previous = previousVault.current
    if (previous === undefined) {
      previousVault.current = vaultPath
      return
    }
    if (previous === vaultPath) return
    if (previous && dirtyRef.current && pathRef.current) {
      void window.notch.obsidian.write(previous, pathRef.current, contentRef.current)
    }
    previousVault.current = vaultPath
    pathRef.current = null
    dirtyRef.current = false
    contentRef.current = ''
    setContent('')
    setSelectedPath(null)
    setTree([])
    setTreeReady(false)
    setSaveState('idle')
  }, [vaultPath])

  useEffect(() => {
    if (!vaultPath || !selectedPath || dirtyRef.current) return
    let alive = true
    void window.notch.obsidian
      .read(vaultPath, selectedPath)
      .then((text) => {
        if (!alive || dirtyRef.current || text === contentRef.current) return
        contentRef.current = text
        setContent(text)
        setSaveState('saved')
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [vaultRevision, vaultPath, selectedPath])

  useEffect(() => {
    if (!vaultPath || !selectedPath) return
    const parts = selectedPath.split('/')
    if (parts.length <= 1) return
    setExpanded((current) => {
      const next = new Set(current)
      for (let index = 1; index < parts.length; index += 1) {
        next.add(parts.slice(0, index).join('/'))
      }
      return next
    })
  }, [vaultPath, selectedPath])

  useEffect(() => {
    if (pendingNote === null) return
    if (pendingNote === '') {
      void createNoteNow()
    } else {
      void selectFile(pendingNote)
    }
    setPendingNote(null)
    // selectFile is stable through refs; pendingNote is an intentional one-shot command.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNote])

  useEffect(() => {
    if (!aiOpen) return
    aiEndRef.current?.scrollIntoView({ block: 'end' })
  }, [aiMessages, aiBusy, aiOpen])

  useEffect(() => {
    // A conversation belongs to the note it was started on.
    setAiMessages([])
    setAiInput('')
  }, [selectedPath])

  const saveNow = useCallback(async (): Promise<void> => {
    const path = pathRef.current
    if (!path || !vaultPath || !dirtyRef.current) return
    setSaveState('saving')
    try {
      await window.notch.obsidian.write(vaultPath, path, contentRef.current)
      dirtyRef.current = false
      setSaveState('saved')
    } catch (error) {
      setSaveState('error')
      showToast('Note not saved', error instanceof Error ? error.message : 'Could not write the file.', 'error')
    }
  }, [vaultPath, showToast])

  const selectFile = useCallback(
    async (path: string) => {
      if (!vaultPath) return
      if (path === pathRef.current) return
      if (saveTimer.current) clearTimeout(saveTimer.current)
      await saveNow()
      setLoadingNote(true)
      setPreview(false)
      try {
        const text = await window.notch.obsidian.read(vaultPath, path)
        pathRef.current = path
        contentRef.current = text
        dirtyRef.current = false
        setContent(text)
        setSelectedPath(path)
        setSaveState('idle')
        update({ notes: { lastPath: path } })
      } catch (error) {
        showToast('Could not open note', error instanceof Error ? error.message : path, 'error')
      } finally {
        setLoadingNote(false)
      }
    },
    [vaultPath, saveNow, update, showToast]
  )

  useEffect(() => {
    if (!vaultPath || selectedPath || !treeReady) return
    const preferred = state.notes.lastPath
    const files: string[] = []
    const walk = (nodes: VaultNode[]): void => {
      for (const node of nodes) {
        if (node.type === 'folder') walk(node.children || [])
        else if (node.ext === '.md') files.push(node.path)
      }
    }
    walk(tree)
    if (preferred && files.includes(preferred)) {
      void selectFile(preferred)
      return
    }
    if (files.length) void selectFile(files[0])
  }, [tree, treeReady, vaultPath, selectedPath, selectFile, state.notes.lastPath])

  const onChangeContent = (value: string): void => {
    setContent(value)
    contentRef.current = value
    dirtyRef.current = true
    setSaveState('idle')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void saveNow(), 750)
  }

  useEffect(() => {
    vaultRef.current = vaultPath
  }, [vaultPath])

  useEffect(() => {
    const flush = (): void => {
      if (!dirtyRef.current || !pathRef.current || !vaultRef.current) return
      try {
        window.notch.obsidian.writeSync(vaultRef.current, pathRef.current, contentRef.current)
        dirtyRef.current = false
      } catch {
        // The async autosave path will surface a toast if the file is still editable.
      }
    }
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      flush()
    }
  }, [])

  useEffect(() => {
    const query = search.trim()
    if (query.length < 2 || !vaultPath) {
      setSearchResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      void window.notch.obsidian
        .search(vaultPath, query)
        .then(setSearchResults)
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false))
    }, 280)
    return () => clearTimeout(timer)
  }, [search, vaultPath])

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (saveTimer.current) clearTimeout(saveTimer.current)
        void saveNow()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saveNow])

  const folders = useMemo(() => flattenFolders(tree), [tree])
  const noteCount = useMemo(() => countNotes(tree), [tree])
  const visibleResults = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (query && searchResults.length) return searchResults
    if (!query) return []
    const local: NoteSearchResult[] = []
    const walk = (nodes: VaultNode[]): void => {
      for (const node of nodes) {
        if (node.type === 'folder') walk(node.children || [])
        else if (node.name.toLowerCase().includes(query)) {
          local.push({ path: node.path, name: node.name, snippet: node.path })
        }
      }
    }
    walk(tree)
    return local
  }, [search, searchResults, tree])

  const selectedName = selectedPath?.split('/').pop()?.replace(/\.md$/i, '') || 'Untitled'
  const displayTitle = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || selectedName
  const folderPath = selectedPath?.split('/').slice(0, -1).join(' / ')
  const words = content.trim() ? content.trim().split(/\s+/).length : 0
  const markdownHtml = useMemo(() => {
    const text = content.replace(
      /\[\[([^\]]+)\]\]/g,
      '<span class="wiki-link">$1</span>'
    )
    const raw = marked.parse(text, { gfm: true, breaks: true, async: false }) as string
    return DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] })
  }, [content])

  const applyFormat = (before: string, after = before, placeholder = 'text'): void => {
    const textarea = textareaRef.current
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = content.slice(start, end) || placeholder
    const next = `${content.slice(0, start)}${before}${selected}${after}${content.slice(end)}`
    onChangeContent(next)
    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(start + before.length, start + before.length + selected.length)
    })
  }

  const onEditorKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Tab') {
      event.preventDefault()
      const textarea = event.currentTarget
      const start = textarea.selectionStart
      const next = `${content.slice(0, start)}  ${content.slice(textarea.selectionEnd)}`
      onChangeContent(next)
      requestAnimationFrame(() => textarea.setSelectionRange(start + 2, start + 2))
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
      event.preventDefault()
      applyFormat('**')
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'i') {
      event.preventDefault()
      applyFormat('_')
    }
  }

  // The new-note button used to open a dialog asking for a name and a folder.
  // That is more ceremony than the action needs: create the file immediately
  // and open it, the same way a scratch pad behaves.
  const createNoteNow = useCallback(async (): Promise<void> => {
    if (!vaultPath) return
    const parent = selectedPath?.split('/').slice(0, -1).join('/') || ''
    for (let index = 1; index <= 50; index += 1) {
      const name = index === 1 ? 'Untitled' : `Untitled ${index}`
      try {
        const path = await window.notch.obsidian.createFile(vaultPath, parent, name)
        await loadTree(true)
        await selectFile(path)
        showToast('Note created', path, 'success')
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (message.toLowerCase().includes('already exists')) continue
        showToast(
          'Could not create note',
          message || 'Try again.',
          'error'
        )
        return
      }
    }
  }, [vaultPath, selectedPath, loadTree, selectFile, showToast])

  // Clicking the big heading edits it in place. The heading is the first `#`
  // line when the note has one, otherwise the file name; either way the note is
  // renamed to match so the sidebar, file and heading stay in sync.
  const commitTitle = async (): Promise<void> => {
    if (titleDraft === null || !vaultPath || !selectedPath) return
    const name = titleDraft.trim().replace(/[\\/:*?"<>|]/g, '').replace(/\.md$/i, '').trim()
    if (!name) {
      setTitleDraft(null)
      return
    }
    if (name === displayTitle) {
      setTitleDraft(null)
      return
    }

    const stem = selectedPath.split('/').pop()?.replace(/\.md$/i, '') || ''
    let nextPath = selectedPath
    if (name !== stem) {
      try {
        nextPath = await window.notch.obsidian.rename(vaultPath, selectedPath, name)
      } catch (error) {
        showToast(
          'Could not rename note',
          error instanceof Error ? error.message : 'Try another name.',
          'error'
        )
        setTitleDraft(null)
        return
      }
    }

    if (/^#\s+.+$/m.test(content)) {
      const updated = content.replace(/^#\s+.+$/m, `# ${name}`)
      contentRef.current = updated
      setContent(updated)
      dirtyRef.current = true
    }

    if (nextPath !== selectedPath) {
      pathRef.current = nextPath
      setSelectedPath(nextPath)
      update({ notes: { lastPath: nextPath } })
      await loadTree(true)
    }
    if (dirtyRef.current) await saveNow()
    setTitleDraft(null)
    showToast('Renamed', nextPath, 'success')
  }

  const moveNote = async (sourcePath: string, targetDirectory: string): Promise<void> => {
    if (!vaultPath) return
    const currentDirectory = sourcePath.split('/').slice(0, -1).join('/')
    if (currentDirectory === targetDirectory) return
    try {
      if (dirtyRef.current) await saveNow()
      const nextPath = await window.notch.obsidian.move(vaultPath, sourcePath, targetDirectory)
      if (selectedPath === sourcePath) {
        pathRef.current = nextPath
        setSelectedPath(nextPath)
        update({ notes: { lastPath: nextPath } })
      } else if (selectedPath?.startsWith(`${sourcePath}/`)) {
        const rebased = `${nextPath}${selectedPath.slice(sourcePath.length)}`
        pathRef.current = rebased
        setSelectedPath(rebased)
        update({ notes: { lastPath: rebased } })
      }
      await loadTree(true)
      if (targetDirectory) setExpanded((current) => new Set(current).add(targetDirectory))
      showToast('Moved', nextPath, 'success')
    } catch (error) {
      showToast('Could not move', error instanceof Error ? error.message : 'Try again.', 'error')
    }
  }

  const askAi = async (prompt: string, visible: string, replace: boolean): Promise<void> => {
    const instruction = prompt.trim()
    if (!instruction || aiBusy) return
    if (!state.settings.aiApiKey.trim()) {
      showToast('Add your NVIDIA API key', 'Settings → AI → API key.', 'error')
      return
    }
    if (replace && !content.trim()) {
      showToast('Nothing to enhance yet', 'Write something in the note first.', 'default')
      return
    }
    const userMessage: AiPanelMessage = { role: 'user', content: visible || instruction }
    setAiMessages((current) => [...current, userMessage])
    setAiInput('')
    setAiBusy(true)
    try {
      const system = [
        'You are an assistant inside a Markdown note editor called Notch.',
        'Use the note below as context. Be concise and practical.',
        'When asked to rewrite, improve, shorten or fix the note, return only the rewritten Markdown with no preamble and no code fences.',
        '',
        '<note>',
        content.slice(0, 14000),
        '</note>'
      ].join('\n')
      const history = aiMessages.slice(-6).map((message) => ({
        role: message.role,
        content: message.content
      }))
      const response = await window.notch.ai.chat([
        { role: 'system', content: system },
        ...history,
        { role: 'user', content: instruction }
      ])
      setAiMessages((current) => [...current, { role: 'assistant', content: response, replace }])
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The request failed.'
      setAiMessages((current) => [...current, { role: 'assistant', content: `⚠ ${message}` }])
      showToast('AI request failed', message, 'error')
    } finally {
      setAiBusy(false)
    }
  }

  const insertAiText = (text: string): void => {
    const textarea = textareaRef.current
    const start = textarea?.selectionStart ?? content.length
    const end = textarea?.selectionEnd ?? content.length
    onChangeContent(`${content.slice(0, start)}${text}${content.slice(end)}`)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      const position = start + text.length
      textareaRef.current?.setSelectionRange(position, position)
    })
  }

  const replaceNoteWithAi = (text: string): void => {
    onChangeContent(text)
    showToast('Note replaced', 'Review the result and edit anything that feels off.', 'success')
  }

  const submitEntry = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!vaultPath || !entryDialog) return
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') || '').trim()
    const parent = String(form.get('parent') || '')
    if (!name) return
    try {
      if (entryDialog.mode === 'note') {
        const path = await window.notch.obsidian.createFile(vaultPath, parent, name)
        await loadTree(true)
        setEntryDialog(null)
        await selectFile(path)
        showToast('Note created', path, 'success')
      } else if (entryDialog.mode === 'folder') {
        const path = await window.notch.obsidian.createFolder(vaultPath, parent, name)
        await loadTree(true)
        setExpanded((current) => new Set(current).add(path))
        setEntryDialog(null)
        showToast('Folder created', path, 'success')
      } else if (entryDialog.targetPath) {
        const nextPath = await window.notch.obsidian.rename(vaultPath, entryDialog.targetPath, name)
        if (
          selectedPath === entryDialog.targetPath ||
          selectedPath?.startsWith(`${entryDialog.targetPath}/`)
        ) {
          const rebased = `${nextPath}${selectedPath.slice(entryDialog.targetPath.length)}`
          pathRef.current = rebased
          setSelectedPath(rebased)
        }
        await loadTree(true)
        setEntryDialog(null)
        showToast('Renamed', nextPath, 'success')
      }
    } catch (error) {
      showToast('That did not work', error instanceof Error ? error.message : 'Try another name.', 'error')
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (!vaultPath || !deleteTarget) return
    try {
      await window.notch.obsidian.trash(vaultPath, deleteTarget)
      if (selectedPath === deleteTarget || selectedPath?.startsWith(`${deleteTarget}/`)) {
        pathRef.current = null
        dirtyRef.current = false
        setSelectedPath(null)
        setContent('')
      }
      setDeleteTarget(null)
      await loadTree(true)
      showToast('Moved to trash', deleteTarget, 'success')
    } catch (error) {
      showToast('Could not remove', error instanceof Error ? error.message : deleteTarget, 'error')
    }
  }

  const selectSearchResult = (path: string): void => {
    setSearch('')
    void selectFile(path)
  }

  if (!vaultPath) {
    return (
      <div className="empty-vault-page">
        <div className="empty-vault-visual" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="vault-glyph">
            <FolderOpen size={38} />
            <span className="glyph-dot" />
          </div>
          <span className="float-note note-one">ideas.md</span>
          <span className="float-note note-two">daily/11-11</span>
          <span className="float-note note-three">read later</span>
        </div>
        <span className="eyebrow">Notes, inside your notch</span>
        <h1>Your notes, one hover away.</h1>
        <p>
          Open a folder of Markdown notes to browse it, create notes and edit drafts in place.
          Nothing syncs anywhere else — Notch works directly with your files. You can create a new
          folder in the picker.
        </p>
        <button className="primary-button" onClick={() => void chooseVault()}>
          <FolderOpen size={15} />
          Open folder
        </button>
        <div className="vault-features">
          <span><FilePlus2 size={13} /> Create notes</span>
          <span><SquarePen size={13} /> Edit in place</span>
          <span><Wand2 size={13} /> Markdown preview</span>
        </div>
      </div>
    )
  }

  return (
    <div className={`notes-page ${aiOpen ? 'is-ai-open' : ''}`}>
      <aside className="notes-sidebar">
        <div className="sidebar-head">
          <div className="sidebar-vault">
            <span className="vault-avatar">{vaultPath.split(/[\\/]/).filter(Boolean).pop()?.slice(0, 1).toUpperCase()}</span>
            <div>
              <span className="eyebrow">Folder</span>
              <strong>{vaultPath.split(/[\\/]/).filter(Boolean).pop()}</strong>
            </div>
          </div>
          <div className="sidebar-actions">
            <button className="icon-button subtle" onClick={() => void loadTree()} title="Refresh folder">
              <RefreshCw size={13} className={loadingTree ? 'spin' : ''} />
            </button>
            <button className="icon-button subtle" onClick={() => void createNoteNow()} title="New note">
              <FilePlus2 size={14} />
            </button>
            <button className="icon-button subtle" onClick={() => setEntryDialog({ mode: 'folder', parent: currentFolder })} title="New folder">
              <FolderPlus size={14} />
            </button>
          </div>
        </div>

        <div className="search-box">
          <Search size={13} />
          <input
            ref={searchRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search notes…"
          />
          <kbd>Ctrl K</kbd>
        </div>

        <div className="tree-scroll">
          {search.trim() ? (
            <div className="search-results">
              <span className="tree-label">
                {searching ? 'Searching…' : `${visibleResults.length} matches`}
              </span>
              {visibleResults.map((result) => (
                <button key={result.path} className="search-result" onClick={() => selectSearchResult(result.path)}>
                  <FileText size={13} />
                  <span>
                    <strong>{result.name.replace(/\.md$/i, '')}</strong>
                    <small>{result.snippet}</small>
                  </span>
                </button>
              ))}
              {!searching && visibleResults.length === 0 && (
                <div className="tree-empty">No notes match “{search.trim()}”.</div>
              )}
            </div>
          ) : (
            <>
              <div
                className={`tree-toolbar ${dragPath ? 'is-root-target' : ''} ${rootDrop ? 'is-over' : ''}`}
                onDragOver={(event) => {
                  if (!dragPath && !event.dataTransfer.types.includes('text/plain')) return
                  event.preventDefault()
                  event.stopPropagation()
                  event.dataTransfer.dropEffect = 'move'
                  setRootDrop(true)
                }}
                onDragLeave={() => setRootDrop(false)}
                onDrop={(event) => {
                  const source = event.dataTransfer.getData('text/plain') || dragPath
                  if (!source) return
                  event.preventDefault()
                  event.stopPropagation()
                  setRootDrop(false)
                  setDragPath(null)
                  void moveNote(source, '')
                }}
              >
                <span className="tree-label">{dragPath ? 'Move to root folder' : `${noteCount} notes`}</span>
                <div className="tree-toolbar-actions">
                  <button
                    className="link-button"
                    title={folders.length > 0 && folders.every((folder) => expanded.has(folder)) ? 'Collapse folders' : 'Expand all folders'}
                    onClick={() =>
                      setExpanded(
                        folders.length > 0 && folders.every((folder) => expanded.has(folder))
                          ? new Set()
                          : new Set(folders)
                      )
                    }
                  >
                    <ListTree size={11} />
                  </button>
                  <button className="link-button" onClick={() => void createNoteNow()}>
                    <Plus size={11} /> new
                  </button>
                </div>
              </div>
              <TreeNodes
                nodes={tree}
                depth={0}
                expanded={expanded}
                selectedPath={selectedPath}
                dragPath={dragPath}
                onDragStartPath={setDragPath}
                onDragEndPath={() => setDragPath(null)}
                onMove={(source, target) => void moveNote(source, target)}
                onToggleFolder={(path) =>
                  setExpanded((current) => {
                    const next = new Set(current)
                    if (next.has(path)) next.delete(path)
                    else next.add(path)
                    return next
                  })
                }
                onSelect={(path) => void selectFile(path)}
                onRename={(node) =>
                  setEntryDialog({
                    mode: 'rename',
                    targetPath: node.path,
                    targetName: node.name,
                    parent: node.path.split('/').slice(0, -1).join('/')
                  })
                }
                onDelete={(path) => setDeleteTarget(path)}
                onUnsupported={() =>
                  showToast('Preview unavailable', 'Notch edits Markdown and text notes. This file opens in your default app.', 'default')
                }
              />
              {!loadingTree && tree.length === 0 && (
                <div className="tree-empty">
                  <p>This folder is empty.</p>
                  <button className="soft-button" onClick={() => void createNoteNow()}>
                    <Plus size={12} /> Create a note
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <div className="sidebar-footer">
          <button className="sidebar-footer-button" onClick={() => void chooseVault()}>
            <FolderOpen size={13} /> Open folder
          </button>
          <button className="sidebar-footer-button" onClick={() => void window.notch.obsidian.reveal(vaultPath, null)}>
            <ArrowUpRightIcon /> Reveal
          </button>
        </div>
      </aside>

      <main className="note-workspace">
        {!selectedPath ? (
          <div className="note-welcome">
            <div className="note-welcome-icon"><FileText size={26} /></div>
            <span className="eyebrow">Nothing open</span>
            <h2>Pick a thought to continue.</h2>
            <p>Choose a note, or start a fresh page. Your edits write straight back to the file.</p>
            <div className="note-welcome-actions">
              <button className="primary-button" onClick={() => void createNoteNow()}>
                <Plus size={14} /> New note
              </button>
              <button className="soft-button" onClick={() => void loadTree()}>
                <RefreshCw size={13} /> Refresh folder
              </button>
            </div>
            {folders.length > 0 && (
              <div className="welcome-folders">
                {folders.slice(0, 4).map((folder) => (
                  <span key={folder}><Folder size={11} /> {folder}</span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="editor-shell">
            <div className="editor-head">
              <div className="editor-breadcrumb">
                <span>{vaultPath.split(/[\\/]/).filter(Boolean).pop()}</span>
                {folderPath && (
                  <>
                    <ChevronRight size={11} />
                    <span>{folderPath}</span>
                  </>
                )}
              </div>
              <div className="editor-title-row">
                <div>
                  {titleDraft === null ? (
                    <h1
                      className="note-title"
                      title="Click to rename"
                      onClick={() => setTitleDraft(displayTitle)}
                    >
                      {displayTitle}
                    </h1>
                  ) : (
                    <input
                      ref={titleInputRef}
                      className="note-title-input"
                      value={titleDraft}
                      onChange={(event) => setTitleDraft(event.target.value)}
                      onBlur={() => {
                        if (titleSkipCommit.current) {
                          titleSkipCommit.current = false
                          return
                        }
                        void commitTitle()
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          event.currentTarget.blur()
                        } else if (event.key === 'Escape') {
                          event.preventDefault()
                          titleSkipCommit.current = true
                          setTitleDraft(null)
                        }
                      }}
                      autoFocus
                      spellCheck={false}
                      aria-label="Note title"
                    />
                  )}
                  <span className="file-meta">
                    {selectedPath} · {words} words
                  </span>
                </div>
                <div className="editor-actions">
                  <span className={`save-state ${saveState}`}>
                    {saveState === 'saving' && <Loader2 size={11} className="spin" />}
                    {saveState === 'saved' && <Check size={11} />}
                    {saveState === 'idle' && dirtyRef.current && <span className="dirty-dot" />}
                    {saveState === 'error'
                      ? 'Save failed'
                      : saveState === 'saving'
                        ? 'Saving'
                        : saveState === 'saved'
                          ? 'Saved to file'
                          : dirtyRef.current
                            ? 'Unsaved'
                            : 'Saved to file'}
                  </span>
                  <button
                    className="icon-button subtle"
                    title="Rename note"
                    onClick={() => setTitleDraft(displayTitle)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className="icon-button subtle"
                    title="Open in default app"
                    onClick={async () => {
                      if (saveTimer.current) {
                        clearTimeout(saveTimer.current)
                        saveTimer.current = null
                      }
                      await saveNow()
                      void window.notch.obsidian.openFile(vaultPath, selectedPath)
                    }}
                  >
                    <Wand2 size={13} />
                  </button>
                  <button
                    className={`preview-toggle ${preview ? 'is-on' : ''}`}
                    onClick={() => setPreview((value) => !value)}
                    title="Toggle preview"
                  >
                    {preview ? <SquarePen size={13} /> : <Eye size={13} />}
                    {preview ? 'Edit' : 'Preview'}
                  </button>
                </div>
              </div>
            </div>

            {!preview && (
              <div className="editor-toolbar">
                <button onClick={() => applyFormat('**')} title="Bold (Ctrl+B)"><Bold size={14} /></button>
                <button onClick={() => applyFormat('_')} title="Italic (Ctrl+I)"><Italic size={14} /></button>
                <button onClick={() => applyFormat('## ', '', 'Heading')} title="Heading"><Heading2 size={14} /></button>
                <button
                  className={`ai-toolbar-button ${aiOpen ? 'is-on' : ''}`}
                  onClick={() => setAiOpen((value) => !value)}
                  title="Enhance with AI"
                >
                  <Sparkles size={14} /> <span>Enhance</span>
                </button>
                <button onClick={() => applyFormat('- ', '', 'List item')} title="Bullet list"><List size={14} /></button>
                <button onClick={() => applyFormat('- [ ] ', '', 'Task')} title="Checklist"><CheckSquare size={14} /></button>
                <button onClick={() => applyFormat('`', '`', 'code')} title="Inline code"><Code2 size={14} /></button>
                <button onClick={() => applyFormat('[', '](url)', 'link text')} title="Link"><Link2 size={14} /></button>
                <button onClick={() => applyFormat('[[', ']]', 'note')} title="Wiki link"><FileText size={14} /></button>
                <span className="toolbar-spacer" />
                <button onClick={() => void saveNow()} title="Save now (Ctrl+S)"><Save size={14} /></button>
              </div>
            )}

            {loadingNote ? (
              <div className="editor-loading"><Loader2 size={18} className="spin" /> Reading note…</div>
            ) : preview ? (
              <div
                className="markdown-preview"
                dangerouslySetInnerHTML={{ __html: markdownHtml }}
              />
            ) : (
              <textarea
                ref={textareaRef}
                className="note-textarea"
                value={content}
                onChange={(event) => onChangeContent(event.target.value)}
                onKeyDown={onEditorKeyDown}
                spellCheck
                placeholder="Start writing…"
              />
            )}

            <div className="editor-footer">
              <span>{content.length} characters</span>
              <span>{selectedPath.split('/').length > 1 ? 'Nested note' : 'Root folder'}</span>
              <span className="footer-path">{selectedPath}</span>
              <button onClick={() => void window.notch.obsidian.reveal(vaultPath, selectedPath)}>
                Reveal in Explorer
              </button>
            </div>
          </div>
        )}
      </main>

      {aiOpen && (
        <aside className="ai-drawer">
          <div className="ai-drawer-head">
            <span className="eyebrow"><Sparkles size={12} /> Enhance</span>
            <button className="icon-button subtle" onClick={() => setAiOpen(false)} title="Close">
              <X size={13} />
            </button>
          </div>
          {!state.settings.aiApiKey.trim() ? (
            <div className="ai-locked">
              <Sparkles size={22} />
              <p>Add your free NVIDIA API key to enhance and chat with this note.</p>
              <button className="primary-button" onClick={() => openSettings('ai')}>
                Open AI settings
              </button>
            </div>
          ) : (
            <>
              <div className="ai-quick">
                {AI_ACTIONS.map((action) => (
                  <button
                    key={action.label}
                    onClick={() => void askAi(action.prompt, action.label, Boolean(action.replace))}
                    disabled={aiBusy}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
              <div className="ai-messages">
                {aiMessages.length === 0 && !aiBusy && (
                  <div className="ai-hint">
                    Ask about this note, or start with a quick action. The note is sent to NVIDIA with
                    each request.
                  </div>
                )}
                {aiMessages.map((message, index) => (
                  <div key={index} className={`ai-msg ${message.role}`}>
                    <div className="ai-msg-text">{message.content}</div>
                    {message.role === 'assistant' && !message.content.startsWith('⚠') && (
                      <div className="ai-msg-actions">
                        <button onClick={() => insertAiText(message.content)}>Insert</button>
                        {message.replace && (
                          <button onClick={() => replaceNoteWithAi(message.content)}>Replace note</button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {aiBusy && (
                  <div className="ai-msg assistant is-thinking">
                    <Loader2 size={12} className="spin" /> Thinking…
                  </div>
                )}
                <div ref={aiEndRef} />
              </div>
              <form
                className="ai-compose"
                onSubmit={(event) => {
                  event.preventDefault()
                  void askAi(aiInput, aiInput, false)
                }}
              >
                <textarea
                  value={aiInput}
                  onChange={(event) => setAiInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      event.currentTarget.form?.requestSubmit()
                    }
                  }}
                  placeholder="Ask about this note…"
                  rows={2}
                />
                <button type="submit" className="ai-send" disabled={aiBusy || !aiInput.trim()} title="Send">
                  <Send size={13} />
                </button>
              </form>
            </>
          )}
        </aside>
      )}

      <Modal
        open={Boolean(entryDialog)}
        onClose={() => setEntryDialog(null)}
        title={
          entryDialog?.mode === 'note'
            ? 'New note'
            : entryDialog?.mode === 'folder'
              ? 'New folder'
              : 'Rename'
        }
        eyebrow={entryDialog?.mode === 'rename' ? 'Keep the extension, or change it' : 'Inside your notes folder'}
      >
        <form className="entry-form" onSubmit={(event) => void submitEntry(event)}>
          <label>
            <span>{entryDialog?.mode === 'rename' ? 'New name' : 'Name'}</span>
            <input
              name="name"
              autoFocus
              defaultValue={entryDialog?.targetName || ''}
              placeholder={entryDialog?.mode === 'folder' ? 'Projects' : 'A thought worth keeping'}
            />
          </label>
          {entryDialog?.mode !== 'rename' && (
            <label>
              <span>Location</span>
              <select name="parent" defaultValue={entryDialog?.parent || ''}>
                <option value="">Root folder</option>
                {folders.map((folder) => (
                  <option key={folder} value={folder}>
                    {folder}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="modal-actions">
            <button type="button" className="soft-button" onClick={() => setEntryDialog(null)}>
              Cancel
            </button>
            <button type="submit" className="primary-button">
              {entryDialog?.mode === 'folder' ? 'Create folder' : entryDialog?.mode === 'rename' ? 'Rename' : 'Create note'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} title="Move to trash?" eyebrow={deleteTarget || ''}>
        <p className="modal-copy">
          This sends the item to your system trash. It leaves the notes folder right away.
        </p>
        <div className="modal-actions">
          <button className="soft-button" onClick={() => setDeleteTarget(null)}>Keep it</button>
          <button className="danger-button" onClick={() => void confirmDelete()}>
            <Trash2 size={13} /> Move to trash
          </button>
        </div>
      </Modal>
    </div>
  )
}

function ArrowUpRightIcon() {
  return <ChevronRight size={12} className="up-right" />
}

function TreeNodes({
  nodes,
  depth,
  expanded,
  selectedPath,
  dragPath,
  onDragStartPath,
  onDragEndPath,
  onMove,
  onToggleFolder,
  onSelect,
  onRename,
  onDelete,
  onUnsupported
}: {
  nodes: VaultNode[]
  depth: number
  expanded: Set<string>
  selectedPath: string | null
  dragPath: string | null
  onDragStartPath: (path: string) => void
  onDragEndPath: () => void
  onMove: (sourcePath: string, targetDirectory: string) => void
  onToggleFolder: (path: string) => void
  onSelect: (path: string) => void
  onRename: (node: VaultNode) => void
  onDelete: (path: string) => void
  onUnsupported: () => void
}) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  return (
    <>
      {nodes.map((node) => {
        if (node.type === 'folder') {
          const isOpen = expanded.has(node.path)
          return (
            <div key={node.path} className="tree-group">
              <div
                className={`tree-row folder-row ${dropTarget === node.path ? 'is-drop-target' : ''} ${dragPath === node.path ? 'is-dragging' : ''}`}
                style={{ paddingLeft: 8 + depth * 13 }}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData('text/plain', node.path)
                  event.dataTransfer.effectAllowed = 'move'
                  onDragStartPath(node.path)
                }}
                onDragEnd={onDragEndPath}
                onDragOver={(event) => {
                  if (dragPath === node.path) return
                  event.preventDefault()
                  event.stopPropagation()
                  event.dataTransfer.dropEffect = 'move'
                  setDropTarget(node.path)
                }}
                onDragLeave={(event) => {
                  const next = event.relatedTarget as Node | null
                  if (!next || !event.currentTarget.contains(next)) {
                    setDropTarget((value) => (value === node.path ? null : value))
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setDropTarget(null)
                  const source = event.dataTransfer.getData('text/plain') || dragPath
                  if (!source || source === node.path) return
                  if (source === dragPath) onDragEndPath()
                  onMove(source, node.path)
                }}
                onPointerEnter={() => setHovered(node.path)}
                onPointerLeave={() => setHovered((value) => (value === node.path ? null : value))}
              >
                <button className="tree-folder-button" onClick={() => onToggleFolder(node.path)}>
                  <ChevronRight size={11} className={`tree-chevron ${isOpen ? 'is-open' : ''}`} />
                  {isOpen ? <FolderOpen size={13} /> : <Folder size={13} />}
                  <span>{node.name}</span>
                  <span className="tree-count">{countNotes(node.children || [])}</span>
                </button>
                {hovered === node.path && (
                  <span className="tree-row-actions">
                    <button onClick={() => onRename(node)} title="Rename folder"><Pencil size={11} /></button>
                    <button onClick={() => onDelete(node.path)} title="Move folder to trash"><Trash2 size={11} /></button>
                  </span>
                )}
              </div>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.16 }}
                    className="tree-children"
                  >
                    <TreeNodes
                      nodes={node.children || []}
                      depth={depth + 1}
                      expanded={expanded}
                      selectedPath={selectedPath}
                      dragPath={dragPath}
                      onDragStartPath={onDragStartPath}
                      onDragEndPath={onDragEndPath}
                      onMove={onMove}
                      onToggleFolder={onToggleFolder}
                      onSelect={onSelect}
                      onRename={onRename}
                      onDelete={onDelete}
                      onUnsupported={onUnsupported}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )
        }

        const editable = node.ext === '.md' || node.ext === '.markdown' || node.ext === '.txt'
        return (
          <div
            key={node.path}
            className={`tree-row file-row ${selectedPath === node.path ? 'is-selected' : ''} ${!editable ? 'is-muted' : ''} ${dragPath === node.path ? 'is-dragging' : ''}`}
            style={{ paddingLeft: 20 + depth * 13 }}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('text/plain', node.path)
              event.dataTransfer.effectAllowed = 'move'
              onDragStartPath(node.path)
            }}
            onDragEnd={onDragEndPath}
            onPointerEnter={() => setHovered(node.path)}
            onPointerLeave={() => setHovered((value) => (value === node.path ? null : value))}
          >
            <button
              className="tree-file-button"
              onClick={() => (editable ? onSelect(node.path) : onUnsupported())}
              title={node.path}
            >
              <FileText size={13} />
              <span>{node.name.replace(/\.md$/i, '')}</span>
              {node.ext && node.ext !== '.md' && <small>{node.ext.replace('.', '')}</small>}
            </button>
            {hovered === node.path && (
              <span className="tree-row-actions">
                <button onClick={() => onRename(node)} title="Rename"><Pencil size={11} /></button>
                <button onClick={() => onDelete(node.path)} title="Move to trash"><Trash2 size={11} /></button>
              </span>
            )}
          </div>
        )
      })}
    </>
  )
}
