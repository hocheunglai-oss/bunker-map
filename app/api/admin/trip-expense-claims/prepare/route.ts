import { NextResponse } from "next/server"
import { TripExpenseInputError } from "@/lib/tripExpenseClaim"
import { MAX_TRIP_DOCUMENT_REQUEST_BYTES } from "@/lib/tripExpenseImport"
import { readTripImportSource } from "@/lib/tripExpenseImportServer"
import {
  TRIP_PRIVATE_HEADERS,
  TripExpenseRequestError,
  tripExpenseApiError,
  tripExpenseApiSession,
} from "@/lib/tripExpenseStore"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function POST(request: Request) {
  try {
    await tripExpenseApiSession(request, "edit")
    const contentType = request.headers.get("content-type")
    if (!request.body || !contentType || !/^multipart\/form-data\s*;/i.test(contentType)) {
      throw new TripExpenseInputError("Choose one document.")
    }
    if (Number(request.headers.get("content-length")) > MAX_TRIP_DOCUMENT_REQUEST_BYTES) {
      throw new TripExpenseRequestError("Use a document up to 4 MB.", 413)
    }
    let length = 0
    const body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        length += chunk.byteLength
        if (length > MAX_TRIP_DOCUMENT_REQUEST_BYTES) {
          throw new TripExpenseRequestError("Use a document up to 4 MB.", 413)
        }
        controller.enqueue(chunk)
      },
    }))
    const data = await new Response(body, { headers: { "content-type": contentType } }).formData().catch(error => {
      if (error instanceof TripExpenseRequestError) throw error
      return null
    })
    const files = data?.getAll("document")
    if (files?.length !== 1 || !(files[0] instanceof File)) throw new TripExpenseInputError("Choose one document.")
    const result = await readTripImportSource(files[0], { signal: request.signal })
    return NextResponse.json(result, { headers: TRIP_PRIVATE_HEADERS })
  } catch (error) {
    return tripExpenseApiError(error, "Could not prepare this document. Try again.")
  }
}
