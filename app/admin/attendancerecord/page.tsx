import type { Metadata } from "next"
import AttendanceRecordClient from "./AttendanceRecordClient"

export const metadata: Metadata = {
  title: "ATTENDANCE RECORD - FC Uno",
}

export default function AttendanceRecordPage() {
  return <AttendanceRecordClient />
}
