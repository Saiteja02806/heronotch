/**
 * A short, soft two-note chime for posture nudges.
 *
 * It is synthesised with WebAudio so the app stays self-contained (no audio
 * asset to load) and stays quiet: two sine notes around 70 ms of gain each.
 * Browsers only allow audio after a gesture, but the user turns the coach on
 * with a click, and Electron allows autoplay by default.
 */

let context: AudioContext | null = null

export function playPostureRing(): void {
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    context ??= new Ctor()
    const audio = context
    if (audio.state === 'suspended') void audio.resume()

    const start = audio.currentTime + 0.01
    const master = audio.createGain()
    master.gain.value = 0.12
    master.connect(audio.destination)

    const note = (frequency: number, offset: number, length: number): void => {
      const oscillator = audio.createOscillator()
      const gain = audio.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(frequency, start + offset)
      gain.gain.setValueAtTime(0.0001, start + offset)
      gain.gain.exponentialRampToValueAtTime(1, start + offset + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + length)
      oscillator.connect(gain)
      gain.connect(master)
      oscillator.start(start + offset)
      oscillator.stop(start + offset + length + 0.04)
    }

    note(880, 0, 0.22)
    note(659.25, 0.16, 0.3)

    window.setTimeout(() => master.disconnect(), 1200)
  } catch {
    // Sound is a nicety; never let it break the coach.
  }
}
