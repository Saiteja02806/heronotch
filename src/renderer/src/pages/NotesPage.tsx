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
  SquarePen,
  Trash2,
  Wand2
} from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type UIEvent as ReactUIEvent
} from 'react'
import type { NoteSearchResult, VaultNode } from '../../../shared/types'
import { useApp } from '../state/AppContext'
import { useVaultPicker } from '../hooks/useVaultPicker'
import { CompactSlotPortal } from '../components/CompactSlot'
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

// ---------------------------------------------------------------------------
// Live editor rendering
//
// The textarea stays the input engine (caret, selection, undo) but its glyphs
// are transparent. A mirror layer underneath re-renders the same characters
// with Markdown formatting: real checkbox boxes, bold, headings, code. Every
// source character keeps its place — syntax markers keep their width so the
// caret stays aligned, emphasis stars are not drawn, and the checkbox
// characters are covered by a box — so the mirror and the caret line up
// exactly, line for line.
// ---------------------------------------------------------------------------

const escapeLive = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const LIVE_INLINE_SOURCE =
  '(`+[^`]*?`+)|(\\*\\*[^*]+\\*\\*)|(__[^_]+__)|(\\*[^*\\s][^*]*?\\*)|(_[^_\\s][^_]*?_)|(~~[^~]+~~)|(!?\\[[^\\]]*\\]\\([^)]*\\))|(\\[\\[[^\\]]+\\]\\])|(\\*{2,})'

const silentMarker = (marker: string): string =>
  `<span class="lm-marker is-silent">${escapeLive(marker)}</span>`

