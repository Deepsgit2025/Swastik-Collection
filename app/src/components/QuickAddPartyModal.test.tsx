import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QuickAddPartyModal } from './QuickAddPartyModal.tsx'
import type { PartyDetail } from '../types/party.ts'

const CREATED_PARTY: PartyDetail = {
  id: 42,
  name: 'Mid-Sale Customer',
  phone: '9222222222',
  address: null,
  balance: 0,
  created_at: '2026-01-01 00:00:00',
}

beforeEach(() => {
  window.api = {
    startSession: vi.fn(),
    unlockOwner: vi.fn(),
    lockSession: vi.fn(),
    getParties: vi.fn(),
    getPartyLedger: vi.fn(),
    createParty: vi.fn(),
    quickAddParty: vi.fn().mockResolvedValue(CREATED_PARTY),
    updateParty: vi.fn(),
    deleteParty: vi.fn(),
    getBarcodeLabels: vi.fn(),
    createBarcodeLabel: vi.fn(),
    createSale: vi.fn(),
    recordPayment: vi.fn(),
    getExpenses: vi.fn().mockResolvedValue([]),
    logExpense: vi.fn(),
    getOwnerDashboard: vi.fn(),
    getDailySalesReport: vi.fn(),
    getSalesmanReport: vi.fn(),
    getSalesmanSales: vi.fn(),
    getSalesLedger: vi.fn(),
    getPartyOutstandingReport: vi.fn(),
    exportCsv: vi.fn(),
    printSale: vi.fn(),
    usePrintOverride: vi.fn(),
    printPage: vi.fn(),
    getLabelSize: vi.fn().mockResolvedValue({ widthMm: 50, heightMm: 25 }),
    setLabelSize: vi.fn(),
    getShopSettings: vi.fn(),
    setShopSettings: vi.fn(),
    getSalesmen: vi.fn(),
    createSalesman: vi.fn(),
    renameSalesman: vi.fn(),
    setSalesmanActive: vi.fn(),
    changeOwnerPassword: vi.fn(),
    getBackupStatus: vi.fn(),
    setDriveCredentials: vi.fn(),
    connectDrive: vi.fn(),
    disconnectDrive: vi.fn(),
    setBackupSchedule: vi.fn(),
    runBackupNow: vi.fn(),
    listRestorePoints: vi.fn(),
    restoreFromBackup: vi.fn(),
    previewRetention: vi.fn(),
    setRetentionEnabled: vi.fn(),
    runRetention: vi.fn(),
    getPurgeLog: vi.fn(),
    exportSalesHistory: vi.fn(),
    getWhatsAppState: vi
      .fn()
      .mockResolvedValue({ status: 'disconnected', qrDataUrl: null, connectedNumber: null, lastError: null }),
    connectWhatsApp: vi.fn(),
    logoutWhatsApp: vi.fn(),
    resetWhatsAppWebView: vi.fn(),
    resendBill: vi.fn(),
    onWhatsAppState: vi.fn().mockReturnValue(() => {}),
    getBillDeliveries: vi.fn().mockResolvedValue([]),
    onWhatsAppAck: vi.fn().mockReturnValue(() => {}),
    getPendingBillCount: vi.fn().mockResolvedValue(0),
    onPendingBillsChanged: vi.fn().mockReturnValue(() => {}),
  }
})

/**
 * This component is built ahead of the Phase 5 sale screen that will
 * actually trigger it (PHASE3.md section 4) — no sale-flow trigger UI exists
 * to test yet, so this exercises the modal directly: name+phone only, and
 * that it calls `quickAddParty` (not `createParty`) with exactly those two
 * fields.
 */
describe('QuickAddPartyModal', () => {
  it('renders only name and phone fields — no address or balance', () => {
    render(<QuickAddPartyModal isOpen onClose={vi.fn()} onCreated={vi.fn()} />)

    expect(screen.getByLabelText(/name/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/phone/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/address/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/balance/i)).not.toBeInTheDocument()
  })

  it('calls quickAddParty (never createParty) with the entered name/phone and reports the created party back', async () => {
    const onCreated = vi.fn()
    render(<QuickAddPartyModal isOpen onClose={vi.fn()} onCreated={onCreated} />)

    await userEvent.type(screen.getByLabelText(/name/i), 'Mid-Sale Customer')
    await userEvent.type(screen.getByLabelText(/phone/i), '9222222222')
    await userEvent.click(screen.getByRole('button', { name: /add party/i }))

    expect(window.api.quickAddParty).toHaveBeenCalledWith({
      name: 'Mid-Sale Customer',
      phone: '9222222222',
    })
    expect(window.api.createParty).not.toHaveBeenCalled()
    expect(onCreated).toHaveBeenCalledWith(CREATED_PARTY)
  })

  it('blocks submit with an inline error when name or phone is blank', async () => {
    render(<QuickAddPartyModal isOpen onClose={vi.fn()} onCreated={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: /add party/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/name is required/i)
    expect(window.api.quickAddParty).not.toHaveBeenCalled()
  })

  it('renders nothing when isOpen is false', () => {
    const { container } = render(<QuickAddPartyModal isOpen={false} onClose={vi.fn()} onCreated={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
