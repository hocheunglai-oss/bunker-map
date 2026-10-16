"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import {
  CCINFO_INDEX_CONFIG, CCINFO_INDEX_PAGE_SIZE, buildCcinfoIndexSearchFilter,
  parseCcinfoIndexResult,
  type CcinfoIndexKind, type CcinfoIndexRow,
} from "@/lib/ccinfoIndex"
import { CcinfoDeleteError, deleteCcinfoRecord } from "@/lib/ccinfoDelete"
import styles from "./ccinfoIndex.module.css"

const labels = {
  company: { singular: "Company", plural: "companies", path: "companies" },
  country: { singular: "Country", plural: "countries", path: "countries" },
  port: { singular: "Port", plural: "ports", path: "ports" },
} as const
type Selection = { query: string; page: number }
type VerifiedIndex = { rows: CcinfoIndexRow[]; count: number; page: number; totalPages: number; checkedAt: string }
const checkedTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Hong_Kong", dateStyle: "medium", timeStyle: "medium" })

export function CcinfoIndexPage({ kind }: { kind: CcinfoIndexKind }) {
  const auth = useSimpleAdminAuth()
  const canView = isAdminRole(auth.role) || canAccessAdminPage(auth.permissions, "ccinfo", "view")
  const canEdit = isAdminRole(auth.role) || canAccessAdminPage(auth.permissions, "ccinfo", "edit")
  if (auth.loading) return <p className={styles.access}>Loading...</p>
  if (!auth.authenticated || auth.resetRequired || !canView) return <p className={styles.access}>Access Denied</p>
  return <IndexBrowser key={JSON.stringify([kind, auth.username, auth.role, auth.permissions.ccinfo])} kind={kind} canEdit={canEdit} />
}

function IndexBrowser({ kind, canEdit }: { kind: CcinfoIndexKind; canEdit: boolean }) {
  const [selection, setSelection] = useState<Selection>({ query: "", page: 1 })
  const onPage = useCallback((page: number) => setSelection(current => ({ ...current, page })), [])
  const label = labels[kind]
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <h1 className={styles.heading}>{label.singular} Index</h1>
        <nav className={styles.nav} aria-label="CCINFO indexes">
          {(["country", "port", "company"] as const).map(item => (
            <a key={item} href={`/admin/ccinfo/${labels[item].path}`} aria-current={kind === item ? "page" : undefined}>{labels[item].singular} Index</a>
          ))}
        </nav>
        <div className={styles.search}>
          <label htmlFor="ccinfo-index-filter">Filter {label.plural}</label>
          <input id="ccinfo-index-filter" type="search" value={selection.query} maxLength={200}
            placeholder={`Filter ${label.plural}...`}
            onChange={event => setSelection({ query: event.target.value, page: 1 })} />
        </div>
        {/* A new selection owns fresh results; old rows never appear under a new search/page. */}
        <IndexResults key={JSON.stringify(selection)} kind={kind} selection={selection} canEdit={canEdit} onPage={onPage} />
      </div>
    </main>
  )
}

