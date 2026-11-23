"use client"

import { useState } from "react"
import type { TaskAllocation, TaskAllocationRow } from "@/lib/taskAllocation"
import { emptyTaskFilters, TaskAssignmentDialog, TaskFilterDialog, type TaskFilters } from "./TaskAllocationDialogs"
import styles from "./taskAllocation.module.css"

const categories = ["Sales", "Support"] as const

export default function TaskAllocationTable({ allocation, canEdit }: { allocation: TaskAllocation; canEdit: boolean }) {
  const [current, setCurrent] = useState(allocation)
  const [highlighted, setHighlighted] = useState<string[]>([])
  const [filters, setFilters] = useState(emptyTaskFilters)
  const [filterOpen, setFilterOpen] = useState(false)
  const [editing, setEditing] = useState<TaskAllocationRow | null>(null)
  const { people, tasks, btPeople } = current
  const regions = [...new Set(tasks.flatMap((task) => task.region ? [task.region] : []))].sort()
  const hasFilters = Boolean(filters.title || filters.category || filters.region !== null || filters.people.length || filters.group || filters.unassigned)
  const titleQuery = filters.title.toUpperCase()
  const visible = tasks.filter((task) =>
    task.title.toUpperCase().includes(titleQuery) &&
    (!filters.category || task.category === filters.category) &&
    (filters.region === null || (task.region || "") === filters.region) &&
    (
      (!filters.people.length && !filters.group && !filters.unassigned) ||
      (filters.group && task.assignedToBt) ||
      (filters.unassigned && task.assignees.length === 0) ||
      filters.people.some((person) => task.assignees.includes(person))
    ),
  )

  function togglePerson(person: string) {
    setHighlighted((current) => current.includes(person)
      ? current.filter((code) => code !== person)
      : [...current, person])
  }

  function applyFilters(next: TaskFilters) {
    setFilters(next)
    setFilterOpen(false)
  }

  return (
    <div className={styles.panel}>
      <div className={styles.scroll} role="region" aria-label="Task assignments" tabIndex={0} data-admin-view-safe="true">
        <table className={styles.table} aria-labelledby="task-allocation-heading" style={{ "--person-count": people.length } as React.CSSProperties}>
          <thead>
            <tr>
              <th scope="col" className={styles.taskColumn}>
                <div className={styles.taskHeader}>
                  <span>Task</span>
                  <button
                    type="button"
                    className={styles.filterButton}
                    aria-haspopup="dialog"
                    aria-expanded={filterOpen}
                    data-filtered={hasFilters}
                    onClick={() => setFilterOpen(true)}
                  >
                    Filter
                  </button>
                  {highlighted.length > 0 && (
                    <button type="button" className={styles.filterButton} title="Clear highlights" onClick={() => setHighlighted([])}>Clear</button>
                  )}
                </div>
              </th>
              {people.map((person) => (
                <th key={person} scope="col" className={styles.personColumn}>
                  <button
                    type="button"
                    className={styles.personButton}
                    aria-pressed={highlighted.includes(person)}
                    title={`Highlight ${person}`}
                    onClick={() => togglePerson(person)}
                  >
                    {person}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          {categories.map((category) => {
            const rows = visible.filter((task) => task.category === category)
            if (rows.length === 0) return null
            return (
              <tbody key={category}>
                <tr className={styles.category}>
                  <th scope="rowgroup" className={styles.taskColumn}>{category}</th>
                  {people.length > 0 && <td colSpan={people.length} />}
                </tr>
                {rows.map((task) => (
                  <tr
                    key={task.id}
                    onDoubleClick={() => setEditing(task)}
                    className={task.assignees.some((person) => highlighted.includes(person)) ? styles.highlighted : undefined}
                  >
                    <th scope="row" className={styles.taskColumn}>
                      <button type="button" className={styles.taskLine} onClick={() => setEditing(task)} title={[task.title, task.region].filter(Boolean).join(" · ")}>
                        <span className={styles.taskName}>{task.title}</span>
                        {task.region && <span className={styles.region}>{task.region}</span>}
                      </button>
                    </th>
                    {people.map((person) => (
                      <td key={person} className={styles.assignment}>
                        {task.assignees.includes(person) && (
                          <span className={styles.assigned} data-highlighted={highlighted.includes(person)}>
                            {person}
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            )
          })}
          {visible.length === 0 && (
            <tbody>
              <tr><td className={styles.empty} colSpan={people.length + 1}>No matching tasks</td></tr>
            </tbody>
          )}
        </table>
      </div>
      {filterOpen && (
        <TaskFilterDialog filters={filters} people={people} regions={regions} onApply={applyFilters} onClose={() => setFilterOpen(false)} />
      )}
      {editing && (
        <TaskAssignmentDialog
          task={editing}
          people={people}
          btPeople={btPeople}
          canEdit={canEdit}
          onSave={(saved) => { setCurrent(saved); setEditing(null) }}
          onConflict={(latest) => setCurrent((previous) => latest ?? { ...previous, tasks: [] })}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
