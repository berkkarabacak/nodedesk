import { useCallback, useEffect, useState } from 'react'
import { api, defaultSettings, type Computer, type ConnectionRequest, type Settings, type Theme } from './lib/api'
import { applyTheme, resolveTheme } from './lib/theme'
import { useAccount } from './lib/useAccount'
import { useConnection, type ConnectionTarget } from './lib/useConnection'
import AppShell, { type ShellScreen } from './components/AppShell'
import { Button, Dialog } from './components/ui'
import Login from './screens/Login'
import Onboarding from './screens/Onboarding'
import MyComputers from './screens/MyComputers'
import ThisComputer from './screens/ThisComputer'
import FileTransfer from './screens/FileTransfer'
import SettingsScreen from './screens/Settings'
import DeviceDetail from './screens/DeviceDetail'
import Diagnostics from './screens/Diagnostics'
import IncomingConnection from './screens/IncomingConnection'
import RemoteSession, { ConnectionOverlay } from './screens/RemoteSession'

type Screen = ShellScreen | { name: 'device'; computer: Computer } | { name: 'diagnostics' } | { name: 'login' }

function isShellScreen(s: Screen): s is ShellScreen {
  return typeof s === 'string'
}

export default function App() {
  const [ready, setReady] = useState(false)
  const [settings, setSettings] = useState<Settings>(defaultSettings)
  const [account, accountActions] = useAccount()
  const [appOnboarded, setAppOnboarded] = useState(false)
  // 'onboarding' = local-mode host/controller setup, otherwise the shell.
  const [phase, setPhase] = useState<'onboarding' | 'app'>('app')
  const [screen, setScreen] = useState<Screen>('my-computers')
  const connection = useConnection()
  const [replaceTarget, setReplaceTarget] = useState<ConnectionTarget | null>(null)

  useEffect(() => {
    Promise.all([api.getAppInfo(), api.getSettings()])
      .then(([info, s]) => {
        const merged = { ...defaultSettings, ...s }
        setSettings(merged)
        applyTheme(resolveTheme(merged))
        setAppOnboarded(info.onboarded)
        // Existing installations keep their completed local setup; new
        // installs pick host/controller mode after choosing local mode.
        if (!info.onboarded && merged.localMode) setPhase('onboarding')
      })
      .finally(() => setReady(true))
  }, [])

  const saveSettings = useCallback(async (next: Settings) => {
    setSettings(next)
    await api.saveSettings(next)
  }, [])

  const changeTheme = useCallback((theme: Theme) => {
    applyTheme(theme)
    setSettings((prev) => ({ ...prev, theme }))
  }, [])

  const signedIn = account.kind === 'signedIn' ? account.profile : undefined

  // Presence heartbeat for the enrolled local device while signed in
  // (M3). Failures are silent — staleness is computed server-side.
  useEffect(() => {
    if (!signedIn) return
    const beat = () => void api.deviceHeartbeat().catch(() => {})
    beat()
    const t = setInterval(beat, 15_000)
    return () => clearInterval(t)
  }, [signedIn])

  // Host-side incoming-connection polling (M4). Only enrolled hosts receive
  // requests; the service enforces ownership and deadlines.
  const [incoming, setIncoming] = useState<ConnectionRequest | null>(null)
  useEffect(() => {
    if (!signedIn) {
      setIncoming(null)
      return
    }
    let disposed = false
    const poll = async () => {
      try {
        const requests = await api.listPendingRequests()
        if (!disposed) setIncoming((prev) => (prev && requests.some((r) => r.id === prev.id) ? prev : (requests[0] ?? null)))
      } catch {
        /* not enrolled yet / offline — nothing to show */
      }
    }
    void poll()
    const t = setInterval(() => void poll(), 5000)
    return () => {
      disposed = true
      clearInterval(t)
    }
  }, [signedIn])
  // AUTH-01: show Login when there is no account and local mode was never
  // selected. Account restore still in flight keeps the login screen quiet.
  const loginRequested = typeof screen === 'object' && screen.name === 'login'
  // Existing onboarded installations behave as local mode until the owner
  // explicitly signs in (COMPAT-01).
  const localMode = Boolean(settings.localMode || appOnboarded)
  const showLogin = (account.kind !== 'signedIn' && !localMode) || loginRequested

  const enterLocalMode = () => {
    void saveSettings({ ...settings, localMode: true })
    if (!settings.onboarded) setPhase('onboarding')
  }

  // SESSION-01/03/06: one click, one attempt; an active session requires
  // explicit replacement rather than silently killing it.
  // SETTINGS-03: the persisted default quality seeds new sessions; a session
  // keeps its own override after that (changeQuality never writes the default).
  const connectTo = (target: ConnectionTarget) => {
    const withDefault: ConnectionTarget = { quality: settings.qualityPreset ?? 'auto', ...target }
    const k = connection.state.kind
    if (k === 'connected' && connection.state.target.deviceId !== withDefault.deviceId) {
      setReplaceTarget(withDefault)
      return
    }
    void connection.start(withDefault)
  }

  // AUTH-09: signing out with an active session explains the interruption.
  const [signOutPending, setSignOutPending] = useState(false)
  const doSignOut = () => {
    if (connection.state.kind === 'connected') {
      setSignOutPending(true)
      return
    }
    void accountActions.signOut()
  }
  const confirmSignOut = async () => {
    setSignOutPending(false)
    await connection.disconnect()
    void accountActions.signOut()
  }

  if (!ready || account.kind === 'restoring') return <div className="min-h-screen bg-nd-bg" />

  if (showLogin) {
    return (
      <Login
        status={account}
        staySignedIn={settings.staySignedIn !== false}
        onStaySignedInChange={(stay) => {
          void api.setStaySignedIn(stay)
          void saveSettings({ ...settings, staySignedIn: stay })
        }}
        onSignIn={() => void accountActions.signIn()}
        onUseLocalMode={() => {
          enterLocalMode()
          if (loginRequested) setScreen('my-computers')
        }}
      />
    )
  }

  if (phase === 'onboarding') {
    return (
      <Onboarding
        onDone={(mode) => {
          const next = { ...settings, mode, onboarded: true, localMode: true }
          setSettings(next)
          setPhase('app')
        }}
      />
    )
  }

  if (!isShellScreen(screen)) {
    switch (screen.name) {
      case 'device':
        return <DeviceDetail computer={screen.computer} onBack={() => setScreen('my-computers')} />
      case 'diagnostics':
        return <Diagnostics onBack={() => setScreen('settings')} />
      case 'login':
        return null // handled by the showLogin branch above
    }
  }

  return (
    <>
      <AppShell active={screen} onNavigate={setScreen} accountEmail={signedIn?.email}>
        {screen === 'my-computers' && connection.state.kind === 'connected' ? (
          <RemoteSession
            state={connection.state}
            onDisconnect={() => void connection.disconnect()}
            onChangeQuality={(q) => connection.changeQuality(q)}
            onOpenFiles={() => setScreen('file-transfer')}
          />
        ) : screen === 'my-computers' ? (
          <MyComputers
            settings={settings}
            signedIn={Boolean(signedIn)}
            onOpenDevice={(computer) => setScreen({ name: 'device', computer })}
            onConnectDirectory={(c) => connectTo({ deviceId: c.id, name: c.name, endpoint: c.endpoint })}
          />
        ) : null}
        {screen === 'this-computer' && (
          <ThisComputer settings={settings} signedIn={Boolean(signedIn)} onSaveSettings={saveSettings} />
        )}
        {screen === 'file-transfer' && (
          <FileTransfer
            signedIn={Boolean(signedIn)}
            preferredTargetId={connection.state.kind === 'connected' ? connection.state.target.deviceId : undefined}
          />
        )}
        {screen === 'settings' && (
          <SettingsScreen
            settings={settings}
            account={account}
            onSignOut={doSignOut}
            onSwitchAccount={() => {
              // AUTH-08: the epoch bump inside sign-out/sign-in discards late
              // events from the previous account.
              void accountActions.signOut().then(() => accountActions.signIn())
            }}
            onSaveSettings={saveSettings}
            onThemeChange={changeTheme}
            onSignIn={() => setScreen({ name: 'login' })}
            onOpenDiagnostics={() => setScreen({ name: 'diagnostics' })}
          />
        )}
      </AppShell>
      {incoming && <IncomingConnection request={incoming} onDecided={() => setIncoming(null)} />}
      <ConnectionOverlay
        state={connection.state}
        onCancel={() => void connection.cancel()}
        onRetry={(t) => void connection.start(t)}
        onBack={() => connection.dismiss()}
      />
      {replaceTarget && (
        <Dialog title={`Connect to ${replaceTarget.name}?`} onClose={() => setReplaceTarget(null)}>
          <p className="mt-2 text-sm text-nd-dim">
            You&apos;re connected to{' '}
            {connection.state.kind === 'connected' ? connection.state.target.name : 'another computer'}. Connecting
            elsewhere ends that session.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setReplaceTarget(null)}>
              Stay here
            </Button>
            <Button
              onClick={() => {
                const next = replaceTarget
                setReplaceTarget(null)
                void connection.disconnect().then(() => connection.start(next))
              }}
            >
              Disconnect and connect
            </Button>
          </div>
        </Dialog>
      )}
      {signOutPending && (
        <Dialog title="Sign out?" onClose={() => setSignOutPending(false)}>
          <p className="mt-2 text-sm text-nd-dim">
            You have an active session to{' '}
            {connection.state.kind === 'connected' ? connection.state.target.name : 'a computer'}. Signing out ends
            it.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSignOutPending(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void confirmSignOut()}>
              End session and sign out
            </Button>
          </div>
        </Dialog>
      )}
    </>
  )
}
