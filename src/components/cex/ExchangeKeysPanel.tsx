'use client'

// Reusable panel for connecting a CEX with real API keys (Binance / Kraken).
// Keys are typed by the user and stored only in their own browser
// (localStorage) — they are never sent to any server of ours.

import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Loader2, PlugZap, ShieldCheck, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import {
  clearCreds,
  loadCreds,
  saveCreds,
  type ExchangeCredentials,
  type ExchangeKind,
} from '@/lib/cex'

export type { ExchangeKind }

/**
 * A key copied from a web page drags invisible characters along (NBSP, zero
 * width, BOM) and sometimes the quotes around it. Kraken authenticates the key
 * string before it ever looks at the signature, so a single invisible character
 * is enough to get `EAPI:Invalid key` back.
 */
function cleanPaste(v: string): string {
  return v
    .replace(/[\u00a0\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/^[\s"']+|[\s"']+$/g, '')
}

/**
 * People routinely paste the whole thing into the first box as `key: secret`,
 * `key secret` or on two lines. Recover both values instead of sending a
 * malformed key.
 */
function splitPastedPair(keyRaw: string, secretRaw: string): { key: string; secret: string } {
  const invisibleStripped = secretRaw.replace(/[\u00a0\u200b-\u200d\u2060\ufeff]/g, '')
  const key = cleanPaste(keyRaw)
  if (cleanPaste(secretRaw)) return { key, secret: cleanPaste(secretRaw) }
  const parts = keyRaw
    .replace(/[\u00a0\u200b-\u200d\u2060\ufeff]/g, '')
    .split(/[:\r\n\t]+|\s{2,}/)
    .map(cleanPaste)
    .filter(Boolean)
  if (parts.length >= 2) return { key: parts[0], secret: parts[1] }
  return { key, secret: cleanPaste(invisibleStripped) }
}

/**
 * Describe what was actually pasted, so a rejected key can be diagnosed without
 * ever asking the user to paste a secret into a chat.
 *
 * This NEVER blocks the attempt: the exchange is the only authority on whether a
 * key is valid. A guessed format rule once locked people out of their own
 * account, so this only reports.
 */
function describePaste(kind: ExchangeKind, key: string, secret: string): string {
  if (!key) return 'No se recibió ninguna API key.'
  if (!secret) return 'Falta el API secret.'
  const notes: string[] = [`key ${maskKey(key)}`]
  const isBinance = (s: string) => s.length === 64 && /^[0-9a-f]+$/.test(s)
  if (isBinance(key) && isBinance(secret)) {
    notes.push(
      kind === 'kraken'
        ? 'formato de 64 hexadecimales = BINANCE, no Kraken'
        : 'formato hexadecimal, el habitual de Binance'
    )
  }
  if (kind === 'kraken') {
    if (key.length !== 56) {
      notes.push(`la key de Kraken debe tener 56 caracteres (tiene ${key.length})`)
    }
    if (secret.length !== 88) {
      notes.push(`el secret de Kraken debe tener 88 caracteres (tiene ${secret.length})`)
    }
  }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(key)) {
    notes.push('la key contiene caracteres que no son de una API key (espacios, comas, dos puntos)')
  }
  return notes.join(' · ')
}

/** Masked preview, so the user can confirm what is stored without exposing it. */
function maskKey(v: string): string {
  if (v.length <= 8) return `${v.slice(0, 2)}… (${v.length} car.)`
  return `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} car.)`
}

interface ExchangeKeysPanelProps {
  kind: ExchangeKind
  /** Verify the keys against the exchange and return a human label. */
  verify: (cred: ExchangeCredentials) => Promise<{ ok: boolean; label: string }>
  /** Live trading mode: places real orders with real capital. */
  liveEnabled: boolean
  onLiveEnabledChange: (v: boolean) => void
  /** True when the bot is currently scanning. */
  running: boolean
  /** Disable live mode while running so the user can't flip mid-trade. */
  disabled?: boolean
  onLog?: (msg: string, level?: 'info' | 'trade' | 'error') => void
}

const META: Record<ExchangeKind, { name: string; accent: string; docUrl: string }> = {
  binance: {
    name: 'Binance',
    accent: 'text-amber-400',
    docUrl: 'https://www.binance.com/en/my/settings/api-management',
  },
  kraken: {
    name: 'Kraken',
    accent: 'text-violet-400',
    docUrl: 'https://accounts.kraken.com/settings/api',
  },
  bybit: {
    name: 'Bybit',
    accent: 'text-orange-400',
    docUrl: 'https://www.bybit.com/app/user/api-management',
  },
}

export function ExchangeKeysPanel({
  kind,
  verify,
  liveEnabled,
  onLiveEnabledChange,
  running,
  disabled,
  onLog,
}: ExchangeKeysPanelProps) {
  const meta = META[kind]
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [hasCreds, setHasCreds] = useState(false)
  const [verified, setVerified] = useState(false)
  const [showSecret, setShowSecret] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; label: string } | null>(null)

  useEffect(() => {
    setHasCreds(!!loadCreds(kind))
    setVerified(false)
    setStatus(null)
  }, [kind])

  const handleSave = useCallback(async () => {
    const { key: k, secret: s } = splitPastedPair(apiKey, apiSecret)
    if (!k || !s) {
      setStatus({ ok: false, label: 'Introduce la API key y el API secret.' })
      return
    }
    setBusy(true)
    setStatus(null)
    const cred: ExchangeCredentials = { apiKey: k, apiSecret: s }
    // Save first: a verification problem must never cost the user their keys.
    saveCreds(kind, cred)
    setHasCreds(true)
    try {
      const res = await verify(cred)
      setStatus(res)
      setVerified(res.ok)
      if (res.ok) {
        setApiKey('')
        setApiSecret('')
        onLog?.(`${meta.name}: claves guardadas y verificadas.`)
      } else {
        // Keys are already stored, so the user can fix them without retyping.
        setStatus({
          ok: false,
          label: `Guardadas, pero ${meta.name} las rechazó. ${res.label} — Lo enviado: ${describePaste(kind, k, s)}`,
        })
        onLog?.(`${meta.name}: claves guardadas, pero la verificación falló — ${res.label}`, 'error')
      }
    } catch (e) {
      const msg = (e as Error).message
      setStatus({
        ok: false,
        label: `Claves guardadas. No se pudo verificar: ${msg.slice(0, 140)} — Lo enviado: ${describePaste(kind, k, s)}`,
      })
      onLog?.(`${meta.name}: claves guardadas, verificación fallida — ${msg}`, 'error')
    } finally {
      setBusy(false)
    }
  }, [apiKey, apiSecret, kind, onLog, verify, meta.name])

  /** Re-check the stored keys without retyping them. */
  const handleVerify = useCallback(async () => {
    const cred = loadCreds(kind)
    if (!cred) {
      setStatus({ ok: false, label: 'No hay claves guardadas.' })
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      const res = await verify(cred)
      setStatus(res)
      setVerified(res.ok)
      onLog?.(
        res.ok ? `${meta.name}: ${res.label}` : `${meta.name}: ${res.label}`,
        res.ok ? 'info' : 'error'
      )
    } catch (e) {
      const msg = (e as Error).message
      setStatus({ ok: false, label: msg.slice(0, 160) })
      onLog?.(`${meta.name}: ${msg}`, 'error')
    } finally {
      setBusy(false)
    }
  }, [kind, onLog, verify, meta.name])

  const handleClear = useCallback(() => {
    clearCreds(kind)
    setHasCreds(false)
    setVerified(false)
    setStatus(null)
    onLog?.(`${meta.name}: claves eliminadas del navegador.`)
  }, [kind, onLog, meta.name])

  return (
    <div className="space-y-3 rounded-md border border-dashed border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5">
          <Label className="flex items-center gap-1.5 text-xs">
            <KeyRound className="size-3.5" />
            Conexión real {meta.name}
          </Label>
          <p className="text-[10px] text-muted-foreground">
            Pega tus claves de {meta.name} para operar con capital real. Se guardan solo en
            este navegador (localStorage) y se firman desde aquí mismo.
          </p>
        </div>
        {hasCreds && (
          <Badge variant="outline" className="gap-1 text-[10px] text-emerald-400">
            <ShieldCheck className="size-3" /> Claves guardadas
          </Badge>
        )}
      </div>

      {hasCreds ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={handleVerify} disabled={busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
            {busy ? 'Verificando…' : 'Verificar claves'}
          </Button>
          <Button size="sm" variant="outline" onClick={handleClear} disabled={busy}>
            <Trash2 className="size-3.5" /> Borrar claves
          </Button>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              API key
            </Label>
            <Input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="API key"
              className="h-8 text-xs"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              API secret
            </Label>
            <Input
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
              placeholder="API secret"
              type={showSecret ? 'text' : 'password'}
              className="h-8 text-xs"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex items-center gap-3 sm:col-span-2">
            <Button size="sm" onClick={handleSave} disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
              {busy ? 'Verificando…' : 'Guardar y verificar'}
            </Button>            <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <input
                type="checkbox"
                checked={showSecret}
                onChange={(e) => setShowSecret(e.target.checked)}
                className="size-3 accent-current"
              />
              Mostrar secret
            </label>
            <a
              href={meta.docUrl}
              target="_blank"
              rel="noreferrer"
              className={`text-[10px] underline underline-offset-2 ${meta.accent}`}
            >
              Obtener claves
            </a>
          </div>
        </div>
      )}

      {status && (
        <p
          className={`text-[10px] ${status.ok ? 'text-emerald-400' : 'text-red-400'}`}
        >
          {status.label}
        </p>
      )}

      <p className="text-[10px] text-muted-foreground">
        {kind === 'kraken'
          ? 'Kraken no permite CORS: las peticiones firmadas pasan por /api/kraken (Next.js). En un despliegue Vercel, las credenciales transitan por esa función para firmar la petición; este código no las persiste en base de datos.'
          : 'Las claves se firman desde este navegador y solo se guardan aquí (localStorage).'}
      </p>

      <Separator />

      <div className="flex items-center justify-between gap-2">
        <div className="space-y-0.5">
          <Label className="text-xs">Modo real (dinero real)</Label>
          <p className="text-[10px] text-muted-foreground">
            {hasCreds
              ? 'Cada oportunidad ejecuta una orden real en el exchange. Si el exchange rechaza (mínimo, saldo), el bot se detiene y avisa.'
              : 'Necesitas guardar y verificar las claves para activar el modo real.'}
          </p>
        </div>
        <Switch
          checked={liveEnabled && hasCreds && verified}
          onCheckedChange={(v) => {
            if (!hasCreds || !verified) {
              setStatus({ ok: false, label: 'Guarda y verifica correctamente las claves antes de activar dinero real.' })
              return
            }
            onLiveEnabledChange(v)
          }}
          disabled={running || disabled}
        />
      </div>
    </div>
  )
}
