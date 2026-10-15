export type BcGrade = { quantity: string; buy: string; sell: string }
export type BcCalculatorValues = {
  grades: [BcGrade, BcGrade, BcGrade]
  lumpsumBuy: string
  lumpsumSell: string
}

export const BC_FACTOR = 0.825

export function emptyBcCalculator(): BcCalculatorValues {
  return {
    grades: Array.from({ length: 3 }, () => ({ quantity: "", buy: "", sell: "" })) as BcCalculatorValues["grades"],
    lumpsumBuy: "",
    lumpsumSell: "",
  }
}

export function normalizeBcCalculator(value: unknown): BcCalculatorValues {
  const empty = emptyBcCalculator()
  if (!value || typeof value !== "object") return empty
  const source = value as Partial<BcCalculatorValues>
  const field = (input: unknown) => typeof input === "string" ? input : typeof input === "number" && Number.isFinite(input) ? String(input) : ""
  return {
    grades: empty.grades.map((grade, index) => {
      const candidate = Array.isArray(source.grades) ? source.grades[index] : null
      return candidate && typeof candidate === "object" ? {
        quantity: field(candidate.quantity), buy: field(candidate.buy), sell: field(candidate.sell),
      } : grade
    }) as BcCalculatorValues["grades"],
    lumpsumBuy: field(source.lumpsumBuy),
    lumpsumSell: field(source.lumpsumSell),
  }
}

export function calculateBc(values: BcCalculatorValues) {
  const number = (value: string) => value.trim() === "" ? 0 : Number(value)
  const quantities = values.grades.map((grade) => number(grade.quantity))
  const totalQuantity = quantities.reduce((sum, quantity) => sum + quantity, 0)
  const gradeMargins = values.grades.map((grade) => number(grade.sell) - number(grade.buy))
  const gradeTotals = gradeMargins.map((margin, index) => margin * quantities[index])
  const lumpsum = number(values.lumpsumSell) - number(values.lumpsumBuy)
  const totalMargin = gradeTotals.reduce((sum, amount) => sum + amount, 0) + lumpsum
  const valid = [...quantities, ...gradeMargins, lumpsum].every(Number.isFinite)
    && quantities.every((quantity) => quantity >= 0)
    && values.grades.every((grade, index) => quantities[index] === 0 || (grade.buy.trim() !== "" && grade.sell.trim() !== ""))
  const baseBc = valid && totalQuantity > 0 ? totalMargin / totalQuantity : null
  return { valid, quantities, gradeMargins, gradeTotals, lumpsum, totalQuantity, totalMargin, baseBc, bc: baseBc === null ? null : baseBc * BC_FACTOR }
}
