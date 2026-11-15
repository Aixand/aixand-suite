import type { ConversationReference } from './model'

const statuses: Record<string, string> = { accepted: 'Message sent', queued: 'Message queued', uncertain: 'Delivery unconfirmed',
  completed: 'Completed', running: 'Running', waiting: 'Waiting for input', failed: 'Failed', removed: 'Queued message removed' }

export function ConversationLinks({ conversations }: { conversations: ConversationReference[] }) {
  if (!conversations.length) return null
  return <nav className="vox-chat-links" aria-label="Chats found by Vox">
    {conversations.map((chat) => <article key={chat.id}>
      <a href={chat.url}>{chat.title}</a>
      <small>{[chat.project, chat.paused ? 'Queue paused' : chat.status && (statuses[chat.status] ?? chat.status),
        chat.updatedAt && new Date(chat.updatedAt).toLocaleString()].filter(Boolean).join(' · ')}</small>
      {chat.parent && <small>Parent: <a href={chat.parent.url}>{chat.parent.title}</a></small>}
      {!!chat.children?.length && <ul aria-label={`Child threads of ${chat.title}`}>
        {chat.children.slice(0, 4).map((child) => <li key={child.id}><a href={child.url}>{child.title}</a>
          {child.status && <small>{statuses[child.status] ?? child.status}</small>}</li>)}
      </ul>}
      {(chat.childCount ?? 0) > 4 && <small>{chat.childCount} child threads · <a href={chat.url}>Open conversation</a></small>}
    </article>)}
  </nav>
}
