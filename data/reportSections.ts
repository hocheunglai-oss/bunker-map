export type ReportSection = {
  title: string
  ports: string[]
}

export const chinaReportSections: ReportSection[] = [
  {
    title: "CHINA (NORTH)",
    ports: ["Dalian", "Bayuquan", "Qinhuangdao", "Tianjin", "Caofeidian", "Huanghua", "Jingtang"],
  },
  {
    title: "CHINA (EAST)",
    ports: [
      "Qingdao",
      "Zhoushan",
      "Beilun",
      "Ningbo",
      "Shanghai",
      "Changshu",
      "Jiangyin",
      "Jiang Yin",
      "Nanjing",
      "Nantong",
      "Taicang",
      "Taizhou",
      "Zhangjiagang",
      "Rizhao",
      "Lianyungang",
      "Lanshan",
      "Lanqiao",
      "Xiamen",
      "Fuzhou",
      "Mawei",
      "Ningde",
      "Putian",
      "Xiuyu",
    ],
  },
  {
    title: "CHINA (SOUTH)",
    ports: ["Guangzhou", "Huangpu", "Nansha", "Chiwan", "Chiwian", "Macao", "Machong", "Shekou", "Zhanjiang", "Fangcheng", "Yangpu"],
  },
  { title: "HONG KONG / SINGAPORE", ports: ["Hong Kong", "Singapore"] },
  { title: "SOUTH KOREA", ports: ["Busan", "Yosu", "Yeosu", "Ulsan", "Inchon", "Incheon"] },
  { title: "TAIWAN", ports: ["Kaohsiung"] },
]

export const compactReportSections: ReportSection[] = [
  { title: "HONG KONG / SINGAPORE", ports: ["Hong Kong", "Singapore"] },
  ...chinaReportSections.slice(0, 3),
  { title: "JAPAN", ports: ["Tokyo Bay", "Tokyo", "Osaka Bay", "Osaka"] },
  { title: "SOUTH KOREA", ports: ["Busan", "Yosu", "Yeosu", "Ulsan", "Inchon", "Incheon"] },
  { title: "TAIWAN", ports: ["Kaohsiung", "Taichung", "Keelung", "Suao", "Hualien", "Mailiao"] },
  { title: "VIETNAM", ports: ["Ho Chi Minh", "Ho Chi Minh City", "Hochiminh City", "Haiphong"] },
  { title: "PHILIPPINES", ports: ["Manila"] },
  { title: "THAILAND", ports: ["Bangkok", "Koh Sichang", "Kohsichang", "Maptaphut"] },
  { title: "MALAYSIA", ports: ["Pasir Gudang", "Port Klang", "Tanjung Pelepas"] },
  { title: "SRI LANKA", ports: ["Colombo"] },
  { title: "INDIA", ports: ["Kochi", "Mumbai", "Vizag"] },
  { title: "INDONESIA", ports: ["Jakarta", "Surabaya"] },
]

export const chinaLeftColumnTitles = ["CHINA (NORTH)", "CHINA (EAST)", "CHINA (SOUTH)"]

export const compactLeftColumnTitles = [
  "HONG KONG / SINGAPORE",
  "CHINA (NORTH)",
  "CHINA (EAST)",
  "CHINA (SOUTH)",
  "JAPAN",
  "SOUTH KOREA",
  "TAIWAN",
]

export const defaultExpandablePreviewRows: Record<string, string[]> = {
  "CHINA (NORTH)": ["Dalian", "Tianjin"],
  "CHINA (EAST)": ["Zhoushan", "Shanghai"],
  "CHINA (SOUTH)": ["Guangzhou", "Fangcheng"],
}
