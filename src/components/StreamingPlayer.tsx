import type { StreamingSession } from '../types'
import styles from './StreamingPlayer.module.css'

interface Props {
  session: StreamingSession
  index: number
  onAbort?: () => void
}

export function StreamingPlayer({ session, index, onAbort }: Props) {
  const handleDownload = () => {
    if (!session.audioUrl) return
    const a = document.createElement('a')
    a.href = session.audioUrl
    a.download = `orpheus-slot${index}-${Date.now()}.wav`
    a.click()
  }

  const statusClass =
    session.state === 'playing' ? styles.statusStreaming
    : session.state === 'done' ? styles.statusDone
    : session.state === 'error' ? styles.statusError : ''

  const statusText =
    session.state === 'playing' ? 'Streaming'
    : session.state === 'done' ? 'Done'
    : session.state === 'error' ? 'Error'
    : session.state === 'connecting' ? 'Connecting'
    : session.state === 'stopped' ? 'Stopped'
    : 'Idle'

  const ttfb  = session.metrics.timeToFirstByteMs != null ? `${session.metrics.timeToFirstByteMs}ms` : '—'
  const total = session.metrics.totalTimeMs != null ? `${(session.metrics.totalTimeMs / 1000).toFixed(2)}s` : '—'
  const audio = session.metrics.audioDurationMs != null ? `${(session.metrics.audioDurationMs / 1000).toFixed(2)}s` : '—'
  const bytesKB = session.metrics.bytesReceived > 0
    ? `${(session.metrics.bytesReceived / 1024).toFixed(1)} KB`
    : '—'

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.slotLabel}>Slot {index}</span>
        <span className={`${styles.statusBadge} ${statusClass}`}>{statusText}</span>
      </div>

      {/* Byte progress indicator */}
      <div className={styles.waveformWrap}>
        {session.metrics.bytesReceived > 0 ? (
          <div className={styles.waveformEmpty} style={{ color: 'var(--accent, #89b4fa)' }}>
            {bytesKB} received
          </div>
        ) : (
          <div className={styles.waveformEmpty}>Waiting for audio…</div>
        )}
      </div>

      {/* Metrics */}
      <div className={styles.metrics}>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{ttfb}</span>
          <span className={styles.metricLabel}>TTFB</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{total}</span>
          <span className={styles.metricLabel}>Total</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{audio}</span>
          <span className={styles.metricLabel}>Audio</span>
        </div>
      </div>

      {/* Error */}
      {session.error && <div className={styles.errorMsg}>{session.error}</div>}

      {/* Actions */}
      <div className={styles.actions}>
        {(session.state === 'playing' || session.state === 'connecting') && onAbort && (
          <button className={styles.abortBtn} onClick={onAbort} type="button">Abort</button>
        )}
        {session.state === 'done' && session.audioUrl && (
          <>
            <audio className={styles.audioElement} controls src={session.audioUrl} />
            <button className={styles.downloadBtn} onClick={handleDownload} type="button">
              ↓ WAV
            </button>
          </>
        )}
      </div>
    </div>
  )
}
