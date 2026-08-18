import {
  SPC_SPEED_BOARD_PAGE_URL,
  SPC_SPEED_BOARD_VERSION,
} from "@/lib/spcSpeedBoardNotice"

export const dynamic = "force-dynamic"

export async function GET() {
  return Response.json(
    {
      latestVersion: SPC_SPEED_BOARD_VERSION,
      requiredVersion: SPC_SPEED_BOARD_VERSION,
      updatePageUrl: SPC_SPEED_BOARD_PAGE_URL,
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  )
}
