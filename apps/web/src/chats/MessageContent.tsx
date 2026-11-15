import { Children, isValidElement, memo, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Icon, Tooltip } from 'bbb-design'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import { ContentLink } from '../components/ContentLink'
import { ScrollRegion } from '../components/ScrollRegion'
import { MermaidDiagram } from './MermaidDiagram'

function normalizeMessageText(text: string) {
  // Decode escaped line breaks in prose while keeping code examples intact.
  const decodeLineBreak = (value: string) => value === '\\n' || value === '\\r\\n' ? '\n' : value
  return text.replace(/(`+)[\s\S]*?(?:\1(?!`)|$)|(~{3,})[\s\S]*?(?:\2(?!~)|$)|<(pre|code)\b[^>]*>[\s\S]*?(?:<\/\3\s*>|$)|\\(?:\\|r\\n|n)/gi,
    (value) => {
      // A fence with escaped separators also needs real lines to parse as a block.
      if (!value.includes('\n') && /^(?:`{3,}|~{3,})[^\\]*\\(?:r\\n|n)/.test(value))
        return value.replace(/\\(?:\\|r\\n|n)/g, decodeLineBreak)
      return decodeLineBreak(value)
    })
}

function codeText(children: ReactNode): string {
  return Children.toArray(children).map((child) => {
    if (typeof child === 'string' || typeof child === 'number') return String(child)
    return isValidElement<{ children?: ReactNode }>(child) ? codeText(child.props.children) : ''
  }).join('')
}

export function CopyButton({ text, label, showLabel = false }: { text: string; label: string; showLabel?: boolean }) {
  const [feedback, setFeedback] = useState<'copied' | 'failed' | null>(null)
  useEffect(() => {
    if (!feedback) return
    const timer = setTimeout(() => setFeedback(null), 2500)
    return () => clearTimeout(timer)
  }, [feedback])
  const caption = feedback === 'copied' ? 'Copied' : feedback === 'failed' ? 'Unable to copy' : label
  return <>
    <Tooltip content={caption}>
      <Button variant="ghost" size="sm" iconOnly={!showLabel} className="command-copy-button" aria-label={caption}
        onPress={async () => {
          try { await navigator.clipboard.writeText(text); setFeedback('copied') }
          catch { setFeedback('failed') }
        }}>
        <Icon name={feedback === 'copied' ? 'check' : feedback === 'failed' ? 'triangle-alert' : 'copy'} />
        {showLabel && (feedback ? caption : 'Copy')}
      </Button>
    </Tooltip>
    <span className="bbb-visually-hidden" role="status">{feedback ? caption : ''}</span>
  </>
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null
  const language = code?.props.className?.replace(/^language-/, '')
  const text = codeText(children).replace(/\n$/, '')
  const mermaid = language?.toLowerCase() === 'mermaid'
  return <div className="command-code-block">
    <div className="command-code-heading"><span>{mermaid ? 'Mermaid' : language || 'Code'}</span><CopyButton text={text} label={mermaid ? 'Copy diagram source' : 'Copy code'} showLabel /></div>
    {mermaid ? <MermaidDiagram source={text} /> : <ScrollRegion as="pre" label={language ? `${language} code` : 'Code'}>{children}</ScrollRegion>}
  </div>
}

const components: Components = {
  pre: CodeBlock,
  a: ({ node: _node, ...props }) => <ContentLink {...props} />,
  table: ({ node: _node, ...props }) => <ScrollRegion className="command-table-scroll" label="Table"><table {...props} /></ScrollRegion>,
}

// Completed messages keep their parsed Markdown while another message streams.
export const MessageContent = memo(function MessageContent({ text }: { text: string }) {
  return <div className="command-message-content">
    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]} components={components}>{normalizeMessageText(text)}</Markdown>
  </div>
})
