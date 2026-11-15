export function nameError(value: string, existing: string[], current?: string, reserveDefault = false): string {
  if (!value) return 'Enter a name.'
  if (value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value))
    return 'Use letters, numbers, hyphens, or underscores, starting with a letter or number.'
  if (reserveDefault && value.toLowerCase() === 'default') return 'default is reserved for the native profile.'
  if (existing.some((item) => item !== current && item.toLowerCase() === value.toLowerCase())) return 'That name is already in use for this provider.'
  return ''
}
