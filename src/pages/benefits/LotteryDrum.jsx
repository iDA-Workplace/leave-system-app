import { useEffect, useRef } from 'react'

/**
 * 樂透彩球機：透明球罐裡，每位報名者一顆寫著名字的彩球在翻滾。
 * balls：[{ id, name, color }]，顏色由呼叫端決定（開出來的大球要跟罐子裡同色）。
 *
 * 純粹是視覺效果 —— 誰中籤在按下「抽籤」時就由資料庫決定了，球怎麼滾都不會
 * 影響結果。speedRef.current 控制翻滾的激烈程度（平常慢慢晃、開獎時翻滾），
 * outIds 裡的球已經開出去了，不再顯示。
 *
 * 每一格畫面直接改 DOM 的 transform，不經過 React 重畫，球多也順。
 */
function LotteryDrum({ balls, speedRef, outIds, size = 380 }) {
  const wrapRef = useRef(null)
  const ballSize = Math.max(40, Math.min(64, 76 - balls.length * 1.4))
  const key = balls.map(b => b.id).join('|')

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return undefined
    const els = [...wrap.querySelectorAll('.lotto-ball')]
    const R = size / 2
    const r = ballSize / 2
    const maxR = R - r - 6
    const state = els.map(() => {
      const a = Math.random() * Math.PI * 2
      const d = Math.sqrt(Math.random()) * maxR
      return { x: R + Math.cos(a) * d, y: R + Math.sin(a) * d, vx: Math.random() - 0.5, vy: Math.random() - 0.5 }
    })
    let raf
    const step = () => {
      const s = speedRef.current
      for (let i = 0; i < state.length; i++) {
        const b = state[i]
        b.vy += 0.08 * (1 + s * 0.2)                       // 重力
        b.vx += (Math.random() - 0.5) * 0.9 * s            // 攪拌
        b.vy += (Math.random() - 0.5) * 0.9 * s - 0.05 * s // 攪拌時往上翻
        b.vx *= 0.985
        b.vy *= 0.985
        b.x += b.vx
        b.y += b.vy
        const dx = b.x - R
        const dy = b.y - R
        const d = Math.hypot(dx, dy)
        if (d > maxR) {                                     // 撞到罐壁就反彈
          const nx = dx / d
          const ny = dy / d
          b.x = R + nx * maxR
          b.y = R + ny * maxR
          const dot = b.vx * nx + b.vy * ny
          b.vx = (b.vx - 2 * dot * nx) * 0.85
          b.vy = (b.vy - 2 * dot * ny) * 0.85
        }
        els[i].style.transform = `translate(${b.x - r}px, ${b.y - r}px)`
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [key, size, ballSize, speedRef])

  return (
    <div className="lotto-drum" ref={wrapRef} style={{ width: size, height: size }}>
      {balls.map(b => (
        <div
          key={b.id}
          className={`lotto-ball${outIds.has(b.id) ? ' is-out' : ''}`}
          style={{ width: ballSize, height: ballSize, background: b.color, fontSize: ballSize * 0.26 }}
        >
          <span>{b.name}</span>
        </div>
      ))}
      <div className="lotto-drum__shine" />
    </div>
  )
}

export default LotteryDrum
