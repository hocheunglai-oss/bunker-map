import type { Metadata } from "next"
import styles from "./attendanceRecord.module.css"

export const metadata: Metadata = {
  title: "ATTENDANCE RECORD - FC Uno",
}

export default function AttendanceRecordPage() {
  return (
    <main className={styles.page}>
      <section className={styles.panel} aria-labelledby="attendance-record-title">
        <div className={styles.status}>UNDER CONSTRUCTION</div>
        <h1 id="attendance-record-title">ATTENDANCE RECORD</h1>
        <p>The automated sign-in, sign-out and leave record is being prepared.</p>
      </section>
    </main>
  )
}
