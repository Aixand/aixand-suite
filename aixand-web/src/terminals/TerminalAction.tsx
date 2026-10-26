import { Button, Tooltip } from 'bbb-design'
import type { ButtonProps } from 'bbb-design'
import { TerminalIcon } from './icons'
import type { TerminalIconName } from './icons'

type TerminalActionProps = Omit<ButtonProps, 'children' | 'aria-label' | 'variant' | 'size' | 'iconOnly'> & {
  label: string
  hint?: string
  icon: TerminalIconName
}

export function TerminalAction({ label, hint, icon, ...props }: TerminalActionProps) {
  return (
    <Tooltip content={hint ?? label}>
      <Button {...props} variant="ghost" size="sm" iconOnly aria-label={label}>
        <TerminalIcon name={icon} />
      </Button>
    </Tooltip>
  )
}
