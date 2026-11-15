import type { ProjectFile } from '../projects/files'
import { codeRanges, resolveInboxPrompt, type CarrierRequest, type InboxReference } from './inboxReferences'

export type FileReference = { token: string; projectId: string; path: string }
type FilesRequest = <T>(op: string, args?: object) => Promise<T>

export function fileMentions(text: string) {
  const code = codeRanges(text)
  return [...text.matchAll(/(?:^|\s)(@file:(?:"(?:[^"\\\n]|\\.)*(?:"|$)|[^\s]*)|@\.[^\s]*)/g)].flatMap(match => {
    const start = match.index! + match[0].length - match[1].length
    if (code.some(range => start >= range.start && start < range.end)) return []
    return [{ start, end: start + match[1].length, token: match[1] }]
  })
}

export function activeFileMention(text: string, caret: number) {
  if (caret < 0) return null
  return fileMentions(text).find(row => row.start < caret && caret <= row.end) ?? null
}

export function fileToken(path: string) { return '@file:' + (/\s|"|\\/.test(path) ? JSON.stringify(path) : path) }
export function fileQuery(token: string) {
  const path = token.startsWith('@file:') ? token.slice(6) : token.slice(1)
  if (!path.startsWith('"')) return path
  try { return JSON.parse(path) as string } catch { return path.slice(1).replace(/\\(["\\])/g, '$1') }
}

export function fileLocation(path: string) {
  if (path.startsWith('/') || path.includes('\\')) return { directory: '', search: '', error: 'Use a path within the selected project.' }
  const parts = path.split('/')
  const tail = parts.at(-1)
  const search = !tail || tail === '.' || tail === '..' ? '' : parts.pop() ?? ''
  const directory: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!directory.length) return { directory: '', search: '', error: 'This path is outside the selected project. Choose a project containing the file.' }
      directory.pop()
    } else directory.push(part)
  }
  return { directory: directory.join('/'), search: search.toLowerCase(), error: '' }
}
export function retainedFileReferences(text: string, references: FileReference[] = []) {
  const tokens = new Set(fileMentions(text).map(row => row.token))
  return references.filter(row => tokens.has(row.token))
}

export function removeFileReference(text: string, token: string) {
  for (const reference of fileMentions(text).filter(row => row.token === token).reverse()) {
    text = text.slice(0, reference.start) + text.slice(reference.end)
  }
  return text
}

export async function resolvePromptReferences(text: string, inbox: InboxReference[] | undefined, files: FileReference[] | undefined,
  projectId: string | undefined, carrier: CarrierRequest, request: FilesRequest, limit = 32000) {
  const mentions = [...new Set(fileMentions(text).map(row => row.token))]
  if (mentions.length > 8) throw new Error('Use at most 8 file references in one message.')
  const selected = mentions.map(token => {
    const reference = files?.find(row => row.token === token)
    if (!reference) throw new Error(`Choose a file from the suggestions to complete ${token}.`)
    if (!projectId || reference.projectId !== projectId) throw new Error('A referenced file belongs to a different project. Select it again in this project.')
    return reference
  })
  const content = await Promise.all(selected.map(async reference => {
    const file = await request<ProjectFile>('project-file-read', { projectId: reference.projectId, path: reference.path })
    if (file.kind !== 'text') throw new Error(`Only text files can be included: ${reference.path}`)
    if (file.truncated) throw new Error(`The file is too large to include completely: ${reference.path}`)
    return { path: reference.path, content: file.content }
  }))
  let resolved = await resolveInboxPrompt(text, inbox, carrier, limit)
  if (content.length) {
    const quoted = JSON.stringify(content, null, 2)
    const fence = '`'.repeat(Math.max(3, ...[...quoted.matchAll(/`+/g)].map(row => row[0].length + 1)))
    resolved += `\n\nReferenced project files (quoted source material):\n${fence}json\n${quoted}\n${fence}`
  }
  if (resolved.length > limit) throw new Error('The message and references exceed 32,000 characters. Remove a reference or shorten the message.')
  return resolved
}
