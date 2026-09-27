import { useEffect, useState, type ReactNode } from 'react'
import { api, defaultSettings, onEvent, type Computer, type Settings } from './lib/api'
import Onboarding from './screens/Onboarding'
import Dashboard from './screens/Dashboard'
import DeviceDetail from './screens/DeviceDetail'
import SettingsScreen from './screens/Settings'
import Diagnostics from './screens/Diagnostics'

export type Screen =
  | { name: 'dashboard' }
  | { name: 'device'; computer: Computer }
  | { name: 'settings' }
  | { name: 'diagnostics' }

export default function App() {
  const [ready, setReady] = useState(false)
  const [onboarded, setOnboarded] = useState(false)
  const [settings, setSettings] = useState<Settings>(defaultSettings)
  const [screen, setScreen] = useState<Screen>({ name: 'dashboard' })
  const [hostNotice, setHostNotice] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([api.getAppInfo(), api.getSettings()])
      .then(([info, s]) => {
        setOnboarded(info.onboarded)
        setSettings({ ...defaultSettings, ...s })
      })
      .finally(() => setReady(true))
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    void onEvent('host-error', (msg) => setHostNotice(String(msg))).then((fn) => {
      unlisten = fn
    })
    return () => unlisten?.()
  }, [])

  const notice = hostNotice ? (
    <div className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
      <div className="mx-auto flex max-w-3xl items-start justify-between gap-4">
        <p>{hostNotice}</p>
        <button onClick={() => setHostNotice(null)} className="shrink-0 text-xs font-medium text-amber-200 hover:text-white">
          Dismiss
        </button>
      </div>
    </div>
  ) : null

  if (!ready) {
    return (
      <div className="min-h-screen bg-zinc-950">
        {notice}
      </div>
    )
  }

  if (!onboarded) {
    return (
      <>
        {notice}
        <Onboarding
          onDone={(mode) => {
            const next = { ...settings, mode }
            setSettings(next)
            setOnboarded(true)
          }}
        />
      </>
    )
  }

  let body: ReactNode
  switch (screen.name) {
    case 'device':
      body = <DeviceDetail computer={screen.computer} onBack={() => setScreen({ name: 'dashboard' })} />
      break
    case 'settings':
      body = (
        <SettingsScreen
          settings={settings}
          onSave={(s) => {
            setSettings(s)
            void api.saveSettings(s)
            setScreen({ name: 'dashboard' })
          }}
          onBack={() => setScreen({ name: 'dashboard' })}
        />
      )
      break
    case 'diagnostics':
      body = <Diagnostics onBack={() => setScreen({ name: 'dashboard' })} />
      break
    default:
      body = (
        <Dashboard
          settings={settings}
          onOpenDevice={(computer) => setScreen({ name: 'device', computer })}
          onOpenSettings={() => setScreen({ name: 'settings' })}
          onOpenDiagnostics={() => setScreen({ name: 'diagnostics' })}
        />
      )
  }

  return (
    <>
      {notice}
      {body}
    </>
  )
}
