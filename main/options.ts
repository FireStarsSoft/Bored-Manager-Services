/**
 * What the dropdowns in this module's forms offer. Every one of these reads the
 * roster and the config out of memory: a `select` asks for its choices the
 * moment a form becomes visible, and going to the network for that would mean a
 * page could not be opened while a machine was slow.
 */
import type { FormFieldOption } from '@shared/module-ui'
import type { FleetConfig } from './config'
import type { Roster } from './roster'
import { UNIT_ACTIONS } from './units'

export type OptionKind = 'hosts' | 'labels' | 'units' | 'watched' | 'actions' | 'targets' | 'states'

export function selectOptions(
  kind: unknown,
  config: FleetConfig,
  roster: Roster
): FormFieldOption[] {
  switch (kind) {
    case 'hosts':
      return Object.values(roster.records())
        .map((record) => ({
          value: record.ip,
          label: record.hostname ? `${record.ip} (${record.hostname})` : record.ip
        }))
        .slice(0, 500)
    case 'labels':
      return [...new Set(config.targets.map((rule) => rule.label).filter((label): label is string => !!label))].map(
        (label) => ({ value: label, label })
      )
    case 'units': {
      const names = new Set<string>(config.watched.map((def) => def.unit))
      for (const row of roster.unitRows()) names.add(String(row['unit']))
      return [...names]
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 500)
        .map((unit) => ({ value: unit, label: unit }))
    }
    case 'watched':
      return config.watched.map((def) => ({
        value: def.id,
        label: def.label ? `${def.unit} - ${def.label}` : def.unit
      }))
    case 'targets':
      return config.targets.map((rule) => ({
        value: rule.id,
        label: rule.label ? `${rule.value} (${rule.label})` : rule.value
      }))
    case 'states':
      return [
        { value: 'any', label: 'Any state' },
        { value: 'running', label: 'Running now' },
        { value: 'failed', label: 'Failed' },
        { value: 'stopped', label: 'Not running' },
        { value: 'missing', label: 'Not installed' }
      ]
    case 'actions':
      return UNIT_ACTIONS.map((action) => ({ value: action, label: action }))
    default:
      return []
  }
}
