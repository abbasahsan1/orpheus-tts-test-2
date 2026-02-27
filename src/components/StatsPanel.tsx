import { useMemo } from 'react'
import type { StreamingSession } from '../types'
import styles from './StatsPanel.module.css'

interface Props {
  sessions: StreamingSession[]
}

export function StatsPanel({ sessions }: Props) {
  const stats = useMemo(() => {
    const done = sessions.filter((s) => s.state === 'done' && s.metrics.timeToFirstByteMs != null)
    if (done.length === 0) return null

    const ttfbs = done.map((s) => s.metrics.timeToFirstByteMs!)
    const totals = done.map((s) => s.metrics.totalTimeMs ?? 0)
    const errors = sessions.filter((s) => s.error).length

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length
    const min = (arr: number[]) => Math.min(...arr)
    const max = (arr: number[]) => Math.max(...arr)
    const p50 = (arr: number[]) => {
      const sorted = [...arr].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    }

    return {
      count: done.length,
      errors,
      avgTtfb: Math.round(avg(ttfbs)),
      minTtfb: Math.round(min(ttfbs)),
      maxTtfb: Math.round(max(ttfbs)),
      p50Ttfb: Math.round(p50(ttfbs)),
      avgTotal: Math.round(avg(totals)),
      minTotal: Math.round(min(totals)),
      maxTotal: Math.round(max(totals)),
    }
  }, [sessions])

  if (!stats) {
    return (
      <div className={styles.panel}>
        <h3 className={styles.title}>Aggregate Statistics</h3>
        <p className={styles.empty}>No completed sessions yet.</p>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <h3 className={styles.title}>Aggregate Statistics</h3>
      <div className={styles.grid}>
        <div className={styles.stat}>
          <span className={styles.statValue}>{stats.count}</span>
          <span className={styles.statLabel}>Completed</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{stats.errors}</span>
          <span className={styles.statLabel}>Errors</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{stats.avgTtfb}ms</span>
          <span className={styles.statLabel}>Avg TTFB</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{stats.p50Ttfb}ms</span>
          <span className={styles.statLabel}>P50 TTFB</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{stats.minTtfb}ms</span>
          <span className={styles.statLabel}>Min TTFB</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{stats.maxTtfb}ms</span>
          <span className={styles.statLabel}>Max TTFB</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{(stats.avgTotal / 1000).toFixed(2)}s</span>
          <span className={styles.statLabel}>Avg Total</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{(stats.minTotal / 1000).toFixed(2)}s</span>
          <span className={styles.statLabel}>Min Total</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{(stats.maxTotal / 1000).toFixed(2)}s</span>
          <span className={styles.statLabel}>Max Total</span>
        </div>
      </div>
    </div>
  )
}
