import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { Select, type OptionWithDescription } from '../../components/CustomSelect/index.js'
import { LoadingState } from '../../components/design-system/LoadingState.js'
import { useSetAppState } from '../../state/AppState.js'
import {
  getAvailableProviderGroups,
  hotswapToProvider,
  onProviderCacheRefresh,
  type ProviderGroup,
  type ProviderModelEntry,
} from '../../utils/providerRegistry.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

type SwitcherState =
  | { phase: 'loading' }
  | { phase: 'ready'; groups: ProviderGroup[]; stale?: boolean; refreshing?: boolean }
  | { phase: 'empty' }
  | { phase: 'error'; message: string }

const SEPARATOR = '──────────────────────────────'

function buildOptions(
  groups: ProviderGroup[],
): OptionWithDescription<string>[] {
  const options: OptionWithDescription<string>[] = []

  for (const group of groups) {
    options.push({
      label: `${group.isActive ? '● ' : '○ '}${group.providerName}${group.isActive ? ' (active)' : ''}`,
      value: `__header__${group.providerId}`,
      description: SEPARATOR,
      disabled: true,
    } as OptionWithDescription<string>)

    for (const entry of group.models) {
      options.push({
        label: entry.label,
        value: `${group.providerId}::${entry.model}`,
        description: entry.description ?? '',
      })
    }
  }

  return options
}

function findEntry(
  groups: ProviderGroup[],
  value: string,
): ProviderModelEntry | null {
  const [providerId, model] = value.split('::')
  if (!providerId || !model) return null
  const group = groups.find(g => g.providerId === providerId)
  return group?.models.find(m => m.model === model) ?? null
}

export function ProviderModelSwitcher({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const setAppState = useSetAppState()
  const [state, setState] = React.useState<SwitcherState>({ phase: 'loading' })

  const reload = React.useCallback(async () => {
    setState(prev => prev.phase === 'ready' ? { ...prev, refreshing: true, stale: false } : { phase: 'loading' })
    try {
      const groups = await getAvailableProviderGroups()
      if (groups.length === 0) {
        setState({ phase: 'empty' })
      } else {
        setState({ phase: 'ready', groups })
      }
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const groups = await getAvailableProviderGroups()
        if (cancelled) return

        if (groups.length === 0) {
          setState({ phase: 'empty' })
          return
        }

        setState({ phase: 'ready', groups })
      } catch (err) {
        if (cancelled) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    })()

    const unsubscribe = onProviderCacheRefresh(() => {
      if (!cancelled) {
        setState(prev => prev.phase === 'ready' ? { ...prev, stale: true } : prev)
      }
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useInput((input) => {
    if (input === 'r' && state.phase === 'ready' && !state.refreshing) {
      void reload()
    }
  })

  if (state.phase === 'loading') {
    return <LoadingState message="Discovering available models across providers…" />
  }

  if (state.phase === 'empty') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>No providers configured. Run /provider to set one up.</Text>
      </Box>
    )
  }

  if (state.phase === 'error') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error">Failed to load providers: {state.message}</Text>
      </Box>
    )
  }

  const options = buildOptions(state.groups)
  const firstSelectable = options.find(o => !(o as { disabled?: boolean }).disabled)

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Switch model</Text>
      <Text dimColor>Select a model from any configured provider. Switches instantly.</Text>
      {state.refreshing && <Text color="cyan">↻ Reloading model list…</Text>}
      {state.stale && !state.refreshing && (
        <Text color="yellow">↻ Model list updated in background — press <Text bold>r</Text> to reload.</Text>
      )}
      <Select
        options={options}
        defaultValue={firstSelectable?.value}
        defaultFocusValue={firstSelectable?.value}
        inlineDescriptions
        visibleOptionCount={Math.min(14, options.length)}
        onChange={(value: string) => {
          if (value.startsWith('__header__')) return

          const entry = findEntry(state.groups, value)
          if (!entry) return

          hotswapToProvider(entry.profile, entry.model)

          setAppState(prev => ({
            ...prev,
            mainLoopModel: entry.model,
            mainLoopModelForSession: null,
          }))

          const providerName = state.groups.find(
            g => g.providerId === value.split('::')[0],
          )?.providerName ?? 'provider'

          onDone(`Switched to ${entry.label} via ${providerName}`, {
            display: 'system',
          })
        }}
        onCancel={() => onDone()}
      />
    </Box>
  )
}
