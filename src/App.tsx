import { useEffect, useState } from 'react'
import { Header } from './components/Header'
import { ParameterPanel } from './components/ParameterPanel'
import { StressTestPanel } from './components/StressTestPanel'
import { useTTSParams } from './hooks/useTTSParams'
import { useWsConnection } from './hooks/useWsConnection'
import { useWebSocketTTS } from './hooks/useWebSocketTTS'
import styles from './App.module.css'

type Tab = 'single' | 'stress'

export default function App() {
  const [tab, setTab] = useState<Tab>('single')
  const [playbackRate, setPlaybackRate] = useState(1.0)
  const { params, update, reset }       = useTTSParams()
  const { connState, connect, disconnect } = useWsConnection()
  const { session, start, stop, clear }  = useWebSocketTTS()

  // Auto-connect on mount
  useEffect(() => { connect() }, [])

  const isConnected = connState === 'connected'

  const handleGenerate = () => {
    if (!params.prompt.trim() || !isConnected) return
    start(params, playbackRate)
  }

  const handleDownload = () => {
    if (!session.audioUrl) return
    const a = document.createElement('a')
    a.href = session.audioUrl
    a.download = `orpheus-${Date.now()}.wav`
    a.click()
  }

  const connDotClass =
    connState === 'connected'   ? styles.connDotConnected
    : connState === 'connecting' ? styles.connDotConnecting
    : styles.connDotDisconnected

  const ttfb  = session.metrics.timeToFirstByteMs != null ? `${session.metrics.timeToFirstByteMs}ms` : '—'
  const total = session.metrics.totalTimeMs != null ? `${(session.metrics.totalTimeMs / 1000).toFixed(2)}s` : '—'
  const audio = session.metrics.audioDurationMs != null ? `${(session.metrics.audioDurationMs / 1000).toFixed(2)}s` : '—'

  return (
    <div className={styles.app}>
      <Header />

      {/* Connection bar */}
      <div className={styles.connectionBar}>
        <div className={`${styles.connDot} ${connDotClass}`} />
        <span className={styles.connLabel}>
          {connState === 'connected' ? 'WebSocket connected'
            : connState === 'connecting' ? 'Connecting…'
            : 'Disconnected'}
        </span>
        {connState === 'connected' ? (
          <button className={styles.connBtn} onClick={disconnect} type="button">Disconnect</button>
        ) : connState !== 'connecting' ? (
          <button className={styles.connBtn} onClick={connect} type="button">Connect</button>
        ) : null}
      </div>

      {/* Tab bar */}
      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${tab === 'single' ? styles.tabActive : ''}`}
          onClick={() => setTab('single')} type="button"
        >
          Single Generation
        </button>
        <button
          className={`${styles.tab} ${tab === 'stress' ? styles.tabActive : ''}`}
          onClick={() => setTab('stress')} type="button"
        >
          Stress Test
        </button>
      </div>

      {/* Single Generation */}
      {tab === 'single' && (
        <div className={styles.mainLayout}>
          <ParameterPanel
            params={params}
            isLoading={session.state === 'connecting' || session.state === 'playing'}
            playbackRate={playbackRate}
            onUpdate={update}
            onPlaybackRateChange={setPlaybackRate}
            onReset={reset}
            onGenerate={handleGenerate}
          />

          <div>
            {session.state !== 'idle' ? (
              <div className={styles.resultCard}>
                <h3 className={styles.resultTitle}>
                  {session.state === 'connecting' ? 'Connecting…'
                    : session.state === 'playing' ? 'Streaming…'
                    : session.state === 'done' ? 'Complete'
                    : session.state === 'error' ? 'Error'
                    : 'Stopped'}
                </h3>

                {/* Metrics */}
                <div className={styles.resultMetrics}>
                  <div className={styles.resultMetric}>
                    <span className={styles.resultMetricValue}>{ttfb}</span>
                    <span className={styles.resultMetricLabel}>TTFB</span>
                  </div>
                  <div className={styles.resultMetric}>
                    <span className={styles.resultMetricValue}>{total}</span>
                    <span className={styles.resultMetricLabel}>Total</span>
                  </div>
                  <div className={styles.resultMetric}>
                    <span className={styles.resultMetricValue}>{audio}</span>
                    <span className={styles.resultMetricLabel}>Audio</span>
                  </div>
                </div>

                {/* Error */}
                {session.error && <div className={styles.resultError}>{session.error}</div>}

                {/* Audio player */}
                {session.state === 'done' && session.audioUrl && (
                  <audio className={styles.resultAudio} controls src={session.audioUrl} />
                )}

                {/* Actions */}
                <div className={styles.resultActions}>
                  {(session.state === 'playing' || session.state === 'connecting') && (
                    <button className={styles.resultClearBtn} onClick={stop} type="button">
                      Stop
                    </button>
                  )}
                  {session.state === 'done' && session.audioUrl && (
                    <button className={styles.resultDownloadBtn} onClick={handleDownload} type="button">
                      ↓ Download WAV
                    </button>
                  )}
                  {(session.state === 'done' || session.state === 'error' || session.state === 'stopped') && (
                    <button className={styles.resultClearBtn} onClick={clear} type="button">
                      Clear
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <p className={styles.empty}>
                Enter text, choose a voice, and click Generate to synthesise speech via WebSocket streaming.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Stress Test */}
      {tab === 'stress' && <StressTestPanel params={params} />}
    </div>
  )
}
