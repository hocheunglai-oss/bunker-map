import {
  resolvePortFuelValue,
  type FormulaCapablePort,
} from "@/lib/portPricing"

export type ChinaFuelValues = {
  hsfo: number | null
  vlsfo: number | null
  mgo: number | null
}

export type ChinaReportSection = {
  title: string
  rows: Array<
    ChinaFuelValues & {
      port: string
    }
  >
}

type PortRecord = FormulaCapablePort & {
  id: number | string
}

export function buildChinaReportSections(
  ports: PortRecord[],
  sections: Array<{ title: string; ports: string[] }>,
  dependencyPorts: PortRecord[] = ports
): ChinaReportSection[] {
  const portsByName = new Map(
    dependencyPorts.map((port) => [port.name.toLowerCase(), port] as const)
  )
  const includedIds = new Set(ports.map((port) => port.id))

  return sections
    .map((section) => {
      const rows = section.ports
        .map((portName) => portsByName.get(portName.toLowerCase()))
        .filter((port): port is PortRecord => Boolean(port && includedIds.has(port.id)))
        .map((port) => ({
          port: port.name,
          hsfo: resolvePortFuelValue(port, portsByName, "hsfo"),
          vlsfo: resolvePortFuelValue(port, portsByName, "vlsfo"),
          mgo: resolvePortFuelValue(port, portsByName, "mgo"),
        }))

      return {
        title: section.title,
        rows,
      }
    })
    .filter((section) => section.rows.length > 0)
}
