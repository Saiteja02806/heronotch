import { PhoneTransfer } from '../components/PhoneTransfer'

/** The Phone section: the transfer flow as its own page on the notch bar,
 * spread across the full panel — compose on the left, scan zone on the right. */
export function PhonePage() {
  return (
    <div className="phone-page">
      <div className="day-title phone-head">
        <span className="eyebrow">Same Wi-Fi</span>
        <h1>Meet your phone halfway.</h1>
        <p>
          Send files and text both ways by scanning the code. Your phone must be on the same
          Wi-Fi as this laptop, and nothing is uploaded to a server.
        </p>
      </div>
      <PhoneTransfer bare section split />
    </div>
  )
}
