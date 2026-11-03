import { useEffect, useRef } from 'react'

/**
 * 輪盤：每位報名者一格，指針在正上方。
 *
 * 跟彩球機一樣純粹是視覺效果 —— 名次在按下「抽籤」時就由資料庫決定了；
 * 每揭曉一位，輪盤就轉到「已經決定好的那個人」那一格停下。
 *
 * entries：[{ id, name, color }]（順序固定，格子位置不會變）
 * outIds：已經揭曉的人（格子變灰、打勾，但不拿掉 —— 拿掉的話其他格子會跳位置）
 * spinTarget：{ id, key } 要轉到誰；key 每次不同，同一個人也能再轉一次
 * spinMs：轉多久
 * idle：還沒開始揭曉時慢慢自轉
 */
function LotteryWheel({ entries, outIds, spinTarget, spinMs, idle, size = 380 }) {
  // 角度直接改在 SVG 上（不經過 React 狀態），轉動交給 CSS transition
  const svgRef = useRef(null)
  const rotationRef = useRef(0)
  const n = Math.max(entries.length, 1)
  const seg = 360 / n
  // 只有「換了要轉到的人」才轉。名單、格子大小用 ref 讀最新的就好 —— 如果放進
  // 下面的依賴，畫面每次重畫（例如開出結果）都會再轉一次，最後就停不在對的格子上。
  const latest = useRef({ entries, seg, spinMs })
  useEffect(() => { latest.current = { entries, seg, spinMs } })

  useEffect(() => {
    if (!spinTarget) return
    const { entries, seg, spinMs } = latest.current
    const i = entries.findIndex(e => e.id === spinTarget.id)
    if (i < 0) return
    const center = (i + 0.5) * seg
    // 讓這一格的中心停在指針（0 度）：目前角度 + 5 圈 + 補到剛好對齊
    const current = rotationRef.current
    const offset = (((-center - current) % 360) + 360) % 360
    const next = current + 360 * 5 + offset
    rotationRef.current = next
    const svg = svgRef.current
    if (!svg) return
    svg.style.transition = `transform ${spinMs}ms cubic-bezier(0.12, 0.7, 0.1, 1)`
    svg.style.transform = `rotate(${next}deg)`
  }, [spinTarget])

  const c = size / 2
  const r = c - 8
  const point = deg => {
    const a = (deg * Math.PI) / 180
    return [c + r * Math.sin(a), c - r * Math.cos(a)]
  }
  // 名字沿著半徑寫（從中心往外），每一格再窄也不會跟隔壁重疊；字的大小看格子寬度
  const arc = (2 * Math.PI * r * 0.62) / n
  const fontSize = Math.max(10, Math.min(20, arc * 0.62))

  return (
    <div className="lotto-wheel" style={{ width: size, height: size + 18 }}>
      <div className="lotto-wheel__pointer" />
      <div className={`lotto-wheel__idle${idle ? ' is-idle' : ''}`} style={{ width: size, height: size }}>
        <svg ref={svgRef} width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {entries.map((e, i) => {
            const a0 = i * seg
            const a1 = (i + 1) * seg
            const [x0, y0] = point(a0)
            const [x1, y1] = point(a1)
            const large = seg > 180 ? 1 : 0
            const out = outIds.has(e.id)
            const mid = a0 + seg / 2
            return (
              <g key={e.id}>
                <path
                  d={n === 1 ? `M ${c} ${c - r} A ${r} ${r} 0 1 1 ${c - 0.01} ${c - r} Z` : `M ${c} ${c} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`}
                  fill={out ? '#c9c9c9' : e.color} stroke="#fff" strokeWidth="2"
                />
                <text
                  // 右半圈從中心往外讀；左半圈翻過來，字才不會倒著
                  x={mid <= 180 ? c + r * 0.6 : c - r * 0.6} y={c}
                  transform={`rotate(${mid <= 180 ? mid - 90 : mid + 90} ${c} ${c})`}
                  textAnchor="middle" dominantBaseline="middle"
                  fontSize={fontSize} fontWeight="800" fill={out ? '#777' : '#fff'}
                  style={{ paintOrder: 'stroke', stroke: out ? 'none' : 'rgba(0,0,0,.25)', strokeWidth: 3 }}
                >
                  {out ? `✓ ${e.name}` : e.name}
                </text>
              </g>
            )
          })}
          <circle cx={c} cy={c} r={size * 0.08} fill="#fff" stroke="var(--sys-color-outline-variant)" strokeWidth="4" />
        </svg>
      </div>
    </div>
  )
}

export default LotteryWheel
