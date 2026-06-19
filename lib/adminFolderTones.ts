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
    cover: "#f4f8f5",
    tab: "#d9e8e1",
    sticker: "#eaf3ef",
    edge: "#c7d8cf",
    accent: "#355e52",
  },
  {
    cover: "#fbf4ef",
    tab: "#efd9cc",
    sticker: "#f7e8df",
    edge: "#dec5b5",
    accent: "#815a48",
  },
  {
    cover: "#f3f7fb",
    tab: "#d8e6f0",
    sticker: "#e8f1f7",
    edge: "#c6d6e0",
    accent: "#486b7f",
  },
  {
    cover: "#f8f5f9",
    tab: "#e7ddea",
    sticker: "#f0e8f2",
    edge: "#d7cbdc",
    accent: "#66536e",
  },
  {
    cover: "#fbf7ea",
    tab: "#efe3bd",
    sticker: "#f7efd0",
    edge: "#dccd9d",
    accent: "#735f2e",
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
