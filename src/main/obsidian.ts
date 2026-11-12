import { shell } from 'electron'
import { promises as fs, mkdirSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { NoteSearchResult, VaultNode } from '../shared/types'

const IGNORED_DIRECTORIES = new Set(['.obsidian', '.trash', '.git', '.github', 'node_modules', '.DS_Store'])
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.canvas'])

let watcher: FSWatcher | null = null
let watchDebounce: NodeJS.Timeout | null = null

function resolveSafe(vaultPath: string, relativePath: string): string {
  const root = path.resolve(vaultPath)
  const full = path.resolve(root, relativePath || '.')
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('That path is outside the selected vault.')
  }
  return full
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

function sanitizeName(name: string): string {
  const trimmed = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\.+$/, '')
  if (!trimmed || trimmed === '.' || trimmed === '..') throw new Error('Enter a valid file name.')
  return trimmed
}

async function buildTree(vaultPath: string, absoluteDir: string, depth = 0): Promise<VaultNode[]> {
  if (depth > 12) return []
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true })
  const nodes: VaultNode[] = []

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.md') continue
    if (IGNORED_DIRECTORIES.has(entry.name)) continue

    const absolute = path.join(absoluteDir, entry.name)
    const relative = toPosix(path.relative(vaultPath, absolute))

    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: relative,
        type: 'folder',
        children: await buildTree(vaultPath, absolute, depth + 1)
      })
    } else if (entry.isFile()) {
      const stats = await fs.stat(absolute).catch(() => null)
      nodes.push({
        name: entry.name,
        path: relative,
        type: 'file',
        ext: path.extname(entry.name).toLowerCase(),
        modified: stats?.mtimeMs ?? 0
      })
    }
  }

  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

export async function listVault(vaultPath: string): Promise<VaultNode[]> {
  try {
    const stats = await fs.stat(vaultPath)
    if (!stats.isDirectory()) throw new Error('The selected vault is not a folder.')
    return await buildTree(vaultPath, vaultPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new Error('That vault folder no longer exists. Choose it again in Settings.')
    throw error
  }
}

export async function readNote(vaultPath: string, relativePath: string): Promise<string> {
  const full = resolveSafe(vaultPath, relativePath)
  const ext = path.extname(full).toLowerCase()
  if (!TEXT_EXTENSIONS.has(ext)) throw new Error('This file type cannot be edited here.')
  return fs.readFile(full, 'utf8')
}

export async function writeNote(vaultPath: string, relativePath: string, content: string): Promise<void> {
  const full = resolveSafe(vaultPath, relativePath)
  const ext = path.extname(full).toLowerCase()
  if (!TEXT_EXTENSIONS.has(ext)) throw new Error('This file type cannot be edited here.')
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content, 'utf8')
}

export function writeNoteSync(vaultPath: string, relativePath: string, content: string): void {
  const full = resolveSafe(vaultPath, relativePath)
  const ext = path.extname(full).toLowerCase()
  if (!TEXT_EXTENSIONS.has(ext)) throw new Error('This file type cannot be edited here.')
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

export async function createFile(vaultPath: string, directory: string, rawName: string): Promise<string> {
  const safe = sanitizeName(rawName)
  const fileName = path.extname(safe) ? safe : `${safe}.md`
  const full = resolveSafe(vaultPath, path.join(directory || '', fileName))
  if (await fs.stat(full).then(() => true).catch(() => false)) {
    throw new Error('A file with that name already exists.')
  }
  await fs.mkdir(path.dirname(full), { recursive: true })
  const title = path.basename(fileName, path.extname(fileName))
  await fs.writeFile(full, `# ${title}\n\n`, 'utf8')
  return toPosix(path.relative(vaultPath, full))
}

export async function createFolder(vaultPath: string, directory: string, rawName: string): Promise<string> {
  const safe = sanitizeName(rawName)
  const full = resolveSafe(vaultPath, path.join(directory || '', safe))
  await fs.mkdir(full, { recursive: false })
  return toPosix(path.relative(vaultPath, full))
}

export async function renameEntry(vaultPath: string, relativePath: string, rawName: string): Promise<string> {
  if (!relativePath || relativePath === '.') throw new Error('Choose a file or folder to rename.')
  const full = resolveSafe(vaultPath, relativePath)
  const stats = await fs.stat(full)
  let safe = sanitizeName(rawName)
  if (stats.isFile()) {
    const currentExt = path.extname(full)
    if (!path.extname(safe) && currentExt) safe += currentExt
  }
  const target = path.join(path.dirname(full), safe)
  if (target === full) return relativePath
  if (await fs.stat(target).then(() => true).catch(() => false)) {
    throw new Error('Something with that name already exists.')
  }
  await fs.rename(full, target)
  return toPosix(path.relative(vaultPath, target))
}

// Drag and drop moves an entry between folders, like Obsidian. The name is kept,
// and a collision is refused rather than silently overwriting the other file.
export async function moveEntry(
  vaultPath: string,
  relativePath: string,
  targetDirectory: string
): Promise<string> {
  if (!relativePath || relativePath === '.') throw new Error('The vault root cannot be moved.')
  const source = resolveSafe(vaultPath, relativePath)
  const directory = resolveSafe(vaultPath, targetDirectory)
  const stats = await fs.stat(source)

  if (stats.isDirectory()) {
    const relative = path.relative(source, directory)
    if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new Error('A folder cannot be moved inside itself.')
    }
  }

  const destination = path.join(directory, path.basename(source))
  if (destination === source) return toPosix(path.relative(vaultPath, source))
  const exists = await fs.stat(destination).then(() => true).catch(() => false)
  if (exists) throw new Error('Something with that name already exists there.')

  await fs.mkdir(directory, { recursive: true })
  await fs.rename(source, destination)
  return toPosix(path.relative(vaultPath, destination))
}

