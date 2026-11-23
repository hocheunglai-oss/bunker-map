import type { Metadata } from "next"
import { getAdminSession, hasAdminPagePermission } from "@/lib/adminAuth"
import { loadTaskAllocation, type TaskAllocation } from "@/lib/taskAllocation"
import TaskAllocationTable from "./TaskAllocationTable"
import styles from "./taskAllocation.module.css"

export const metadata: Metadata = { title: "Task Allocation - FC Uno" }

const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" })

export default async function TaskAllocationPage() {
  const session = await getAdminSession({ clearInvalidCookie: false })
  if (!hasAdminPagePermission(session, "task-allocation")) return null

  let allocation: TaskAllocation | null = null
  let loadFailed = false
  try {
    allocation = await loadTaskAllocation()
  } catch {
    loadFailed = true
  }

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <h1 id="task-allocation-heading">Task Allocation</h1>
          {allocation && (
            <p>
              Effective{" "}
              <time dateTime={allocation.effectiveDate}>
                {dateFormat.format(new Date(`${allocation.effectiveDate}T00:00:00Z`))}
              </time>
            </p>
          )}
        </header>
        {allocation?.tasks.length ? (
          <TaskAllocationTable allocation={allocation} />
        ) : (
          <p className={styles.status} role={loadFailed ? "alert" : undefined}>
            {loadFailed ? "Task allocation could not load." : "No schedule available."}
          </p>
        )}
      </div>
    </div>
  )
}
