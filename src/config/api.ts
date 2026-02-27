import type { VoiceId, VoiceOption, TTSParams } from '../types'

// ─── API ──────────────────────────────────────────────────────────────────────

export const API_BASE = '/api'
export const HEALTH_ENDPOINT = `${API_BASE}/health`

// ─── Voice Catalog ────────────────────────────────────────────────────────────
// Fine-tuned named voices from baseten/orpheus-3b-0.1-ft
// No cloning — all voices are baked into the model.

export const VOICES: VoiceOption[] = [
  { id: 'tara',  label: 'Tara',  gender: 'Female' },
  { id: 'leah',  label: 'Leah',  gender: 'Female' },
  { id: 'jess',  label: 'Jess',  gender: 'Female' },
  { id: 'mia',   label: 'Mia',   gender: 'Female' },
  { id: 'zoe',   label: 'Zoe',   gender: 'Female' },
  { id: 'leo',   label: 'Leo',   gender: 'Male'   },
  { id: 'dan',   label: 'Dan',   gender: 'Male'   },
  { id: 'zac',   label: 'Zac',   gender: 'Male'   },
]

// ─── Parameter Defaults ───────────────────────────────────────────────────────

export const DEFAULT_PARAMS: TTSParams = {
  voice: 'tara' as VoiceId,
  prompt:
    'Nothing beside remains. Round the decay of that colossal wreck, boundless and bare, the lone and level sands stretch far away.',
  max_tokens: 2000,
  repetition_penalty: 1.1,
}

export const PARAM_LIMITS = {
  max_tokens: { min: 100, max: 10000, step: 100 },
  repetition_penalty: { min: 1.0, max: 2.0, step: 0.05 },
}

export const STRESS_TEST_LIMITS = { min: 1, max: 32 }
