export type SpcSupplierInfo = {
  payment: string
  qualityClaim: string
  hsfo: string
  vlsfo: string
  lsmgo: string
  rowNumber: number | null
}

export type SpcSupplierContact = {
  sales: string
  salesMobile: string
  ops: string
  opsMobile: string
  rowNumber: number | null
}

export type SpcSupplierBdnEntry = {
  id: string
  rowNumber: number
  supplier: string
  sellingEntity: string
  terms: string
  bdnFuelOil: string
  bdnGasOil: string
  pop: string
}

export type SpcSupplierBarge = {
  id: string
  rowNumber: number
  supplier: string
  grade: string
  bargeName: string
  imoNumber: string
  loadMt: string
  status: string
}

export type SpcSupplierCoverage = {
  id: string
  rowNumber: number
  trader: string
  supplier: string
  hsfo: string
  vlsfo: string
  lsmgo: string
  sourceHeader: string
}

export type SpcSupplierRecord = {
  key: string
  name: string
  aliases: string[]
  info: SpcSupplierInfo
  contact: SpcSupplierContact
  bdnEntries: SpcSupplierBdnEntry[]
  barges: SpcSupplierBarge[]
  coverage: SpcSupplierCoverage[]
  searchText: string
  updatedAt: string
}

export type SpcSupplierDataset = {
  suppliers: string[]
  records: SpcSupplierRecord[]
  generatedAt: string
  spreadsheetUrl: string
  source: "google-sheets" | "public-csv"
  counts: {
    suppliers: number
    activeBarges: number
    coverageRows: number
    bdnRows: number
  }
}

export type SpcSupplierSaveInput = {
  supplierKey: string
  info?: Partial<Omit<SpcSupplierInfo, "rowNumber">>
  contact?: Partial<Omit<SpcSupplierContact, "rowNumber">>
  bdnEntries?: Array<Partial<Omit<SpcSupplierBdnEntry, "id" | "supplier">> & { rowNumber: number }>
}
