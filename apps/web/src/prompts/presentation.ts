import type { Details, Pack, Prompt, usePrompts } from './model'

export type PromptSelection = { packId: string; prompt?: string }
export type PromptRequest = ReturnType<typeof usePrompts>['request']

export const revisionLabel = (pack: Pack, source = false) =>
  pack.kind === 'draft'
    ? `Draft${source ? ` · ${pack.source}` : ''}`
    : `Release ${pack.version}`

export function packGroups(packs: Pack[]) {
  const groups = new Map<string, Pack[]>()
  for (const pack of packs) {
    const revisions = groups.get(pack.name) ?? []
    revisions.push(pack)
    groups.set(pack.name, revisions)
  }
  return [...groups].flatMap(([name, revisions]) => {
    const drafts = revisions.filter(row => row.kind === 'draft')
    if (drafts.length <= 1) return [{ name, revisions }]
    return [
      ...drafts.map(row => ({ name: `${name} · ${row.source_id} · ${row.id.slice(0, 8)}`, revisions: [row] })),
      ...(revisions.some(row => row.kind === 'release') ? [{ name: `${name} · releases`, revisions: revisions.filter(row => row.kind === 'release') }] : []),
    ]
  })
}

export function preferredRevision(revisions: Pack[]) {
  return (
    revisions.find(
      (pack) => pack.kind === 'draft' && pack.status === 'available',
    ) ??
    [...revisions]
      .filter((pack) => pack.status === 'available')
      .sort((a, b) =>
        (b.version ?? '').localeCompare(a.version ?? '', undefined, {
          numeric: true,
        }),
      )[0] ??
    revisions[0]
  )
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function firstFile(details: Details, name?: string) {
  const definition = record(record(details.manifest.prompts)[name ?? ''])
  if (Array.isArray(definition.sections)) {
    for (const item of definition.sections) {
      const section = record(item)
      const asset = record(
        record(details.manifest.sections)[String(section.section)] ??
          record(details.manifest.documents)[String(section.document)],
      )
      if (typeof asset.file === 'string' && asset.file in details.files)
        return asset.file
    }
  }
  const files = Object.keys(details.files)
  return (
    files.find(
      (file) => name && file.split('/').at(-1)?.split('.')[0] === name,
    ) ??
    files[0] ??
    'pack.json'
  )
}

export const fileContent = (details: Details, file: string) =>
  file === 'pack.json'
    ? JSON.stringify(details.manifest, null, 2)
    : (details.files[file] ?? '')

export function defaultInputs(prompt?: Prompt) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(prompt?.inputs ?? {}).map(([key, spec]) => [
        key,
        'default' in spec
          ? spec.default
          : (spec.enum?.[0] ??
            {
              string: '',
              boolean: false,
              integer: 0,
              number: 0,
              object: {},
              array: [],
              null: null,
            }[spec.type] ??
            null),
      ]),
    ),
    null,
    2,
  )
}

export function parseInputs(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Enter inputs as a JSON object.')
  }
  return parsed as Record<string, unknown>
}

export const errorMessage = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : 'The operation failed. Please try again.'