export async function trashEntry(vaultPath: string, relativePath: string): Promise<void> {
  if (!relativePath || relativePath === '.') throw new Error('The vault root cannot be moved to trash.')
  const full = resolveSafe(vaultPath, relativePath)
  await shell.trashItem(full)
}

export async function revealEntry(vaultPath: string, relativePath: string | null): Promise<void> {
  if (!relativePath) {
    await shell.openPath(vaultPath)
    return
  }
  const full = resolveSafe(vaultPath, relativePath)
  shell.showItemInFolder(full)
}

export async function openInObsidian(vaultPath: string, relativePath: string): Promise<void> {
  const vaultName = path.basename(path.resolve(vaultPath))
  const file = relativePath.replace(/\.md$/i, '')
  const url = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}`
  await shell.openExternal(url)
}

async function collectMarkdown(vaultPath: string): Promise<string[]> {
  const results: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 12 || results.length > 4000) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name)) continue
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(absolute, depth + 1)
      else if (entry.isFile() && ['.md', '.markdown', '.txt'].includes(path.extname(entry.name).toLowerCase())) {
        results.push(absolute)
        if (results.length > 4000) return
      }
    }
  }
  await walk(vaultPath, 0)
  return results
}

export async function searchNotes(vaultPath: string, query: string): Promise<NoteSearchResult[]> {
  const needle = query.trim().toLowerCase()
  if (needle.length < 2) return []
  const files = await collectMarkdown(vaultPath)
  const matches: NoteSearchResult[] = []

  for (const file of files) {
    let content: string
    try {
      content = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    const index = content.toLowerCase().indexOf(needle)
    const nameIndex = path.basename(file).toLowerCase().indexOf(needle)
    if (index === -1 && nameIndex === -1) continue
    const start = Math.max(0, index - 46)
    const rawSnippet = index === -1 ? content.slice(0, 140) : content.slice(start, start + 160)
    const snippet = rawSnippet.replace(/\s+/g, ' ').trim()
    matches.push({
      path: toPosix(path.relative(vaultPath, file)),
      name: path.basename(file),
      snippet
    })
    if (matches.length >= 40) break
  }

  return matches.sort((a, b) => {
    const aName = a.name.toLowerCase().includes(needle) ? 0 : 1
    const bName = b.name.toLowerCase().includes(needle) ? 0 : 1
    return aName - bName
  })
}

export function watchVault(vaultPath: string | null, onChange: () => void): void {
  if (watcher) {
    watcher.close()
    watcher = null
  }
  if (watchDebounce) {
    clearTimeout(watchDebounce)
    watchDebounce = null
  }
  if (!vaultPath) return

  try {
    watcher = watch(vaultPath, { recursive: true }, (_event, fileName) => {
      if (fileName && (fileName.includes('.obsidian') || fileName.includes('.git'))) return
      if (watchDebounce) clearTimeout(watchDebounce)
      watchDebounce = setTimeout(onChange, 450)
    })
    watcher.on('error', () => {
      watcher?.close()
      watcher = null
    })
  } catch {
    watcher = null
  }
}

export function closeVaultWatcher(): void {
  watcher?.close()
  watcher = null
  if (watchDebounce) clearTimeout(watchDebounce)
}
