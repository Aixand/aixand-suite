import { useEffect, useState } from 'react'
import { useThemeAttributes } from 'bbb-design'

type Mode = 'light' | 'dark'
type RenderedDiagram = { source: string; mode: Mode; svg: string | null }

// Mermaid shares configuration globally. Keep initialization and rendering together
// so concurrent diagrams cannot pick up another diagram's theme.
let renderQueue: Promise<unknown> = Promise.resolve()

function renderDiagram(source: string, mode: Mode, cancelled: () => boolean) {
  const task = renderQueue.then(async () => {
    if (cancelled()) return null
    const { default: mermaid } = await import('mermaid')
    if (cancelled()) return null
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: mode === 'dark' ? 'dark' : 'default',
      fontFamily: 'Arial, sans-serif',
      htmlLabels: false,
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges',
        'suppressErrorRendering', 'htmlLabels', 'fontFamily'],
    })
    // Mermaid measures text in the DOM. Use a hidden container and always remove
    // it, including when a streamed, incomplete definition fails to parse.
    const container = document.createElement('div')
    container.setAttribute('aria-hidden', 'true')
    container.style.cssText = 'position:absolute;top:0;left:0;visibility:hidden;pointer-events:none'
    document.body.append(container)
    try {
      const { svg } = await mermaid.render(`chat-mermaid-${crypto.randomUUID()}`, source, container)
      return svg
    } finally {
      container.remove()
    }
  })
  renderQueue = task.catch(() => {})
  return task
}

export function MermaidDiagram({ source }: { source: string }) {
  const mode = useThemeAttributes()['data-bbb-mode']
  const [rendered, setRendered] = useState<RenderedDiagram | null>(null)
  const result = rendered?.source === source && rendered.mode === mode ? rendered : null

  useEffect(() => {
    let cancelled = false
    // Coalesce streaming updates instead of parsing on every token.
    const timer = setTimeout(() => {
      void renderDiagram(source, mode, () => cancelled).then((svg) => {
        if (!cancelled) setRendered({ source, mode, svg })
      }).catch(() => {
        if (!cancelled) setRendered({ source, mode, svg: null })
      })
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [source, mode])

  const sourceCode = <pre><code className="language-mermaid">{source}</code></pre>
  return <>
    {result?.svg ? <>
      <div className="command-mermaid-diagram" role="img" aria-label="Mermaid diagram"
        dangerouslySetInnerHTML={{ __html: result.svg }} />
      <details className="command-mermaid-source"><summary>View source</summary>{sourceCode}</details>
    </> : <>
      <p className="command-mermaid-status" role="status">{result
        ? 'Unable to render diagram. Showing the source.'
        : 'Rendering diagram…'}</p>
      {sourceCode}
    </>}
  </>
}
