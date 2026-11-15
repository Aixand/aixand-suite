import { useLayoutEffect, useRef, useState } from 'react'
import { Button, SegmentedControl, Switch } from 'bbb-design'
import { Label, Slider, SliderFill, SliderOutput, SliderThumb, SliderTrack } from 'react-aria-components'
import { configOptions, type SessionConfig } from './commands'

export type ResponseSettings = {
  options: SessionConfig[]
  speed?: SessionConfig
  effort?: SessionConfig
  disabled: boolean
  onChange: (id: string, value: string | boolean) => void
  onReset?: () => void
}

export function ReasoningSlider({ option, disabled, onChange }: {
  option: SessionConfig
  disabled: boolean
  onChange: ResponseSettings['onChange']
}) {
  const choices = configOptions(option)
  const current = choices.findIndex(choice => choice.value === option.currentValue)
  const [preview, setPreview] = useState<number | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const position = Math.max(0, Math.min(choices.length - 1, !disabled && preview !== null ? preview : current))
  const label = (disabled || preview === null) && (option.defaultUnknown || current < 0) ? 'Provider default' : choices[position].name
  useLayoutEffect(() => {
    // SliderThumb exposes its range input by ref, but not its aria-valuetext.
    input.current?.setAttribute('aria-valuetext', label)
  })

  return <Slider className="bbb-slider command-reasoning-slider" minValue={0} maxValue={Math.max(1, choices.length - 1)} step={1}
    value={position} isDisabled={disabled || choices.length < 2} onChange={setPreview} onChangeEnd={index => {
      setPreview(null)
      const choice = choices[index]
      if (!disabled && choice && (option.defaultUnknown || choice.value !== option.currentValue)) onChange(option.id, choice.value)
    }}>
    <div className="bbb-slider__heading"><Label>{option.name}</Label><SliderOutput>{label}</SliderOutput></div>
    <SliderTrack className="bbb-slider__track">
      <SliderFill className="bbb-slider__fill" style={{ height: 'var(--bbb-slider-track-height)' }} />
      <SliderThumb className="bbb-slider__thumb" inputRef={input} />
    </SliderTrack>
    {choices.length > 1 && <div className="command-reasoning-levels" aria-hidden="true"><span>{choices[0].name}</span><span>{choices.at(-1)!.name}</span></div>}
  </Slider>
}

export function ChatResponseSettings({ options, speed, effort, disabled, onChange, onReset }: ResponseSettings) {
  return <div className="command-model-settings-controls">
    {options.map(option => {
      const choices = configOptions(option)
      const fast = option === speed ? choices.find(row => ['fast', 'priority'].includes(row.value.toLowerCase())) : undefined
      const normal = option === speed ? choices.find(row => ['default', 'normal', 'standard'].includes(row.value.toLowerCase())) : undefined
      if (option.type === 'boolean' || choices.length === 2 && fast && normal) return <Switch key={option.id}
        label={option === speed ? 'Fast responses' : option.name}
        description={option.defaultUnknown ? 'Provider default' : undefined}
        checked={!option.defaultUnknown && (option.type === 'boolean' ? Boolean(option.currentValue) : option.currentValue === fast?.value)}
        disabled={disabled} onChange={event => onChange(option.id, option.type === 'boolean' ? event.target.checked : event.target.checked ? fast!.value : normal!.value)} />
      if (!choices.length) return null
      if (option === effort) return <ReasoningSlider key={option.id} option={option} disabled={disabled} onChange={onChange} />
      return <div className="command-response-setting" key={option.id}>
        <span className="command-response-setting-label">{option.name}</span>
        {option.defaultUnknown && <small>Provider default</small>}
        <SegmentedControl label={option.name} value={option.defaultUnknown ? undefined : String(option.currentValue)} disabled={disabled}
          options={choices.map(row => ({ value: row.value, label: row.name }))} onChange={value => onChange(option.id, value)} />
      </div>
    })}
    {onReset && <Button size="sm" variant="ghost" disabled={disabled} onPress={onReset}>Use provider defaults</Button>}
  </div>
}
