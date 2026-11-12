type PageReadResult = { data: unknown; error: unknown }

type BackupRead = (
  operation: () => PromiseLike<PageReadResult>,
  operationName: string
) => Promise<unknown>

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

// Only audit_logs uses this reader: its non-null UUID primary key provides
// the unique, indexed order required by a strict greater-than cursor. Do not
// apply this to nullable, compound, text-collated or non-unique sort columns.
// The caller retains the database mutation fence before/after the full export.
export async function streamAuditLogRows(options: {
  readPage: (after: string | null, limit: number) => PromiseLike<PageReadResult>
  retryRead: BackupRead
  appendRows: (rows: Record<string, unknown>[]) => Promise<void>
  pageSize: number
}) {
  const { pageSize } = options
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    throw new Error("Invalid audit-log backup page size.")
  }

  let after: string | null = null
  let exported = 0
  for (;;) {
    // Capture the cursor before passing a fresh request factory to the existing
    // transient-read retry policy. A retry cannot advance or append a page.
    const requestedAfter: string | null = after
    const data = await options.retryRead(
      () => options.readPage(requestedAfter, pageSize),
      `export audit_logs after ${requestedAfter || "start"}`
    )
    if (!Array.isArray(data) || data.length > pageSize) {
      throw new Error("Invalid audit-log backup page.")
    }

    let nextAfter: string | null = requestedAfter
    for (const row of data as unknown[]) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new Error("Invalid audit-log backup row.")
      }
      const id = (row as Record<string, unknown>).id
      if (typeof id !== "string" || !UUID.test(id)) {
        throw new Error("Invalid audit-log backup identity.")
      }
      // PostgreSQL UUID byte ordering agrees with canonical lowercase UUID
      // string ordering. Reject duplicate, descending or non-advancing pages
      // before publishing any rows from the invalid page to the stage.
      const cursor = id.toLowerCase()
      if (nextAfter !== null && cursor <= nextAfter) {
        throw new Error("Audit-log backup order did not advance.")
      }
      nextAfter = cursor
    }

    if (data.length) await options.appendRows(data as Record<string, unknown>[])
    exported += data.length
    after = nextAfter
    // No prefetch: downstream compression/backpressure completes before the
    // next read. Exact full pages require a final empty/short page, not a cap.
    if (data.length < pageSize) return exported
  }
}
