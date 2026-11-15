import { Icon } from 'bbb-design'
import type { IconName } from 'bbb-design'

export function CallIcon({ name, off = false }: { name: 'phone' | 'end' | 'mic' | 'speaker'; off?: boolean }) {
  const icons = {
    phone: 'phone',
    end: 'phone-off',
    mic: off ? 'mic-off' : 'mic',
    speaker: off ? 'volume-x' : 'volume-2',
  } as const satisfies Record<typeof name, IconName>
  return <Icon name={icons[name]} className="vox-call-icon" />
}
