/**
 * Audio Export Utilities
 * ======================
 * Pure functions for audio data manipulation.
 * No side effects, no service dependencies.
 */

/** Concatenate multiple Float32Array chunks into a single array. */
export function mergeFloat32Chunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
  const merged = new Float32Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

/** Encode Float32 PCM samples into a WAV Blob (16-bit, mono, 24kHz). */
export function encodeWAV(samples: Float32Array, sampleRate = 24000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i))
    }
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')

  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)        // PCM
  view.setUint16(22, 1, true)        // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)        // block align
  view.setUint16(34, 16, true)       // bits per sample

  writeString(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

/** Merge Float32 chunks and encode as WAV. */
export function buildWavFromChunks(chunks: Float32Array[], sampleRate = 24000): Blob {
  return encodeWAV(mergeFloat32Chunks(chunks), sampleRate)
}
