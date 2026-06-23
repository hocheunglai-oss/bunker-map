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

export const ADMIN_FOLDER_THEME_KEY = "fc-admin-folder-theme"
export const ADMIN_FOLDER_THEME_EVENT = "fc-admin-folder-theme-change"

export const ADMIN_FOLDER_THEME_OPTIONS = [
  {
    id: "italia-minimal",
    label: "Italia Minimal",
    description: "Off-white panels with quiet red and green accents.",
  },
  {
    id: "cosulich-classic",
    label: "Cosulich Classic",
    description: "FC red-green accents with restrained slate text.",
  },
  {
    id: "codex-graphite",
    label: "Codex Graphite",
    description: "Neutral graphite with tiny Italian colour markers.",
  },
  {
    id: "ligurian-mist",
    label: "Ligurian Mist",
    description: "Soft maritime blue-green on an off-white base.",
  },
  {
    id: "rosso-verde",
    label: "Rosso Verde",
    description: "Sharper red and green accents, still minimal.",
  },
  {
    id: "harbour-night",
    label: "Harbour Night",
    description: "Deep navigation ink with Cosulich colour details.",
  },
] as const

export type AdminFolderThemeId = (typeof ADMIN_FOLDER_THEME_OPTIONS)[number]["id"]

const ADMIN_FOLDER_THEME_IDS = new Set<string>(
  ADMIN_FOLDER_THEME_OPTIONS.map((option) => option.id),
)

const ADMIN_FOLDER_TONES: AdminFolderTone[] = [
  {
    cover: "#fbfbf8",
    tab: "#f2f5f1",
    sticker: "#f6f8f5",
    edge: "#d8ded8",
    accent: "#235846",
  },
  {
    cover: "#fbfaf7",
    tab: "#f6f2ee",
    sticker: "#f8f5f1",
    edge: "#e1d9d1",
    accent: "#7b332f",
  },
  {
    cover: "#fbfbf8",
    tab: "#f1f4f4",
    sticker: "#f6f8f8",
    edge: "#d5dddf",
    accent: "#24495d",
  },
  {
    cover: "#fbfaf7",
    tab: "#f3f5f1",
    sticker: "#f7f8f5",
    edge: "#d9dfd5",
    accent: "#315846",
  },
  {
    cover: "#fbfbf8",
    tab: "#f4f4f1",
    sticker: "#f8f8f5",
    edge: "#ddddda",
    accent: "#3f4642",
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

export function normaliseAdminFolderThemeId(value: string | null): AdminFolderThemeId {
  return ADMIN_FOLDER_THEME_IDS.has(value || "")
    ? (value as AdminFolderThemeId)
    : ADMIN_FOLDER_THEME_OPTIONS[0].id
}