function IndexResults({ kind, selection, canEdit, onPage }: {
  kind: CcinfoIndexKind; selection: Selection; canEdit: boolean; onPage: (page: number) => void
}) {
  const config = CCINFO_INDEX_CONFIG[kind], label = labels[kind]
  const [verified, setVerified] = useState<VerifiedIndex | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState("")
  const [deleting, setDeleting] = useState<string | null>(null)
  const readOwner = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const deleteOwner = useRef<object | null>(null)
  const query = selection.query.trim(), page = selection.page

  const load = useCallback(async (owner: AbortController) => {
    const owns = () => mounted.current && readOwner.current === owner && !owner.signal.aborted
    let timeout: number | undefined
    let abort: () => void = () => {}
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("Request cancelled"))
      owner.signal.addEventListener("abort", abort, { once: true })
      timeout = window.setTimeout(() => {
        reject(new Error("Results timed out"))
        owner.abort()
      }, 30000)
    })
    try {
      let request = supabase.from(config.table).select(config.select, { count: "exact" })
      for (const field of config.orderFields) request = request.order(field, { ascending: true })
      if (query) request = request.or(buildCcinfoIndexSearchFilter(kind, query))
      const from = (page - 1) * CCINFO_INDEX_PAGE_SIZE
      const result = await Promise.race([interrupted, request.range(from, from + CCINFO_INDEX_PAGE_SIZE - 1).abortSignal(owner.signal)])
      if (!owns()) return
      if (result.status === 401 || result.status === 403) {
        setVerified(null)
        setMessage("Your access could not be verified. Please sign in again or check your access.")
        return
      }
      // PostgREST may omit the exact count on an invalidated final page.
      // Reconcile from page one, never invent a zero count from that error.
      if (result.status === 416 && page > 1) { onPage(1); return }
      const report = parseCcinfoIndexResult(result, kind, page)
      if (report.page !== page) { onPage(report.page); return }
      setVerified({ ...report, checkedAt: new Date().toISOString() })
    } catch {
      if (mounted.current && readOwner.current === owner) setMessage("Results could not be verified. Please refresh to retry.")
    } finally {
      window.clearTimeout(timeout)
      owner.signal.removeEventListener("abort", abort)
      if (mounted.current && readOwner.current === owner) { setLoading(false); readOwner.current = null }
    }
  }, [config, kind, page, query, onPage])

  const refresh = useCallback(() => {
    readOwner.current?.abort()
    const owner = new AbortController()
    readOwner.current = owner
    setLoading(true)
    setMessage("")
    void load(owner)
  }, [load])

  useEffect(() => {
    mounted.current = true
    const initial = window.setTimeout(refresh, query ? 180 : 0)
    return () => {
      window.clearTimeout(initial)
      mounted.current = false
      readOwner.current?.abort()
      readOwner.current = null
      deleteOwner.current = null
    }
  }, [refresh, query])

  async function deleteRow(row: CcinfoIndexRow) {
    if (!canEdit || !mounted.current || deleteOwner.current || loading || !verified) return
    if (!window.confirm(`Delete ${label.singular.toLowerCase()} ${row.name}?`)) return
    const owner = {}
    deleteOwner.current = owner // Lock synchronously, before React paints disabled buttons.
    setDeleting(row.id)
    setMessage("")
    const owns = () => mounted.current && deleteOwner.current === owner
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 30000)
    try {
      // Keep the exact PostgreSQL version, including microseconds. No optimistic count decrement.
      await deleteCcinfoRecord({ kind, id: row.id, expectedUpdatedAt: row.updated_at, deletePorts: false }, { signal: controller.signal })
      if (!owns()) return
      // The last checked list is no longer authoritative after a confirmed mutation.
      setVerified(null)
      refresh()
    } catch (error) {
      if (owns()) {
        if (error instanceof CcinfoDeleteError && (error.status === 401 || error.status === 403)) {
          setVerified(null)
          setMessage("Your access could not be verified. Please sign in again or check your access.")
        } else {
          setMessage("Deletion could not be confirmed. This entry may have changed or been removed. Refresh before trying again.")
        }
      }
    } finally {
      window.clearTimeout(timeout)
      if (owns()) { deleteOwner.current = null; setDeleting(null) }
    }
  }

  return (
    <>
      <div className={styles.toolbar}>
        <span className={styles.count}>Count: {verified ? verified.count.toLocaleString() : "—"}</span>
        <button type="button" onClick={refresh} disabled={loading || deleting !== null}>{loading ? "Refreshing..." : "Refresh"}</button>
      </div>
      {message ? <p role="alert" className={styles.error}>{message}{verified ? " The last checked results are shown below." : ""}</p> : null}
      <p role="status" className={styles.status}>
        {verified ? `${loading ? "Refreshing. " : ""}Last checked: ${checkedTime.format(new Date(verified.checkedAt))} HKT`
          : loading ? "Loading results..." : "No verified results available."}
      </p>
      <section className={styles.panel} aria-busy={loading}>
        <div className={styles.tableWrap} role="region" aria-label={`${label.singular} index results`} tabIndex={0}>
          <table>
            <thead><tr><th scope="col">{label.singular}</th>{kind === "port" ? <th scope="col">Country</th> : null}<th scope="col">Information</th>{canEdit ? <th scope="col">Action</th> : null}</tr></thead>
            <tbody>
              {verified?.rows.map(row => (
                <tr key={row.id}>
                  <td><a href={`/admin/ccinfo?kind=${kind}&id=${row.id}`}>{row.name}</a></td>
                  {kind === "port" ? <td>{row.country_name || ""}</td> : null}
                  <td className={styles.information}>{(row.notes || "No info").replace(/\s+/g, " ")}</td>
                  {canEdit ? <td><button type="button" className={styles.delete} disabled={deleting !== null || loading} onClick={() => void deleteRow(row)} aria-label={`Delete ${label.singular.toLowerCase()} ${row.name}`}>{deleting === row.id ? "Deleting..." : "Delete"}</button></td> : null}
                </tr>
              ))}
              {!verified || verified.rows.length === 0 ? <tr><td colSpan={(kind === "port" ? 3 : 2) + Number(canEdit)} className={styles.empty}>
                {!verified ? loading ? "Loading results..." : "Results unavailable. Please refresh." : `No matching ${label.plural}.`}
              </td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
      <div className={styles.pagination}>
        <button type="button" onClick={() => onPage(Math.max(1, (verified?.page || page) - 1))} disabled={!verified || loading || (verified?.page || page) <= 1}>Previous</button>
        <span>Page {verified ? `${verified.page} / ${verified.totalPages}` : "—"}</span>
        <button type="button" onClick={() => onPage((verified?.page || page) + 1)} disabled={!verified || loading || (verified?.page || page) >= (verified?.totalPages || 1)}>Next</button>
      </div>
    </>
  )
}
