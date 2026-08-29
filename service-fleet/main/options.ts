/**
 * What the dropdowns in this module's forms offer. Every one of these reads the
 * roster and the library out of memory: a `select` asks for its choices the
 * moment a form becomes visible, and going to the network for that would mean a
 * page could not be opened while a machine was slow.
 */
import type { FormFieldOption } from '@shared/module-ui'
import type { FleetConfig } from './config'
import type { Roster } from './roster'
import { INSTANCE_ACTIONS } from './actions'
import { agentUsable } from './agent/types'
import type { Library } from './templates/library'

export type OptionKind =
  | 'hosts'
  | 'agents'
  | 'labels'
  | 'templates'
  | 'user-templates'
  | 'instances'
  | 'actions'
  | 'targets'
  | 'windows'

export function selectOptions(
  kind: unknown,
  config: FleetConfig,
  roster: Roster,
  library: Library
): FormFieldOption[] {
  switch (kind) {
    case 'hosts':
      return Object.values(roster.records())
        .map((record) => ({
          value: record.ip,
          label: record.hostname ? `${record.ip} (${record.hostname})` : record.ip
        }))
        .slice(0, 500)
    case 'agents':
      // Only machines an action could actually reach. Offering the rest would
      // be offering a choice that always fails.
      return agentOptions(roster)
    case 'labels':
      return [
        ...new Set(config.targets.map((rule) => rule.label).filter((label): label is string => !!label))
      ].map((label) => ({ value: label, label }))
    case 'templates':
      return library.entries.map((entry) => ({
        value: entry.id,
        label: `${entry.template.displayName} (${entry.template.kind}${entry.origin === 'user' ? ', yours' : ''})`
      }))
    case 'user-templates':
      return library.entries
        .filter((entry) => entry.origin === 'user')
        .map((entry) => ({ value: entry.id, label: entry.template.displayName }))
    case 'instances': {
      const seen = new Set<string>()
      for (const live of roster.agents()) {
        for (const instance of live.agent?.instances ?? []) seen.add(instance.id)
      }
      return [...seen].sort().map((id) => ({ value: id, label: id }))
    }
    case 'targets':
      return config.targets.map((rule) => ({
        value: rule.id,
        label: rule.label ? `${rule.value} (${rule.label})` : rule.value
      }))
    case 'windows':
      return [
        { value: '7', label: 'Last 7 days' },
        { value: '30', label: 'Last 30 days' },
        { value: '90', label: 'Last 90 days' },
        { value: '365', label: 'Last year' }
      ]
    case 'actions':
      return INSTANCE_ACTIONS.map((action) => ({ value: action, label: action }))
    default:
      return []
  }
}

/** Machines a deploy can be sent to, as options. */
export function agentOptions(roster: Roster): FormFieldOption[] {
  return roster
    .agents()
    .filter((live) => agentUsable(live.agent))
    .map((live) => ({
      value: live.ip,
      label: live.cred.label ? `${live.ip} (${live.cred.label})` : live.ip
    }))
    .slice(0, 500)
}