function renderLiveInline(text: string, depth = 0): string {
  if (depth > 2) return escapeLive(text)
  // A fresh regex per call: the function recurses (formatting inside
  // formatting) and a shared /g regex would have its lastIndex clobbered by
  // the inner call, looping forever.
  const inline = new RegExp(LIVE_INLINE_SOURCE, 'g')
  let out = ''
  let last = 0
  let match: RegExpExecArray | null
  while ((match = inline.exec(text))) {
    out += escapeLive(text.slice(last, match.index))
    const token = match[0]
    let handled = true
    if (match[1]) {
      // `code`
      const parts = /^(`+)([^`]*)(`+)$/.exec(token)
      out += `<span class="lm-marker">${escapeLive(parts?.[1] ?? '')}</span><span class="lm-code">${escapeLive(parts?.[2] ?? '')}</span><span class="lm-marker">${escapeLive(parts?.[3] ?? '')}</span>`
    } else if (match[2] || match[3]) {
      // **bold** / __bold__. Asterisks stay in the text so the caret lines up,
      // but they are not drawn — the weight is the bold.
      const marker = match[2] ? '**' : '__'
      const inner = token.slice(marker.length, -marker.length)
      const open = match[2] ? silentMarker(marker) : `<span class="lm-marker">${marker}</span>`
      const close = match[2] ? silentMarker(marker) : `<span class="lm-marker">${marker}</span>`
      out += `${open}<span class="lm-b">${renderLiveInline(inner, depth + 1)}</span>${close}`
    } else if (match[4] || match[5]) {
      // *italic* / _italic_
      const marker = match[4] ? '*' : '_'
      const inner = token.slice(marker.length, -marker.length)
      const open = match[4] ? silentMarker(marker) : `<span class="lm-marker">${marker}</span>`
      const close = match[4] ? silentMarker(marker) : `<span class="lm-marker">${marker}</span>`
      out += `${open}<span class="lm-i">${renderLiveInline(inner, depth + 1)}</span>${close}`
    } else if (match[6]) {
      // ~~strike~~
      out += `<span class="lm-marker">~~</span><span class="lm-s">${renderLiveInline(token.slice(2, -2), depth + 1)}</span><span class="lm-marker">~~</span>`
    } else if (match[7]) {
      // [text](url)
      const parts = /^(!?)\[([^\]]*)\]\(([^)]*)\)$/.exec(token)
      out += `<span class="lm-marker">${escapeLive(parts?.[1] ?? '')}[</span><span class="lm-link">${renderLiveInline(parts?.[2] ?? '', depth + 1)}</span><span class="lm-marker">](${escapeLive(parts?.[3] ?? '')})</span>`
    } else if (match[8]) {
      // [[wiki link]]
      out += `<span class="lm-marker">[[</span><span class="lm-wiki">${renderLiveInline(token.slice(2, -2), depth + 1)}</span><span class="lm-marker">]]</span>`
    } else if (match[9]) {
      // A bold marker that is still open, or stars left at the end of a word.
      out += silentMarker(token)
    } else {
      handled = false
    }
    if (!handled) out += escapeLive(token)
    last = match.index + token.length
  }
  out += escapeLive(text.slice(last))
  return out
}

type EditorMarks = {
  bold: boolean
  italic: boolean
  heading: boolean
  list: boolean
  task: boolean
  code: boolean
  link: boolean
}

const EMPTY_MARKS: EditorMarks = {
  bold: false,
  italic: false,
  heading: false,
  list: false,
  task: false,
  code: false,
  link: false
}

function wrappedBy(text: string, start: number, end: number, marker: string): boolean {
  const selected = text.slice(start, end)
  const singleAsterisk = marker === '*'
  if (
    selected.length >= marker.length * 2 &&
    selected.startsWith(marker) &&
    selected.endsWith(marker) &&
    !(singleAsterisk && selected.startsWith('**'))
  ) {
    return true
  }
  const before = text.slice(start - marker.length, start) === marker
  const after = text.slice(end, end + marker.length) === marker
  if (
    before &&
    after &&
    !(singleAsterisk && (text[start - marker.length - 1] === '*' || text[end + marker.length] === '*'))
  ) {
    return true
  }
  if (start !== end) return false
  const left = text.lastIndexOf(marker, Math.max(0, start - 1))
  const right = text.indexOf(marker, start)
  if (left < 0 || right < 0) return false
  if (singleAsterisk && (text[left - 1] === '*' || text[right + marker.length] === '*')) return false
  const gap = text.slice(left + marker.length, right)
  return gap.length > 0 && !gap.includes('\n') && !gap.includes(marker)
}

function marksAt(text: string, start: number, end: number): EditorMarks {
  const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const breakAt = text.indexOf('\n', Math.max(start, end))
  const lineEnd = breakAt === -1 ? text.length : breakAt
  const lines = text.slice(lineStart, lineEnd).split('\n').filter((line) => line.trim())
  const task = /^\s*(?:[-*+]|\d+\.)\s+\[[ xX]\]/
  const bullet = /^\s*(?:[-*+]|\d+\.)\s+/
  return {
    bold: wrappedBy(text, start, end, '**'),
    italic: wrappedBy(text, start, end, '*') || wrappedBy(text, start, end, '_'),
    heading: lines.length > 0 && lines.every((line) => /^#{1,6}\s+/.test(line)),
    list: lines.length > 0 && lines.every((line) => bullet.test(line) && !task.test(line)),
    task: lines.length > 0 && lines.every((line) => task.test(line)),
    code: wrappedBy(text, start, end, '`'),
    link: wrappedBy(text, start, end, '[') && text.slice(end, end + 1) === ']'
  }
}

function listParts(line: string): { indent: string; body: string; kind: 'task' | 'bullet' | 'none' } {
  const task = /^(\s*)(?:[-*+]|\d+\.)\s+\[[ xX]\]\s?(.*)$/.exec(line)
  if (task) return { indent: task[1], body: task[2], kind: 'task' }
  const bullet = /^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/.exec(line)
  if (bullet) return { indent: bullet[1], body: bullet[2], kind: 'bullet' }
  const indent = /^\s*/.exec(line)?.[0] ?? ''
  return { indent, body: line.slice(indent.length), kind: 'none' }
}

function renderLiveLine(line: string, checkboxIndex: number | null): string {
  let match = /^(#{1,6})(\s+)([\s\S]*)$/.exec(line)
  if (match) {
    return `<span class="lm-marker">${escapeLive(match[1] + match[2])}</span><span class="lm-h">${renderLiveInline(match[3])}</span>`
  }
  match = /^(\s*)(>+)(\s?)([\s\S]*)$/.exec(line)
  if (match) {
    return `<span class="lm-marker">${escapeLive(match[1] + match[2] + match[3])}</span><span class="lm-quote">${renderLiveInline(match[4])}</span>`
  }
  if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
    return `<span class="lm-marker">${escapeLive(line)}</span>`
  }
  match = /^(\s*)([-*+]|\d+\.)(\s+)([\s\S]*)$/.exec(line)
  if (match) {
    const marker = `<span class="lm-marker">${escapeLive(match[1] + match[2] + match[3])}</span>`
    const rest = match[4]
    if (checkboxIndex !== null) {
      const box = /^(\[[ xX]\])(\s?)([\s\S]*)$/.exec(rest)
      if (box) {
        const checked = box[1][1] !== ' '
        return `${marker}<span class="lm-box${checked ? ' is-checked' : ''}" data-ci="${checkboxIndex}">${escapeLive(box[1] + box[2])}</span>${renderLiveInline(box[3])}`
      }
    }
    return marker + renderLiveInline(rest)
  }
  return renderLiveInline(line)
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
  const compact = state.settings.panelSize === 'compact'

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
  const [marks, setMarks] = useState<EditorMarks>(EMPTY_MARKS)
  const [dragPath, setDragPath] = useState<string | null>(null)
  const [rootDrop, setRootDrop] = useState(false)
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

  // Line-based render of the note for the live editor overlay. Each source
  // line becomes one .lm-line element, so blank lines and wrapped lines keep
  // the exact geometry of the textarea above them.
  const mirrorHtml = useMemo(() => {
    let inFence = false
    let checkboxIndex = 0
    return content
      .split('\n')
      .map((line) => {
        if (/^\s*(`{3,}|~{3,})/.test(line)) {
          inFence = !inFence
          return `<div class="lm-line"><span class="lm-marker">${escapeLive(line)}</span></div>`
        }
        if (inFence) {
          return `<div class="lm-line"><span class="lm-code">${escapeLive(line)}</span></div>`
        }
        const isChecklist = /^\s*[-*+]\s+\[[ xX]\]/.test(line)
        const index = isChecklist ? checkboxIndex++ : null
        return `<div class="lm-line">${renderLiveLine(line, index)}</div>`
      })
      .join('')
  }, [content])

  const rememberMarks = (text: string, start: number, end: number): void => {
    const next = marksAt(text, start, end)
    setMarks((current) =>
      current.bold === next.bold &&
      current.italic === next.italic &&
      current.heading === next.heading &&
      current.list === next.list &&
      current.task === next.task &&
      current.code === next.code &&
      current.link === next.link
        ? current
        : next
    )
  }

  const replaceEditor = (start: number, end: number, insert: string, selectFrom: number, selectTo: number): void => {
    const textarea = textareaRef.current
    const next = `${content.slice(0, start)}${insert}${content.slice(end)}`
    onChangeContent(next)
    requestAnimationFrame(() => {
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(selectFrom, selectTo)
      rememberMarks(next, selectFrom, selectTo)
    })
  }

  const applyFormat = (before: string, after = before): void => {
    const textarea = textareaRef.current
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = content.slice(start, end)
    const caret = start + before.length
    replaceEditor(
      start,
      end,
      `${before}${selected}${after}`,
      caret,
      selected ? caret + selected.length : caret
    )
  }

  const toggleLines = (kind: 'bullet' | 'task'): void => {
    const textarea = textareaRef.current
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const lineStart = content.lastIndexOf('\n', Math.max(0, start - 1)) + 1
    const breakAt = content.indexOf('\n', end)
    const lineEnd = breakAt === -1 ? content.length : breakAt
    const lines = content.slice(lineStart, lineEnd).split('\n')
    const prefix = kind === 'task' ? '- [ ] ' : '- '
    if (!lines.some((line) => line.trim())) {
      replaceEditor(lineStart, lineEnd, prefix, lineStart + prefix.length, lineStart + prefix.length)
      return
    }
    const parsed = lines.map(listParts)
    const meaningful = parsed.filter((_, index) => lines[index].trim())
    const allOn = meaningful.length > 0 && meaningful.every((item) => item.kind === kind)
    const next = lines
      .map((line, index) => {
        if (!line.trim()) return line
        const item = parsed[index]
        if (allOn) return `${item.indent}${item.body}`
        return `${item.indent}${prefix}${item.body}`
      })
      .join('\n')
    replaceEditor(lineStart, lineEnd, next, lineStart, lineStart + next.length)
  }

  const toggleInline = (marker: string): void => {
    const textarea = textareaRef.current
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = content.slice(start, end)
    const beforeMarker = content.slice(start - marker.length, start) === marker
    const afterMarker = content.slice(end, end + marker.length) === marker
    const around =
      beforeMarker &&
      afterMarker &&
      (marker !== '*' ||
        (content[start - marker.length - 1] !== '*' && content[end + marker.length] !== '*'))
    const inside =
      selected.length >= marker.length * 2 &&
      selected.startsWith(marker) &&
      selected.endsWith(marker) &&
      !(marker === '*' && selected.startsWith('**'))
    if (inside) {
      const inner = selected.slice(marker.length, selected.length - marker.length)
      replaceEditor(start, end, inner, start, start + inner.length)
      return
    }
    if (around) {
      replaceEditor(start - marker.length, end + marker.length, selected, start - marker.length, end - marker.length)
      return
    }
  const inner = selected
  const from = start + marker.length
  replaceEditor(start, end, `${marker}${inner}${marker}`, from, inner ? from + inner.length : from)
}

  const toggleHeading = (): void => {
    const textarea = textareaRef.current
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const lineStart = content.lastIndexOf('\n', Math.max(0, start - 1)) + 1
    const breakAt = content.indexOf('\n', end)
    const lineEnd = breakAt === -1 ? content.length : breakAt
    const lines = content.slice(lineStart, lineEnd).split('\n')
    const meaningful = lines.filter((line) => line.trim())
    const allH2 = meaningful.length > 0 && meaningful.every((line) => /^##\s+/.test(line))
    const nextBlock = lines
      .map((line) => {
        if (!line.trim()) return line
        if (allH2) return line.replace(/^##\s+/, '')
        if (/^#{1,6}\s+/.test(line)) return line.replace(/^#{1,6}\s+/, '## ')
        return `## ${line}`
      })
      .join('\n')
    if (!nextBlock.trim()) {
      replaceEditor(lineStart, lineEnd, '## ', lineStart + 3, lineStart + 3)
      return
    }
    replaceEditor(lineStart, lineEnd, nextBlock, lineStart, lineStart + nextBlock.length)
  }

  const onEditorKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      const textarea = event.currentTarget
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      if (start === end) {
        const lineStart = content.lastIndexOf('\n', start - 1) + 1
        const line = content.slice(lineStart, start)
        const atLineEnd = start === content.length || content[start] === '\n'

        const checklist = line.match(/^(\s*)- \[([ xX])\] ?/)
        if (checklist) {
          event.preventDefault()
          const body = line.slice(checklist[0].length)
          if (atLineEnd && !body.trim()) {
            const next = `${content.slice(0, lineStart)}${content.slice(start)}`
            onChangeContent(next)
            requestAnimationFrame(() => textarea.setSelectionRange(lineStart, lineStart))
            return
          }
          const insert = `\n${checklist[1]}- [ ] `
          onChangeContent(`${content.slice(0, start)}${insert}${content.slice(end)}`)
          requestAnimationFrame(() =>
            textarea.setSelectionRange(start + insert.length, start + insert.length)
          )
          return
        }

        const bullet = line.match(/^(\s*)([-*+]) ?/)
        if (bullet) {
          event.preventDefault()
          const body = line.slice(bullet[0].length)
          if (atLineEnd && !body.trim()) {
            const next = `${content.slice(0, lineStart)}${content.slice(start)}`
            onChangeContent(next)
            requestAnimationFrame(() => textarea.setSelectionRange(lineStart, lineStart))
            return
          }
          const insert = `\n${bullet[1]}${bullet[2]} `
          onChangeContent(`${content.slice(0, start)}${insert}${content.slice(end)}`)
          requestAnimationFrame(() =>
            textarea.setSelectionRange(start + insert.length, start + insert.length)
          )
          return
        }

        const numbered = line.match(/^(\s*)(\d+)\. ?/)
        if (numbered) {
          event.preventDefault()
          const body = line.slice(numbered[0].length)
          if (atLineEnd && !body.trim()) {
            const next = `${content.slice(0, lineStart)}${content.slice(start)}`
            onChangeContent(next)
            requestAnimationFrame(() => textarea.setSelectionRange(lineStart, lineStart))
            return
          }
          const insert = `\n${numbered[1]}${Number(numbered[2]) + 1}. `
          onChangeContent(`${content.slice(0, start)}${insert}${content.slice(end)}`)
          requestAnimationFrame(() =>
            textarea.setSelectionRange(start + insert.length, start + insert.length)
          )
          return
        }
      }
    }
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
      toggleInline('**')
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'i') {
      event.preventDefault()
      toggleInline('*')
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

  // Toggle the nth checklist item by editing the source lines directly. Used
  // by both the live editor (clicking a drawn box) and the Preview pane.
  const toggleChecklistAt = useCallback(
    (index: number): void => {
      const lines = content.split('\n')
      let seen = 0
      for (let i = 0; i < lines.length; i += 1) {
        const match = lines[i].match(/^(\s*[-*+]\s+)\[([ xX])\](.*)$/)
        if (!match) continue
        if (seen === index) {
          const checked = match[2].toLowerCase() === 'x'
          lines[i] = `${match[1]}[${checked ? ' ' : 'x'}]${match[3]}`
          onChangeContent(lines.join('\n'))
          return
        }
        seen += 1
      }
    },
    [content, onChangeContent]
  )

  const togglePreviewTask = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    const item = target.closest('li')
    if (!item) return
    const box = item.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    if (!box) return
    const rect = box.getBoundingClientRect()
    const nearBox =
      event.clientX >= rect.left - 4 &&
      event.clientX <= rect.right + 4 &&
      event.clientY >= rect.top - 4 &&
      event.clientY <= rect.bottom + 4
    if (!nearBox) return
    const preview = event.currentTarget
    const items = Array.from(preview.querySelectorAll('li')).filter((li) =>
      li.querySelector('input[type="checkbox"]')
    )
    const index = items.indexOf(item)
    if (index < 0) return
    toggleChecklistAt(index)
  }

  // ---- Live editor overlay: geometry, click-to-tick, hover cursor, scroll ----

  const mirrorRef = useRef<HTMLDivElement>(null)
  const boxRectsRef = useRef<{ x: number; y: number; w: number; h: number; index: number }[]>([])

  // Checkbox hit boxes in the mirror's content coordinates. Content-space
  // coordinates survive scrolling, so they only need re-measuring when the
  // content or layout changes.
  const measureBoxes = useCallback(() => {
    const mirror = mirrorRef.current
    if (!mirror) {
      boxRectsRef.current = []
      return
    }
    const mr = mirror.getBoundingClientRect()
    const boxes: { x: number; y: number; w: number; h: number; index: number }[] = []
    mirror.querySelectorAll<HTMLElement>('.lm-box').forEach((el) => {
      const r = el.getBoundingClientRect()
      boxes.push({
        x: r.left - mr.left + mirror.scrollLeft,
        y: r.top - mr.top + mirror.scrollTop,
        w: r.width,
        h: r.height,
        index: Number(el.dataset.ci)
      })
    })
    boxRectsRef.current = boxes
  }, [])

  useLayoutEffect(() => {
    measureBoxes()
  }, [mirrorHtml, preview, loadingNote, measureBoxes])

  // Late re-measure once web fonts settle, plus on resizes.
  useEffect(() => {
    const timer = window.setTimeout(measureBoxes, 250)
    return () => window.clearTimeout(timer)
  }, [mirrorHtml, measureBoxes])

  useEffect(() => {
    const onResize = (): void => measureBoxes()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [measureBoxes])

  const hitCheckbox = useCallback((clientX: number, clientY: number): number => {
    const mirror = mirrorRef.current
    if (!mirror) return -1
    const mr = mirror.getBoundingClientRect()
    const x = clientX - mr.left + mirror.scrollLeft
    const y = clientY - mr.top + mirror.scrollTop
    for (const box of boxRectsRef.current) {
      if (x >= box.x - 4 && x <= box.x + box.w + 4 && y >= box.y - 5 && y <= box.y + box.h + 5) {
        return box.index
      }
    }
    return -1
  }, [])

  const onEditorMouseDown = (event: ReactMouseEvent<HTMLTextAreaElement>): void => {
    const index = hitCheckbox(event.clientX, event.clientY)
    if (index < 0) return
    event.preventDefault()
    toggleChecklistAt(index)
  }

  const onEditorMouseMove = (event: ReactMouseEvent<HTMLTextAreaElement>): void => {
    const cursor = hitCheckbox(event.clientX, event.clientY) >= 0 ? 'pointer' : ''
    const textarea = event.currentTarget
    if (textarea.style.cursor !== cursor) textarea.style.cursor = cursor
  }

  const syncMirrorScroll = (event: ReactUIEvent<HTMLTextAreaElement>): void => {
    const mirror = mirrorRef.current
    if (mirror) mirror.scrollTop = event.currentTarget.scrollTop
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
    <div className="notes-page">
      <aside className="notes-sidebar">
        {!compact && (
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
        )}

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

      {compact && (
        <CompactSlotPortal>
          <div className="notes-compact-bar">
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
        </CompactSlotPortal>
      )}

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
                <div className="toolbar-group">
                  <button type="button" className={marks.bold ? 'is-on' : ''} aria-pressed={marks.bold} onMouseDown={(event) => event.preventDefault()} onClick={() => toggleInline('**')} title="Bold (Ctrl+B)"><Bold size={14} /></button>
                  <button type="button" className={marks.italic ? 'is-on' : ''} aria-pressed={marks.italic} onMouseDown={(event) => event.preventDefault()} onClick={() => toggleInline('*')} title="Italic (Ctrl+I)"><Italic size={14} /></button>
                  <button type="button" className={marks.heading ? 'is-on' : ''} aria-pressed={marks.heading} onMouseDown={(event) => event.preventDefault()} onClick={toggleHeading} title="Heading"><Heading2 size={14} /></button>
                </div>
                <div className="toolbar-group">
                  <button type="button" className={marks.list ? 'is-on' : ''} aria-pressed={marks.list} onMouseDown={(event) => event.preventDefault()} onClick={() => toggleLines('bullet')} title="Bullet list"><List size={14} /></button>
                  <button type="button" className={marks.task ? 'is-on' : ''} aria-pressed={marks.task} onMouseDown={(event) => event.preventDefault()} onClick={() => toggleLines('task')} title="Checklist"><CheckSquare size={14} /></button>
                </div>
                <div className="toolbar-group">
                  <button type="button" className={marks.code ? 'is-on' : ''} aria-pressed={marks.code} onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('`', '`')} title="Inline code"><Code2 size={14} /></button>
                  <button type="button" className={marks.link ? 'is-on' : ''} aria-pressed={marks.link} onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('[', '](url)')} title="Link"><Link2 size={14} /></button>
                  <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('[[', ']]')} title="Wiki link"><FileText size={14} /></button>
                </div>
                <span className="toolbar-spacer" />
                <button type="button" className="toolbar-save" onClick={() => void saveNow()} title="Save now (Ctrl+S)"><Save size={14} /></button>
              </div>
            )}

            {loadingNote ? (
              <div className="editor-loading"><Loader2 size={18} className="spin" /> Reading note…</div>
            ) : preview ? (
              <div
                className="markdown-preview"
                onClick={togglePreviewTask}
                dangerouslySetInnerHTML={{ __html: markdownHtml }}
              />
            ) : (
              <div className="live-editor">
                <div
                  ref={mirrorRef}
                  className="live-mirror"
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: mirrorHtml }}
                />
                <textarea
                  ref={textareaRef}
                  className="note-textarea"
                  value={content}
                  onChange={(event) => onChangeContent(event.target.value)}
                  onKeyDown={onEditorKeyDown}
                  onScroll={syncMirrorScroll}
                  onMouseDown={onEditorMouseDown}
                  onMouseMove={onEditorMouseMove}
                  onSelect={() => rememberMarks(contentRef.current, textareaRef.current?.selectionStart ?? 0, textareaRef.current?.selectionEnd ?? 0)}
                  spellCheck
                  placeholder="Start writing…"
                />
              </div>
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
