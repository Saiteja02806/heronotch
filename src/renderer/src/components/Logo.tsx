export function Logo({ size = 24 }: { size?: number }) {
  return (
    <span className="logo-mark" style={{ width: size, height: size }} aria-hidden="true">
      <span className="logo-notch" />
      <span className="logo-dot" />
    </span>
  )
}
