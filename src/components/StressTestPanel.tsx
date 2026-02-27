import { useMemo } from 'react'
import { useWebSocketStressTest } from '../hooks/useWebSocketStressTest'
import type { TTSParams } from '../types'
import { StreamingPlayer } from './StreamingPlayer'
import { StatsPanel } from './StatsPanel'
import styles from './StressTestPanel.module.css'

interface Props {
  params: TTSParams
}

export function StressTestPanel({ params }: Props) {
  const { sessions, isRunning, concurrency, setConcurrency, run, stopAll, clear } =
    useWebSocketStressTest()

  const completedCount = useMemo(
    () => sessions.filter((s) => s.state === 'done' || s.state === 'error' || s.state === 'stopped').length,
    [sessions],
  )

  const progress = sessions.length > 0 ? (completedCount / sessions.length) * 100 : 0

  const handleRun = () => {
    if (!params.prompt.trim()) return
    run(params)
  }

  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2 className={styles.title}>Parallel Stress Test</h2>
        <div className={styles.controls}>
          <div className={styles.concurrencyWrap}>
            <label className={styles.concurrencyLabel} htmlFor="concurrency">
              Concurrency
            </label>
            <input
              id="concurrency"
              type="number"
              className={styles.concurrencyInput}
              value={concurrency}
              min={1}
              max={32}
              disabled={isRunning}
              onChange={(e) => setConcurrency(Math.max(1, Math.min(32, Number(e.target.value))))}
            />
          </div>
          {!isRunning ? (
            <button
              className={styles.runBtn}
              disabled={!params.prompt.trim()}
              onClick={handleRun}
              type="button"
            >
              Run {concurrency}× Parallel
            </button>
          ) : (
            <button className={styles.stopBtn} onClick={stopAll} type="button">
              Stop All
            </button>
          )}
          <button
            className={styles.clearBtn}
            onClick={clear}
            disabled={isRunning}
            type="button"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {sessions.length > 0 && (
        <div className={styles.progressWrap}>
          <div className={styles.progressBar}>
            <div className={styles.progressFill} style={{ width: `${progress}%` }} />
          </div>
          <span className={styles.progressLabel}>
            {completedCount} / {sessions.length} completed
          </span>
        </div>
      )}

      {/* Stats */}
      {sessions.length > 0 && <StatsPanel sessions={sessions} />}

      {/* Results grid */}
      {sessions.length > 0 ? (
        <div className={styles.resultsGrid}>
          {sessions.map((session, i) => (
            <StreamingPlayer key={session.id} session={session} index={i} />
          ))}
        </div>
      ) : (
        <p className={styles.empty}>
          Configure concurrency, set parameters above, and click Run to execute a true parallel stress test.
          All requests fire simultaneously — no client-side stagger.
        </p>
      )}
    </section>
  )
}
