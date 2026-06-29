type SpcShellProps = {
  title: string
  children: React.ReactNode
}

export function SpcShell({ title, children }: SpcShellProps) {
  return (
    <main className="spc-main" aria-label={title}>
      {children}
    </main>
  )
}
