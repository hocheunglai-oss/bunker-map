import type { CSSProperties } from "react"

type AdminFolderTone = {
  cover: string
  tab: string
  sticker: string
  edge: string
  accent: string
}

type AdminFolderStyle = CSSProperties & {
  "--fc-folder-cover": string
  "--fc-folder-tab": string
  "--fc-folder-sticker": string
  "--fc-folder-edge": string
  "--fc-folder-accent": string
}

const ADMIN_FOLDER_TONES: AdminFolderTone[] = [
  {
    cover: "#ffffff",
    tab: "#f6faf7",
    sticker: "#ffffff",
    edge: "#d7e4dc",
    accent: "#177245",
  },
  {
    cover: "#ffffff",
    tab: "#fff6f6",
    sticker: "#ffffff",
    edge: "#f0d5d2",
    accent: "#d52b1e",
  },
  {
    cover: "#ffffff",
    tab: "#fafafa",
    sticker: "#ffffff",
    edge: "#eadfd3",
    accent: "#b07935",
  },
  {
    cover: "#ffffff",
    tab: "#f7faff",
    sticker: "#ffffff",
    edge: "#d6e0ea",
    accent: "#24466d",
  },
  {
    cover: "#ffffff",
    tab: "#fafafa",
    sticker: "#ffffff",
    edge: "#dedede",
    accent: "#4a4f55",
  },
]

export function getAdminFolderStyle(index: number): AdminFolderStyle {
  const tone = ADMIN_FOLDER_TONES[index % ADMIN_FOLDER_TONES.length]

  return {
    "--fc-folder-cover": tone.cover,
    "--fc-folder-tab": tone.tab,
    "--fc-folder-sticker": tone.sticker,
    "--fc-folder-edge": tone.edge,
    "--fc-folder-accent": tone.accent,
  }
}
