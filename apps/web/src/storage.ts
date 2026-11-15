export function readStorage(key: string): string | null {
  return localStorage.getItem(key)
}
