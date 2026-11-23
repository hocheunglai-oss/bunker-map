"use client"

import { useState } from "react"
import type { TaskAllocation } from "@/lib/taskAllocation"
import styles from "./taskAllocation.module.css"

const categories = ["Sales", "Support"] as const

export default function TaskAllocationTable({ allocation }: { allocation: TaskAllocation }) {
  const [highlighted, setHighlighted] = useState<string[]>([])
  const { people, tasks } = allocation

  function togglePerson(person: string) {
    setHighlighted((current) => current.includes(person)
      ? current.filter((code) => code !== person)
      : [...current, person])
  }

  return (
    <div className={styles.panel} data-admin-view-safe="true">
      {highlighted.length > 0 && (
        <div className={styles.actions}>
          <button type="button" onClick={() => setHighlighted([])}>Clear</button>
        </div>
      )}
      <div className={styles.scroll} role="region" aria-label="Task assignments" tabIndex={0}>
        <table className={styles.table} aria-labelledby="task-allocation-heading">
          <thead>
            <tr>
              <th scope="col" className={styles.taskColumn}>Task</th>
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
            const rows = tasks.filter((task) => task.category === category)
            if (rows.length === 0) return null
            return (
              <tbody key={category}>
                <tr className={styles.category}>
                  <th scope="rowgroup" className={styles.taskColumn}>{category}</th>
                  {people.length > 0 && <td colSpan={people.length} />}
                </tr>
                {rows.map((task) => (
                  <tr key={task.id} className={task.assignees.some((person) => highlighted.includes(person)) ? styles.highlighted : undefined}>
                    <th scope="row" className={styles.taskColumn}>
                      {task.title}
                      {task.region && task.region !== task.title && <span className={styles.region}>{task.region}</span>}
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
        </table>
      </div>
    </div>
  )
}
