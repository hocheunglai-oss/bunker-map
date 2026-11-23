"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import type { TaskAllocation, TaskAllocationRow } from "@/lib/taskAllocation"
import styles from "./taskAllocation.module.css"

export type TaskFilters = {
  title: string
  category: string
  region: string | null
  people: string[]
  group: boolean
  unassigned: boolean
}

export const emptyTaskFilters: TaskFilters = { title: "", category: "", region: null, people: [], group: false, unassigned: false }

function TaskDialog({ children, labelId, pending, onClose }: {
  children: ReactNode
  labelId: string
  pending?: boolean
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    dialog.showModal()
    return () => dialog.close()
  }, [])

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={labelId}
      onCancel={(event) => {
        event.preventDefault()
        if (!pending) onClose()
      }}
    >
      {children}
    </dialog>
  )
}

export function TaskFilterDialog({ filters, people, regions, onApply, onClose }: {
  filters: TaskFilters
  people: string[]
  regions: string[]
  onApply: (filters: TaskFilters) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(filters)

  return (
    <TaskDialog labelId="task-filter-title" onClose={onClose}>
      <div data-admin-view-safe="true">
        <h2 id="task-filter-title">Filter Tasks</h2>
        <label className={styles.field}>
          Task
          <input type="search" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
        </label>
        <div className={styles.filterFields}>
          <label className={styles.field}>
            Category
            <select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>
              <option value="">All</option>
              <option value="Sales">Sales</option>
              <option value="Support">Support</option>
            </select>
          </label>
          <label className={styles.field}>
            Region
            <select value={draft.region ?? "all"} onChange={(event) => setDraft({ ...draft, region: event.target.value === "all" ? null : event.target.value })}>
              <option value="all">All</option>
              <option value="">Blank</option>
              {regions.map((region) => <option key={region} value={region}>{region}</option>)}
            </select>
          </label>
        </div>
        <fieldset className={styles.picker}>
          <legend>PIC</legend>
          <button type="button" className={styles.pill} aria-pressed={draft.group} onClick={() => setDraft({ ...draft, group: !draft.group })}>BT</button>
          <button type="button" className={styles.pill} aria-pressed={draft.unassigned} onClick={() => setDraft({ ...draft, unassigned: !draft.unassigned })}>Unassigned</button>
          {people.map((person) => (
            <button
              key={person}
              type="button"
              className={styles.pill}
              aria-pressed={draft.people.includes(person)}
              onClick={() => setDraft({ ...draft, people: draft.people.includes(person) ? draft.people.filter((code) => code !== person) : [...draft.people, person] })}
            >
              {person}
            </button>
          ))}
        </fieldset>
        <div className={styles.dialogActions}>
          <button type="button" className={styles.clearButton} onClick={() => onApply(emptyTaskFilters)}>Clear</button>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className={styles.primaryButton} onClick={() => onApply({ ...draft, title: draft.title.trim() })}>Apply</button>
        </div>
      </div>
    </TaskDialog>
  )
}

export function TaskAssignmentDialog({ task, people, btPeople, canEdit, onSave, onConflict, onClose }: {
  task: TaskAllocationRow
  people: string[]
  btPeople: string[]
  canEdit: boolean
  onSave: (allocation: TaskAllocation) => void
  onConflict: (allocation: TaskAllocation | null) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState({ group: task.assignedToBt, direct: task.directAssignees })
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [message, setMessage] = useState("")
  const inFlight = useRef(false)
  const selected = new Set([...draft.direct, ...(draft.group ? btPeople : [])])

  function togglePerson(person: string) {
    if (draft.group && btPeople.includes(person)) {
      setDraft({ group: false, direct: [...selected].filter((code) => code !== person) })
    } else {
      setDraft({ ...draft, direct: selected.has(person) ? draft.direct.filter((code) => code !== person) : [...draft.direct, person] })
    }
  }

  async function save() {
    if (!canEdit || inFlight.current || conflict) return
    inFlight.current = true
    setSaving(true)
    setMessage("")
    try {
      const response = await fetch("/api/admin/task-allocation", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: task.id,
          version: task.version,
          assignees: [...draft.direct, ...(draft.group ? ["BT"] : [])],
        }),
      })
      const result = await response.json().catch(() => null)
      if (response.status === 409) {
        setConflict(true)
        onConflict(result?.allocation ?? null)
      }
      if (!response.ok || !result?.allocation) {
        setMessage(result?.message || "Assignments could not be saved. Try again.")
        return
      }
      onSave(result.allocation)
    } catch {
      setMessage("Assignments could not be saved. Try again.")
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return (
    <TaskDialog labelId="task-assignment-title" pending={saving} onClose={onClose}>
      <h2 id="task-assignment-title">{task.title}</h2>
      {task.region && <p className={styles.dialogRegion}>{task.region}</p>}
      <fieldset className={styles.picker} disabled={!canEdit || saving || conflict}>
        <legend>PIC</legend>
        {btPeople.length > 0 && (
          <button
            type="button"
            className={styles.pill}
            aria-pressed={draft.group}
            title="BT group"
            onClick={() => setDraft({ ...draft, group: !draft.group })}
          >
            BT
          </button>
        )}
        {people.map((person) => (
          <button
            key={person}
            type="button"
            className={styles.pill}
            aria-pressed={selected.has(person)}
            onClick={() => togglePerson(person)}
          >
            {person}
          </button>
        ))}
      </fieldset>
      {message && <p className={styles.error} role="alert">{message}</p>}
      <div className={styles.dialogActions} data-admin-view-safe={!canEdit ? "true" : undefined}>
        <button type="button" disabled={saving} onClick={onClose}>{canEdit ? "Cancel" : "Close"}</button>
        {canEdit && <button type="button" className={styles.primaryButton} disabled={saving || conflict} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>}
      </div>
    </TaskDialog>
  )
}
