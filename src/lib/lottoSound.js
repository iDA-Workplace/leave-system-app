/**
 * 抽籤畫面的音效：彩球翻滾聲、開出一顆的「叮」、全部開完的小號角。
 *
 * 全部用 Web Audio 即時合成，不需要任何音效檔。瀏覽器規定要使用者「點過」
 * 畫面之後才能出聲，而抽籤一定是管理者按按鈕開始的，所以第一次出聲時才建立
 * AudioContext。瀏覽器不支援就安靜地什麼都不做。
 */

let ctx = null
let noise = null

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    ctx = new AC()
  }
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

/** 一小段逐漸變小的雜訊 = 一聲球碰撞。只做一次，之後重複使用。 */
function noiseBuffer(c) {
  if (!noise) {
    const len = Math.floor(c.sampleRate * 0.03)
    noise = c.createBuffer(1, len, c.sampleRate)
    const d = noise.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3
  }
  return noise
}

function click(c, at) {
  const src = c.createBufferSource()
  src.buffer = noiseBuffer(c)
  const filter = c.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = 1800 + Math.random() * 2400
  const gain = c.createGain()
  gain.gain.value = 0.2 + Math.random() * 0.15
  src.connect(filter).connect(gain).connect(c.destination)
  src.start(at)
}

function tone(freq, delay, duration, type = 'sine', volume = 0.2) {
  const c = audio()
  if (!c) return
  const at = c.currentTime + delay
  const osc = c.createOscillator()
  osc.type = type
  osc.frequency.value = freq
  const gain = c.createGain()
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
  osc.connect(gain).connect(c.destination)
  osc.start(at)
  osc.stop(at + duration + 0.05)
}

/** 彩球在球罐裡翻滾 ms 毫秒 */
export function playRattle(ms) {
  const c = audio()
  if (!c) return
  const end = c.currentTime + ms / 1000
  for (let t = c.currentTime; t < end; t += 0.035 + Math.random() * 0.06) click(c, t)
}

/** 開出一顆 */
export function playDing() {
  tone(880, 0, 0.5)
  tone(1320, 0.09, 0.7)
}

/** 全部開完 */
export function playFanfare() {
  ;[523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.13, i === 3 ? 0.9 : 0.4, 'triangle', 0.18))
}
