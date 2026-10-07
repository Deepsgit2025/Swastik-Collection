import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/AuthContext.tsx'
import { DashboardScreen } from './screens/DashboardScreen.tsx'
import { PartyListScreen } from './screens/PartyListScreen.tsx'
import { PartyLedgerScreen } from './screens/PartyLedgerScreen.tsx'
import { BarcodeGeneratorScreen } from './screens/BarcodeGeneratorScreen.tsx'
import { DevScannerTestScreen } from './screens/DevScannerTestScreen.tsx'
import { NewSaleScreen } from './screens/NewSaleScreen.tsx'
import { PaymentInScreen } from './screens/PaymentInScreen.tsx'
import { ExpensesScreen } from './screens/ExpensesScreen.tsx'
import { SalesScreen } from './screens/SalesScreen.tsx'
import { ReportsScreen } from './screens/ReportsScreen.tsx'
import { ConnectWhatsAppScreen } from './screens/ConnectWhatsAppScreen.tsx'
import { SettingsScreen } from './screens/SettingsScreen.tsx'
import { WhatsAppWebProvider } from './components/WhatsAppWebHost.tsx'

/**
 * Sends "/" (and any unknown path) to the till.
 *
 * `/dashboard` until 2026-08-27, when the salesman login was removed. New Sale
 * is what the machine is open for all day, so that is where it lands.
 *
 * Stale hashes — Phase 1's `/owner` and `/salesman`, and the now-deleted
 * `/login` and `/access-denied` — all fall through here rather than dead-ending.
 */
function HomeRedirect() {
  return <Navigate to="/sale/new" replace />
}

/**
 * Every screen is open (client decision, 2026-09-19: "remove the Owner lock").
 *
 * Between 2026-08-27 and then, six of these sat behind `RequireOwner` and asked
 * for the Owner password just to *look* at them. The password now stands in
 * front of the **actions** instead — every edit and delete asks for it at the
 * moment it is clicked (`useOwnerGate`), so viewing is free and changing or
 * destroying anything is not.
 *
 * The routes were never the security boundary and still are not: every channel
 * behind these screens asserts a permission against the main process's own
 * session (`src/db/permissions.ts`). Opening the routes changed what the
 * counter may *read*; it did not touch what it may write.
 */
function AppRoutes() {
  return (
    <Routes>
      <Route path="/dashboard" element={<DashboardScreen />} />
      <Route path="/parties" element={<PartyListScreen />} />
      <Route path="/parties/:id" element={<PartyLedgerScreen />} />
      <Route path="/barcode-generator" element={<BarcodeGeneratorScreen />} />
      <Route path="/sale/new" element={<NewSaleScreen />} />
      <Route path="/payment-in" element={<PaymentInScreen />} />
      {/* Logging an expense is a counter action (PHASE9.md section 0/3). */}
      <Route path="/expenses" element={<ExpensesScreen />} />
      <Route path="/sales" element={<SalesScreen />} />
      <Route path="/reports" element={<ReportsScreen />} />
      <Route path="/whatsapp" element={<ConnectWhatsAppScreen />} />
      <Route path="/settings" element={<SettingsScreen />} />
      {import.meta.env.DEV && <Route path="/dev/scanner-test" element={<DevScannerTestScreen />} />}
      <Route path="*" element={<HomeRedirect />} />
    </Routes>
  )
}

/**
 * Holds everything back for the one round trip that establishes this window's
 * counter session (see AuthContext).
 *
 * Without it the first screen would render and fire its effects before any
 * session existed in the main process, and every one of those calls would
 * reject with "Not authenticated" — a billing screen that looks broken for the
 * first frame of every launch. It resolves in a millisecond or two (one indexed
 * row), so this renders nothing rather than a spinner that would only ever
 * appear as a flicker of its own.
 */
function SessionGate() {
  const { starting } = useAuth()
  if (starting) return null

  return (
    <WhatsAppWebProvider>
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </WhatsAppWebProvider>
  )
}

function App() {
  return (
    <AuthProvider>
      {/*
        WhatsAppWebProvider sits outside the router on purpose: the embedded
        WhatsApp Web view lives in there, and anything the router owns is
        destroyed and rebuilt on every navigation — which meant WhatsApp Web
        restarted its slow first-load sync each time the Owner opened the
        Connect screen. Up there it loads once at launch and stays warm and live
        behind every screen.
      */}
      <SessionGate />
    </AuthProvider>
  )
}

export default App
