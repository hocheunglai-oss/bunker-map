import {
  MAX_CLAIM_RECEIPT_BYTES,
  MAX_CLAIM_RECEIPTS,
  MAX_RECEIPT_BYTES,
  parseTripReceipt,
  TRIP_EXPENSE_API,
  tripReceiptMime,
} from "@/lib/tripExpenseClaim"
import {
  MAX_TRIP_DOCUMENT_BYTES,
  prepareTripClaim,
  tripImportAlreadyClaimed,
  tripImportClaimFormName,
  tripImportKind,
  type PreparedTripClaim,
  type TripImportResult,
  type TripImportSource,
} from "@/lib/tripExpenseImport"
import { readTripZipDirectory, readTripZipEntry } from "@/lib/tripExpenseZip"

type Upload = TripImportSource & { file?: File }

function hiddenFile(path: string) {
  return path.split("/").some(part => part.startsWith(".") || part === "__MACOSX" || part.toLowerCase() === "thumbs.db")
}

async function unpack(files: File[]) {
  const expanded: File[] = []
  let totalBytes = 0
  const reserve = (size: number) => {
    if (expanded.length >= MAX_CLAIM_RECEIPTS) throw new Error("Choose up to 30 documents.")
    totalBytes += size
    if (totalBytes > MAX_CLAIM_RECEIPT_BYTES) throw new Error("Use up to 50 MB of documents.")
  }
  for (const file of files) {
    if (hiddenFile(file.name)) continue
    if (!/\.zip$/i.test(file.name)) {
      reserve(file.size)
      expanded.push(file)
      continue
    }
    if (file.size > MAX_CLAIM_RECEIPT_BYTES) throw new Error("Use up to 50 MB of documents.")
    const bytes = new Uint8Array(await file.arrayBuffer())
    const entries = readTripZipDirectory(bytes, {
      entries: 100, entryBytes: MAX_RECEIPT_BYTES, totalBytes: MAX_CLAIM_RECEIPT_BYTES,
    })
    for (const entry of entries) {
      if (hiddenFile(entry.name)) continue
      reserve(entry.size)
      const name = entry.name.split("/").at(-1)!
      expanded.push(new File([await readTripZipEntry(bytes, entry)], name, {
        type: tripReceiptMime(name) || (tripImportKind(name) === "workbook" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : ""),
      }))
    }
  }
  if (!expanded.length) throw new Error("Choose a ZIP, Excel workbook, PDF or receipt photo.")
  return expanded
}

async function prepareUploads(files: File[]) {
  const uploads: Upload[] = []
  const seen = new Set<string>()
  for (const file of await unpack(files)) {
    const id = crypto.randomUUID()
    const kind = tripImportKind(file.name)
    if (!kind || !file.size || file.size > MAX_RECEIPT_BYTES) {
      uploads.push({ id, name: file.name, issue: "Use a supported document up to 10 MB." })
      continue
    }
    if (kind !== "workbook") {
      try {
        parseTripReceipt({ id, name: file.name, size: file.size })
      } catch (error) {
        uploads.push({ id, name: file.name, issue: error instanceof Error ? error.message : "Check the receipt filename." })
        continue
      }
    }
    const sha = await crypto.subtle.digest("SHA-256", await file.arrayBuffer())
    const key = Array.from(new Uint8Array(sha)).join(",")
    if (seen.has(key)) continue
    seen.add(key)
    uploads.push({ id, name: file.name, file })
  }
  return uploads
}

async function receiptImage(file: File) {
  const mime = tripReceiptMime(file.name)
  if (file.size <= MAX_TRIP_DOCUMENT_BYTES && mime !== "image/heic" && mime !== "image/heif") return file
  try {
    const source = await createImageBitmap(file, { imageOrientation: "from-image" })
    try {
      const resize = Math.min(1, 2048 / Math.max(source.width, source.height))
      const canvas = document.createElement("canvas")
      canvas.width = Math.round(source.width * resize)
      canvas.height = Math.round(source.height * resize)
      const context = canvas.getContext("2d")
      if (!context) throw new Error()
      context.fillStyle = "#fff"
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(source, 0, 0, canvas.width, canvas.height)
      const image = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.88))
      if (!image || image.size > MAX_TRIP_DOCUMENT_BYTES) throw new Error()
      return new File([image], "expense.jpg", { type: "image/jpeg" })
    } finally {
      source.close()
    }
  } catch {
    throw new Error("Open this photo or attach a JPEG copy.")
  }
}

async function readDocument(file: File, signal: AbortSignal): Promise<TripImportResult> {
  const document = tripImportKind(file.name) === "image" ? await receiptImage(file) : file
  if (document.size > MAX_TRIP_DOCUMENT_BYTES) throw new Error("Auto-preparation accepts PDFs and Excel files up to 4 MB.")
  const form = new FormData()
  form.set("document", document)
  const response = await fetch(TRIP_EXPENSE_API + "/prepare", {
    method: "POST",
    body: form,
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || !data?.value || (data.type !== "workbook" && data.type !== "document")) {
    throw new Error(data?.message || "Could not read this document. Try again.")
  }
  return data
}

export async function prepareTripUpload(
  files: File[],
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<{ draft: PreparedTripClaim; receipts: Map<string, File> }> {
  const uploads = await prepareUploads(files)
  signal.throwIfAborted()
  let done = 0
  const read = async (upload: Upload) => {
    signal.throwIfAborted()
    try {
      if (upload.file) upload.result = await readDocument(upload.file, signal)
    } catch (error) {
      signal.throwIfAborted()
      upload.issue = error instanceof Error ? error.message : "Could not read this document."
    } finally {
      onProgress(++done, uploads.length)
    }
  }
  onProgress(0, uploads.length)
  const workbooks = uploads.filter(upload => tripImportKind(upload.name) === "workbook")
  for (const workbook of workbooks) await read(workbook)
  const hasWorkbook = workbooks.some(workbook => workbook.result?.type === "workbook")
  const documents = uploads.filter(upload => tripImportKind(upload.name) !== "workbook")

  let next = 0
  await Promise.all(Array.from({ length: Math.min(3, documents.length) }, async () => {
    while (next < documents.length) {
      const upload = documents[next++]
      if (tripImportAlreadyClaimed(upload.name) || (hasWorkbook && tripImportClaimFormName(upload.name))) {
        onProgress(++done, uploads.length)
      } else await read(upload)
    }
  }))
  signal.throwIfAborted()
  const receipts = new Map(
    uploads.flatMap(upload => upload.file && tripReceiptMime(upload.file.name) ? [[upload.id, upload.file] as const] : []),
  )
  return {
    draft: prepareTripClaim(uploads.map(upload => ({ ...upload, canAttach: receipts.has(upload.id) }))),
    receipts,
  }
}
