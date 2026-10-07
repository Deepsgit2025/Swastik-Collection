import { useOwnerGate } from '../../auth/useOwnerGate.tsx'
import { useEffect, useState } from 'react'
import { toWhatsAppNumber } from '../../lib/phone.ts'
import {
  validateOwnerWhatsAppNumber,
  validateShopAddress,
  validateShopName,
  validateShopPhone,
} from '../../lib/settingsValidation.ts'
import type { ShopSettings } from '../../types/settings.ts'
import { INPUT_CLASS } from './formStyles.ts'

/**
 * Shop name, address, phone and the Owner's WhatsApp number, saved together.
 *
 * The four fields are one form with one Save because `setShopSettings` writes
 * them in a single transaction — validating all of them before writing any —
 * so a per-field save button would misrepresent what actually happens.
 */
export function ShopDetailsPanel() {
  const { run, gate } = useOwnerGate()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [shopName, setShopName] = useState('')
  const [shopAddress, setShopAddress] = useState('')
  const [shopPhone, setShopPhone] = useState('')
  const [ownerWhatsappNumber, setOwnerWhatsappNumber] = useState('')

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api
      .getShopSettings()
      .then((shop: ShopSettings) => {
        if (cancelled) return
        setShopName(shop.shopName)
        setShopAddress(shop.shopAddress)
        setShopPhone(shop.shopPhone)
        setOwnerWhatsappNumber(shop.ownerWhatsappNumber)
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load the shop details.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // The same pure validators `setShopSettings` runs server-side, so the inline
  // error and the write rejection can never disagree.
  const nameError = validateShopName(shopName)
  const addressError = validateShopAddress(shopAddress)
  const phoneError = validateShopPhone(shopPhone)
  const whatsappError = validateOwnerWhatsAppNumber(ownerWhatsappNumber)
  const blockingError = nameError ?? addressError ?? phoneError ?? whatsappError

  function edit(setter: (value: string) => void) {
    return (event: React.ChangeEvent<HTMLInputElement>) => {
      setter(event.target.value)
      setSaved(false)
      setSaveError(null)
    }
  }

  function handleSave() {
    // Validation runs before the password is asked for.
    setSaveError(null)
    setSaved(false)
    if (blockingError) {
      setSaveError(blockingError)
      return
    }
    run(
      { title: 'Save shop details', description: 'Shop details appear on every printed and WhatsApp bill. Enter the Owner password to continue.' },
      () => doSave(),
    )
  }

  async function doSave() {
    setSaveError(null)
    setSaved(false)

    if (blockingError) {
      setSaveError(blockingError)
      return
    }

    setSaving(true)
    try {
      const shop = await window.api.setShopSettings({
        shopName,
        shopAddress,
        shopPhone,
        ownerWhatsappNumber,
      })
      // Re-seed from what was actually stored (trimmed), so what's on screen is
      // what the bill will print rather than what was typed.
      setShopName(shop.shopName)
      setShopAddress(shop.shopAddress)
      setShopPhone(shop.shopPhone)
      setOwnerWhatsappNumber(shop.ownerWhatsappNumber)
      setSaved(true)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not save the shop details.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="flex max-w-3xl flex-col gap-4 rounded-lg border border-slate-200 bg-white p-6">
      <div>
        <h2 className="text-base font-medium text-slate-800">Shop Details</h2>
        <p className="mt-1 text-sm text-slate-500">
          Printed at the top of every bill, and shown on the bill image sent over WhatsApp.
        </p>
      </div>

      {loading && <p className="text-sm text-slate-500">Loading…</p>}
      {loadError && <p className="text-sm text-red-600">{loadError}</p>}

      {!loading && !loadError && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm text-slate-600 sm:col-span-2">
              Shop name
              <input value={shopName} onChange={edit(setShopName)} className={INPUT_CLASS} />
            </label>

            <label className="flex flex-col gap-1 text-sm text-slate-600 sm:col-span-2">
              Address <span className="text-xs text-slate-400">(optional — left off the bill if blank)</span>
              <input value={shopAddress} onChange={edit(setShopAddress)} className={INPUT_CLASS} />
            </label>

            <label className="flex flex-col gap-1 text-sm text-slate-600">
              Shop phone
              <input value={shopPhone} onChange={edit(setShopPhone)} className={INPUT_CLASS} />
            </label>

            <label className="flex flex-col gap-1 text-sm text-slate-600">
              Owner&apos;s WhatsApp number
              <input
                value={ownerWhatsappNumber}
                onChange={edit(setOwnerWhatsappNumber)}
                className={INPUT_CLASS}
              />
              {/*
                Shows the number after the same normalization the send path
                applies (src/lib/phone.ts), so nobody has to know WhatsApp's
                addressing format to be sure they typed the right thing.
              */}
              {!whatsappError && (
                <span className="text-xs text-slate-500">
                  Your copy of every bill goes to +{toWhatsAppNumber(ownerWhatsappNumber)}
                </span>
              )}
            </label>
          </div>

          {blockingError && <p className="text-sm text-red-600">{blockingError}</p>}
          {saveError && !blockingError && <p className="text-sm text-red-600">{saveError}</p>}
          {saved && <p className="text-sm text-green-700">Saved. New bills use these details from now on.</p>}

          <div>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || blockingError != null}
              className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {saving ? 'Saving…' : 'Save shop details'}
            </button>
          </div>
        </>
      )}
      {gate}
    </section>
  )
}
