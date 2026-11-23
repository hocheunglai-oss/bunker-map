import type { Metadata } from "next"
import { getAdminSession, hasAdminPagePermission } from "@/lib/adminAuth"
import { loadTaskAllocation, type TaskAllocation } from "@/lib/taskAllocation"
import TaskAllocationTable from "./TaskAllocationTable"
import styles from "./taskAllocation.module.css"

export const metadata: Metadata = { title: "Task Allocation - FC Uno" }

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
        <h1 id="task-allocation-heading" className="sr-only">Task Allocation</h1>
        {allocation?.tasks.length ? (
          <TaskAllocationTable allocation={allocation} canEdit={hasAdminPagePermission(session, "task-allocation", "edit")} />
        ) : (
          <p className={styles.status} role={loadFailed ? "alert" : undefined}>
            {loadFailed ? "Task allocation could not load." : "No schedule available."}
          </p>
        )}
      </div>
    </div>
  )
}
