import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ContentLink } from '../../components/ContentLink'
import { CodeEditor } from './LazyCodeEditor'
import './editor.css'

export function ResourceContent({ text, file, label = 'Resource content' }: { text: string; file: string; label?: string }) {
  if (/\.(md|markdown)$/i.test(file)) {
    const frontmatter = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? ''
    return <div className="resource-document" aria-label={label}>
      <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _node, ...props }) => <ContentLink {...props} />,
        table: props => <div className="resource-table"><table {...props} /></div> }}>{text.slice(frontmatter.length) || 'This file is empty.'}</Markdown>
      {frontmatter && <details className="resource-metadata"><summary>File metadata</summary><pre>{frontmatter}</pre></details>}
    </div>
  }
  return <CodeEditor label={label} file={file} value={text} onChange={() => {}} disabled />
}
