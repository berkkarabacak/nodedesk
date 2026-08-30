import { useEffect, useState } from 'react'
import { api, defaultSettings, type Computer, type Settings } from './lib/api'
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

  useEffect(() => {
    Promise.all([api.getAppInfo(), api.getSettings()])
      .then(([info, s]) => {
        setOnboarded(info.onboarded)
        setSettings({ ...defaultSettings, ...s })
      })
      .finally(() => setReady(true))
  }, [])

  if (!ready) return <div className="min-h-screen bg-zinc-950" />

  if (!onboarded) {
    return (
      <Onboarding
        onDone={(mode) => {
          const next = { ...settings, mode }
          setSettings(next)
          setOnboarded(true)
        }}
      />
    )
  }

  switch (screen.name) {
    case 'device':
      return <DeviceDetail computer={screen.computer} onBack={() => setScreen({ name: 'dashboard' })} />
    case 'settings':
      return (
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
    case 'diagnostics':
      return <Diagnostics onBack={() => setScreen({ name: 'dashboard' })} />
    default:
      return (
        <Dashboard
          settings={settings}
          onOpenDevice={(computer) => setScreen({ name: 'device', computer })}
          onOpenSettings={() => setScreen({ name: 'settings' })}
          onOpenDiagnostics={() => setScreen({ name: 'diagnostics' })}
        />
      )
  }
}
