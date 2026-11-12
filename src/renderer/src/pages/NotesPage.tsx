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
  ListTree,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  SquarePen,
  Trash2,
  Wand2
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

export function NotesPage() {
  const {
    state,
    update,
    updateSettings,
    showToast,
    pendingNote,
    setPendingNote,
    vaultRevision
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
          showToast('Vault unavailable', error instanceof Error ? error.message : 'Could not read the vault.', 'error')
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

  const submitEntry = async (event: FormEvent<HTMLFormElement>): Promise<void> => {    event.preventDefault()
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
        <span className="eyebrow">Obsidian, inside your notch</span>
        <h1>Your vault, one hover away.</h1>
        <p>
          Connect a vault to browse every folder, create notes, rewrite drafts, and jump straight
          into Obsidian. Nothing syncs anywhere else — Notch works directly with your files.
        </p>
        <button className="primary-button" onClick={() => void chooseVault()}>
          <FolderOpen size={15} />
          Choose your vault
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
    <div className="notes-page">
      <aside className="notes-sidebar">
        <div className="sidebar-head">
          <div className="sidebar-vault">
            <span className="vault-avatar">{vaultPath.split(/[\\/]/).filter(Boolean).pop()?.slice(0, 1).toUpperCase()}</span>
            <div>
              <span className="eyebrow">Vault</span>
              <strong>{vaultPath.split(/[\\/]/).filter(Boolean).pop()}</strong>
            </div>
          </div>
          <div className="sidebar-actions">
            <button className="icon-button subtle" onClick={() => void loadTree()} title="Refresh vault">
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
              <div className="tree-toolbar">
                <span className="tree-label">{noteCount} notes</span>
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
                  showToast('Preview unavailable', 'Notch edits Markdown and text notes. This file will open in Obsidian.', 'default')
                }
              />
              {!loadingTree && tree.length === 0 && (
                <div className="tree-empty">
                  <p>Your vault is empty.</p>
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
            <FolderOpen size={13} /> Switch vault
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
            <p>Choose a note from the vault, or start a fresh page. Your edits write straight back to Obsidian.</p>
            <div className="note-welcome-actions">
              <button className="primary-button" onClick={() => void createNoteNow()}>
                <Plus size={14} /> New note
              </button>
              <button className="soft-button" onClick={() => void loadTree()}>
                <RefreshCw size={13} /> Refresh vault
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
                  <h1>{displayTitle}</h1>
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
                          ? 'Saved to Obsidian'
                          : dirtyRef.current
                            ? 'Unsaved'
                            : 'Saved to file'}
                  </span>
                  <button
                    className="icon-button subtle"
                    title="Rename note"
                    onClick={() =>
                      setEntryDialog({
                        mode: 'rename',
                        targetPath: selectedPath,
                        targetName: selectedPath.split('/').pop() || '',
                        parent: selectedPath.split('/').slice(0, -1).join('/')
                      })
                    }
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className="icon-button subtle"
                    title="Open in Obsidian"
                    onClick={async () => {
                      if (saveTimer.current) {
                        clearTimeout(saveTimer.current)
                        saveTimer.current = null
                      }
                      await saveNow()
                      void window.notch.obsidian.openInObsidian(vaultPath, selectedPath)
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
                <button onClick={() => applyFormat('- ', '', 'List item')} title="Bullet list"><Wand2 size={14} /></button>
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
              <span>{selectedPath.split('/').length > 1 ? 'Nested note' : 'Vault root'}</span>
              <span className="footer-path">{selectedPath}</span>
              <button onClick={() => void window.notch.obsidian.reveal(vaultPath, selectedPath)}>
                Reveal in Explorer
              </button>
            </div>
          </div>
        )}
      </main>

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
        eyebrow={entryDialog?.mode === 'rename' ? 'Keep the extension, or change it' : 'Inside your vault'}
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
                <option value="">Vault root</option>
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
          This sends the item to your system trash. Obsidian will stop seeing it right away.
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
  onToggleFolder: (path: string) => void
  onSelect: (path: string) => void
  onRename: (node: VaultNode) => void
  onDelete: (path: string) => void
  onUnsupported: () => void
}) {
  const [hovered, setHovered] = useState<string | null>(null)
  return (
    <>
      {nodes.map((node) => {
        if (node.type === 'folder') {
          const isOpen = expanded.has(node.path)
          return (
            <div key={node.path} className="tree-group">
              <div
                className="tree-row folder-row"
                style={{ paddingLeft: 8 + depth * 13 }}
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
            className={`tree-row file-row ${selectedPath === node.path ? 'is-selected' : ''} ${!editable ? 'is-muted' : ''}`}
            style={{ paddingLeft: 20 + depth * 13 }}
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
