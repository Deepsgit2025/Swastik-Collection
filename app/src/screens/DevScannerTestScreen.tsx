import { useState } from 'react'
import { AppShell } from '../components/AppShell.tsx'
import { useBarcodeScanner } from '../hooks/useBarcodeScanner.ts'

interface ScanEntry {
  code: string
  at: string
}

/**
 * Dev-only (PHASE4.md section 5): only registered in App.tsx behind
 * `import.meta.env.DEV`, not linked from any nav item. Exists to verify
 * useBarcodeScanner against the real Helett HT410 before Phase 5 wires it
 * into the sale screen.
 */
export function DevScannerTestScreen() {
  const [scans, setScans] = useState<ScanEntry[]>([])
  const [manualText, setManualText] = useState('')

  useBarcodeScanner((code) => {
    setScans((prev) => [{ code, at: new Date().toLocaleTimeString() }, ...prev])
  })

  return (
    <AppShell>
      <div className="flex flex-1 flex-col gap-4 p-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Scanner Test (dev only)</h1>
          <p className="mt-1 text-sm text-slate-600">
            Scan a barcode with the Helett HT410 — no need to click into a field first, the hook listens
            globally. Each detected scan appears in the table below.
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <label className="block text-sm font-medium text-slate-700" htmlFor="manual-typing-control">
            Manual typing control
          </label>
          <p className="mt-0.5 text-xs text-slate-500">
            Type normally here and press Enter — it should NOT appear in the scan list below.
          </p>
          <input
            id="manual-typing-control"
            type="text"
            value={manualText}
            onChange={(event) => setManualText(event.target.value)}
            placeholder="Type here at normal speed…"
            className="mt-2 w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-4 py-2 font-medium">Detected code</th>
                <th className="px-4 py-2 font-medium">Time</th>
              </tr>
            </thead>
            <tbody>
              {scans.map((scan, index) => (
                <tr key={`${scan.code}-${scan.at}-${index}`} className="border-t border-slate-100">
                  <td className="px-4 py-2 font-mono text-slate-800">{scan.code}</td>
                  <td className="px-4 py-2 text-slate-500">{scan.at}</td>
                </tr>
              ))}
              {scans.length === 0 && (
                <tr>
                  <td colSpan={2} className="px-4 py-6 text-center text-slate-500">
                    No scans detected yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  )
}
