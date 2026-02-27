import styles from './Header.module.css'

export function Header() {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>◎</span>
          <span className={styles.logoText}>Orpheus TTS</span>
          <span className={styles.version}>v2 · TRT-LLM</span>
        </div>
        <p className={styles.subtitle}>
          High-concurrency speech synthesis · Baseten Engine Builder · H100 MIG
        </p>
      </div>
    </header>
  )
}
