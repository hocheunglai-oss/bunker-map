export type SpcSupplierInfo = {
  paymentTerms: string
  qualityClaimBar: string
  supplierTrader: string
  availableGrade: string
  foBdn: string
  goBdn: string
  rowNumber: number | null
}

export type SpcSupplierInfoInput = Omit<SpcSupplierInfo, "rowNumber">

export type SpcSupplierFixture = {
  id: string
  fixtureDate: string | null
  vesselName: string | null
  grade: string
  quantity: string
  supplierName: string
  recordedSupplier: string
  price: string | null
  barging: string | null
  buyerTrader: string
  supplierTrader: string
  enquiryNumber: string
  fixtureStatus: string
  renamed: boolean
}

export type SpcSupplierLegacyFixture = SpcSupplierFixture & {
  legacySupplier: string
}

export type SpcSupplierBarge = {
  id: string
  bargeName: string
  imo: string
  grade: string
  capacity: string
  source: "sheet" | "override"
}

export type SpcSupplierContact = {
  id: string
  role: "sales" | "ops"
  name: string
  mobile: string
  source: "sheet" | "override"
}

export type SpcSupplierEditVersions = {
  details: string
  barges: string | null
  contacts: string | null
}

export type SpcSupplierMutation = {
  requestId: string
  expectedVersions?: Partial<SpcSupplierEditVersions>
}

export type SpcSupplierRecord = {
  key: string
  name: string
  aliases: string[]
  info: SpcSupplierInfo
  fixtures: SpcSupplierFixture[]
  barges: SpcSupplierBarge[]
  contacts: SpcSupplierContact[]
  searchText: string
  updatedAt: string
  editVersions: SpcSupplierEditVersions
}

export type SpcSupplierDataset = {
  suppliers: string[]
  records: SpcSupplierRecord[]
  legacyFixtures: SpcSupplierLegacyFixture[]
  generatedAt: string
  spreadsheetUrl: string
  source: "public-csv"
  counts: {
    suppliers: number
    fixtureRows: number
    legacyFixtureRows: number
    bargeRows: number
    contactRows: number
  }
  warnings?: string[]
  mutation?: { requestId: string; replayed: boolean }
}

export type SaveSpcSupplierInput = SpcSupplierMutation & {
  key?: string
  name: string
  info: SpcSupplierInfoInput
}

export type SaveSpcSupplierBargesInput = SpcSupplierMutation & {
  supplierKey: string
  barges: Array<{
    id?: string
    bargeName: string
    imo: string
    grade: string
    capacity: string
  }>
}

export type SaveSpcSupplierContactsInput = SpcSupplierMutation & {
  supplierKey: string
  contacts: Array<{
    id?: string
    role: "sales" | "ops"
    name: string
    mobile: string
  }>
}
