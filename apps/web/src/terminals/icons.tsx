import { Icon } from 'bbb-design'
import type { IconName } from 'bbb-design'

const terminalIcons = {
  back: 'arrow-left',
  terminal: 'square-terminal',
  plus: 'plus',
  close: 'x',
  sidebar: 'panel-left',
  inspector: 'panel-right',
  right: 'columns-2',
  down: 'rows-2',
  maximize: 'maximize',
  restore: 'minimize',
  refresh: 'refresh-cw',
  fullscreen: 'expand',
} as const satisfies Record<string, IconName>

export type TerminalIconName = keyof typeof terminalIcons

export function TerminalIcon({ name }: { name: TerminalIconName }) {
  return <Icon name={terminalIcons[name]} />
}
