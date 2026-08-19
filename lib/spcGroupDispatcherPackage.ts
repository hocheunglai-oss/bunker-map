export const SPC_GROUP_DISPATCHER_EXTENSION_NAME = "FCUNO SPC Group Dispatcher"

export const SPC_GROUP_DISPATCHER_FILES = [
  "manifest.json",
  "background.js",
  "content.js",
  "styles.css",
  "spc-sidebar-logo.png",
  "README.md",
] as const

export type SpcGroupDispatcherFileName = (typeof SPC_GROUP_DISPATCHER_FILES)[number]

export type SpcGroupDispatcherBundle = {
  version: string
  files: Array<{
    name: SpcGroupDispatcherFileName
    contentBase64: string
  }>
}

type ReadableFile = {
  text(): Promise<string>
}

type WritableFile = {
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
}

export type SpcDispatcherFileHandle = {
  getFile(): Promise<ReadableFile>
  createWritable(): Promise<WritableFile>
}

export type SpcDispatcherDirectoryHandle = {
  name: string
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<SpcDispatcherFileHandle>
}

function decodeBase64(value: string) {
  const binary = globalThis.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export async function updateSpcDispatcherDirectory(
  directory: SpcDispatcherDirectoryHandle,
  bundle: SpcGroupDispatcherBundle,
) {
  const currentManifestHandle = await directory.getFileHandle("manifest.json")
  const currentManifest = JSON.parse(await (await currentManifestHandle.getFile()).text()) as {
    name?: string
    version?: string
  }
  if (currentManifest.name !== SPC_GROUP_DISPATCHER_EXTENSION_NAME) {
    throw new Error("Select the installed FCUNO SPC Group Dispatcher folder containing manifest.json.")
  }

  const expectedNames = new Set<string>(SPC_GROUP_DISPATCHER_FILES)
  if (
    !bundle.version
    || bundle.files.length !== SPC_GROUP_DISPATCHER_FILES.length
    || bundle.files.some((file) => !expectedNames.has(file.name) || !file.contentBase64)
  ) {
    throw new Error("The dispatcher update package is incomplete.")
  }

  const orderedFiles = [
    ...bundle.files.filter((file) => file.name !== "manifest.json"),
    ...bundle.files.filter((file) => file.name === "manifest.json"),
  ]
  for (const file of orderedFiles) {
    const handle = await directory.getFileHandle(file.name, { create: true })
    const writable = await handle.createWritable()
    await writable.write(decodeBase64(file.contentBase64))
    await writable.close()
  }

  const updatedManifest = JSON.parse(await (await currentManifestHandle.getFile()).text()) as {
    name?: string
    version?: string
  }
  if (
    updatedManifest.name !== SPC_GROUP_DISPATCHER_EXTENSION_NAME
    || updatedManifest.version !== bundle.version
  ) {
    throw new Error("Chrome extension files were written, but the version could not be verified.")
  }

  return {
    directoryName: directory.name,
    previousVersion: currentManifest.version || "unknown",
    version: updatedManifest.version,
  }
}
