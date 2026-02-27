/**
 * useTTSParams – Parameter management hook
 * ==========================================
 * Isolated state for TTS generation parameters.
 * No side effects, no service calls.
 */

import { useCallback, useState } from 'react'
import { DEFAULT_PARAMS } from '../config/api'
import type { TTSParams } from '../types'

export function useTTSParams() {
  const [params, setParams] = useState<TTSParams>(DEFAULT_PARAMS)

  const update = useCallback(<K extends keyof TTSParams>(key: K, value: TTSParams[K]) => {
    setParams((prev) => ({ ...prev, [key]: value }))
  }, [])

  const reset = useCallback(() => setParams(DEFAULT_PARAMS), [])

  return { params, update, reset }
}
