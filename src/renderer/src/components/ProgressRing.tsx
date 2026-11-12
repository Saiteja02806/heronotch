import type { ReactNode } from 'react'

export function ProgressRing({
  progress,
  size = 120,
  stroke = 8,
  color = 'var(--accent)',
  track = 'rgba(255,255,255,.12)',
  children,
  className = ''
}: {
  progress: number
  size?: number
  stroke?: number
  color?: string
  track?: string
  children?: ReactNode
  className?: string
}) {
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const dash = circumference * Math.max(0, Math.min(1, progress))
  return (
    <div className={`progress-ring ${className}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={track}
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap={dash > 0.5 ? 'round' : 'butt'}
          strokeDasharray={`${dash} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className="ring-value"
        />
      </svg>
      <div className="progress-ring-content">{children}</div>
    </div>
  )
}
