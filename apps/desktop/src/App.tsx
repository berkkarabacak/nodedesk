import { useEffect, useState } from 'react'
import { api, type Computer, type Settings, defaultSettings } from './lib/api'
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
  const [onboarded, setOnboarded] = useState<boolean | null>(null)
  const [settings, setSettings] = useState<Settings>(defaultSettings)
  const [screen, setScreen] = useState<Screen>({ name: 'dashboard' })

  useEffect(() => {
    api.getSettings().then((s) => {
      setSettings(s)
      // First-run flag: in the real shell this persists via the Rust core.
      setOnboarded(localStorage.getItem('nodedesk.onboarded') === 'yes')
    })
  }, [])

  if (onboarded === null) return <div className="min-h-screen bg-zinc-950" />

  if (!onboarded) {
    return (
      <Onboarding
        onDone={(mode) => {
          const next = { ...settings, mode }
          setSettings(next)
          void api.saveSettings(next)
          localStorage.setItem('nodedesk.onboarded', 'yes')
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
          onOpenDevice={(computer) => setScreen({ name: 'device', computer })}
          onOpenSettings={() => setScreen({ name: 'settings' })}
          onOpenDiagnostics={() => setScreen({ name: 'diagnostics' })}
        />
      )
  }
}
