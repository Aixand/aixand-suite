import { lazy, Suspense } from 'react'
import type { ComponentProps } from 'react'
import { PageLoading } from '../../components/PageLoading'
import type { CodeEditor as EditorComponent } from './CodeEditor'

const Editor = lazy(() => import('./CodeEditor').then(module => ({ default: module.CodeEditor })))
export function CodeEditor(props: ComponentProps<typeof EditorComponent>) {
  return <Suspense fallback={<PageLoading label="Loading editor…" size="panel" />}><Editor {...props} /></Suspense>
}
