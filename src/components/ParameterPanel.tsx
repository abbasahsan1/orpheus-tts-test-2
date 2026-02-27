import { useRef } from 'react'
import { PARAM_LIMITS, VOICES } from '../config/api'
import type { TTSParams, VoiceId } from '../types'
import styles from './ParameterPanel.module.css'

const EMOTION_TAGS = [
  '<laugh>', '<chuckle>', '<sigh>', '<cough>',
  '<sniffle>', '<groan>', '<yawn>', '<gasp>',
] as const

interface Props {
  params: TTSParams
  isLoading: boolean
  playbackRate: number
  streamingMode: boolean
  onUpdate: <K extends keyof TTSParams>(key: K, value: TTSParams[K]) => void
  onPlaybackRateChange: (rate: number) => void
  onStreamingModeChange: (streaming: boolean) => void
  onReset: () => void
  onGenerate: () => void
}

export function ParameterPanel({
  params, isLoading, playbackRate, streamingMode,
  onUpdate, onPlaybackRateChange, onStreamingModeChange, onReset, onGenerate,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const insertTag = (tag: string) => {
    const el = textareaRef.current
    if (!el) { onUpdate('prompt', params.prompt + tag); return }
    const start = el.selectionStart ?? params.prompt.length
    const end   = el.selectionEnd   ?? params.prompt.length
    const next  = params.prompt.slice(0, start) + tag + params.prompt.slice(end)
    onUpdate('prompt', next)
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + tag.length
      el.focus()
    })
  }

  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2 className={styles.title}>Parameters</h2>
        <button className={styles.resetBtn} onClick={onReset} type="button">Reset</button>
      </div>

      {/* Prompt */}
      <div className={styles.field}>
        <label className={styles.label} htmlFor="prompt">Prompt</label>
        <textarea
          ref={textareaRef}
          id="prompt"
          className={styles.textarea}
          value={params.prompt}
          rows={5}
          placeholder="Enter text to synthesise…"
          onChange={(e) => onUpdate('prompt', e.target.value)}
        />
        <div className={styles.promptFooter}>
          <span className={styles.hint}>{params.prompt.length} chars</span>
          <div className={styles.emotionTags}>
            {EMOTION_TAGS.map((tag) => (
              <button
                key={tag} type="button"
                className={styles.emotionTag}
                onClick={() => insertTag(tag)}
                title={`Insert ${tag}`}
              >{tag}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Voice Selection */}
      <div className={styles.field}>
        <label className={styles.label}>Voice</label>
        <div className={styles.voiceGrid}>
          {VOICES.map((v) => (
            <button
              key={v.id} type="button"
              className={`${styles.voiceBtn} ${params.voice === v.id ? styles.voiceBtnActive : ''}`}
              onClick={() => onUpdate('voice', v.id as VoiceId)}
            >
              {v.label}
              <span className={styles.voiceGender}>{v.gender}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Max Tokens */}
      <div className={styles.field}>
        <div className={styles.labelRow}>
          <label className={styles.label} htmlFor="max_tokens">Max Tokens</label>
          <input
            type="number"
            className={styles.numberInput}
            value={params.max_tokens}
            min={PARAM_LIMITS.max_tokens.min}
            max={PARAM_LIMITS.max_tokens.max}
            step={PARAM_LIMITS.max_tokens.step}
            onChange={(e) =>
              onUpdate('max_tokens', Math.max(PARAM_LIMITS.max_tokens.min, Math.min(PARAM_LIMITS.max_tokens.max, Number(e.target.value))))
            }
          />
        </div>
        <input
          id="max_tokens" type="range" className={styles.slider}
          value={params.max_tokens}
          min={PARAM_LIMITS.max_tokens.min}
          max={PARAM_LIMITS.max_tokens.max}
          step={PARAM_LIMITS.max_tokens.step}
          onChange={(e) => onUpdate('max_tokens', Number(e.target.value))}
        />
        <div className={styles.sliderLabels}>
          <span>{PARAM_LIMITS.max_tokens.min}</span>
          <span>{PARAM_LIMITS.max_tokens.max}</span>
        </div>
      </div>

      {/* Repetition Penalty */}
      <div className={styles.field}>
        <div className={styles.labelRow}>
          <label className={styles.label} htmlFor="rep_penalty">Repetition Penalty</label>
          <input
            type="number"
            className={styles.numberInput}
            value={params.repetition_penalty}
            min={PARAM_LIMITS.repetition_penalty.min}
            max={PARAM_LIMITS.repetition_penalty.max}
            step={PARAM_LIMITS.repetition_penalty.step}
            onChange={(e) =>
              onUpdate('repetition_penalty', Math.max(PARAM_LIMITS.repetition_penalty.min, Math.min(PARAM_LIMITS.repetition_penalty.max, Number(e.target.value))))
            }
          />
        </div>
        <input
          id="rep_penalty" type="range" className={styles.slider}
          value={params.repetition_penalty}
          min={PARAM_LIMITS.repetition_penalty.min}
          max={PARAM_LIMITS.repetition_penalty.max}
          step={PARAM_LIMITS.repetition_penalty.step}
          onChange={(e) => onUpdate('repetition_penalty', Number(e.target.value))}
        />
        <div className={styles.sliderLabels}>
          <span>{PARAM_LIMITS.repetition_penalty.min}</span>
          <span>{PARAM_LIMITS.repetition_penalty.max}</span>
        </div>
        <p className={styles.hint}>≥ 1.1 recommended for stable output.</p>
      </div>

      {/* Playback Speed */}
      <div className={styles.field}>
        <div className={styles.labelRow}>
          <label className={styles.label} htmlFor="playback_rate">Playback Speed</label>
          <span className={styles.speedBadge}>{playbackRate.toFixed(1)}×</span>
        </div>
        <input
          id="playback_rate" type="range" className={styles.slider}
          value={playbackRate} min={0.5} max={2.0} step={0.1}
          onChange={(e) => onPlaybackRateChange(Number(e.target.value))}
        />
        <div className={styles.sliderLabels}>
          <span>0.5×</span>
          <span>1.0×</span>
          <span>2.0×</span>
        </div>
        <p className={styles.hint}>Client-side only — does not affect generation.</p>
      </div>

      {/* Streaming Mode */}
      <div className={styles.field}>
        <div className={styles.labelRow}>
          <label className={styles.label}>Playback Mode</label>
          <button
            type="button"
            className={`${styles.streamingToggle} ${streamingMode ? styles.streamingToggleOn : styles.streamingToggleOff}`}
            onClick={() => onStreamingModeChange(!streamingMode)}
            aria-pressed={streamingMode}
          >
            {streamingMode ? '▶ Real-time Streaming' : '⏸ Buffered (play after done)'}
          </button>
        </div>
        <p className={styles.hint}>
          {streamingMode
            ? 'Audio plays immediately as it arrives — lowest perceived latency.'
            : 'All audio is buffered first, then played as one continuous clip.'}
        </p>
      </div>

      {/* Generate */}
      <button
        className={styles.generateBtn}
        disabled={isLoading || !params.prompt.trim()}
        onClick={onGenerate}
        type="button"
      >
        {isLoading ? (
          <><span className={styles.spinner} /> Generating…</>
        ) : (
          'Generate Speech'
        )}
      </button>
    </section>
  )
}
