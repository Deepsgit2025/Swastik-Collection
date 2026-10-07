import type { ReactNode } from 'react'
import { Sidebar } from './Sidebar.tsx'
import { TopBar } from './TopBar.tsx'

/** Role-aware app shell: sidebar nav + top bar, wrapping a screen's content. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen w-screen bg-slate-100">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <TopBar />
        <main className="flex flex-1 flex-col overflow-auto">{children}</main>
      </div>
    </div>
  )
}
