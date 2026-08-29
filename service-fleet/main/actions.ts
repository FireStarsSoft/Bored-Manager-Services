/**
 * Acting on instances: one at a time, or across the fleet.
 *
 * Everything here goes over HTTP to agents that already exist, which is what
 * makes a bulk action cheap enough to be worth offering - stopping twenty
 * containers is twenty curl requests from one machine, not twenty SSH sessions.
 *
 * Deploying is the one that needs two steps rather than one: a template has to
 * be on the agent before an instance can be installed from it, so `deploy`
 * pushes the document first and installs second. Pushing every time rather than
 * only when it is missing is deliberate - it is how an edited template reaches
 * the fleet, and `PUT` is idempotent.
 */
import type { ModuleContext } from '@shared/modules'
import { agentReachMessage, classifyAgent, runAgentFanout, type AgentRequest } from './agentfan'
import type { Roster } from './roster'
import type { FleetRules } from './rules'
import type { LibraryEntry } from './templates/library'

/** The verbs an instance understands, in the order a toolbar shows them. */
export const INSTANCE_ACTIONS = ['start', 'stop', 'restart', 'validate', 'uninstall'] as const
export type InstanceAction = (typeof INSTANCE_ACTIONS)[number]

/** The ones worth a confirmation, because they stop something earning. */
export const DESTRUCTIVE_ACTIONS = new Set<InstanceAction>(['stop', 'uninstall'])

/** `OkResult` carries only a string `data`, so a log answer needs its own shape. */
export interface LogsResult {
  ok: boolean
  error?: string
  unit?: string
  lines?: string[]
}

export interface ActionOutcome {
  ip: string
  template: string
  ok: boolean
  message: string
}

function messageOf(json: unknown, fallback: string): string {
  if (typeof json === 'object' && json !== null) {
    const message = (json as { message?: unknown }).message
    const detail = (json as { detail?: unknown }).detail
    if (typeof message === 'string' && message.trim()) return message.trim()
    if (typeof detail === 'string' && detail.trim()) return detail.trim()
  }
  return fallback
}

export class InstanceActions {
  constructor(
    private ctx: ModuleContext,
    private roster: Roster
  ) {}

  /**
   * Run one verb against a list of `<ip>|<template>` pairs.
   *
   * A pair naming a machine with no usable agent is answered rather than
   * skipped: a bulk action over twenty rows that silently did eighteen would be
   * worse than one that says which two it could not reach.
   */
  async run(
    pairs: readonly string[],
    action: InstanceAction,
    rules: FleetRules,
    options: { forget?: boolean; signal?: AbortSignal } = {}
  ): Promise<ActionOutcome[]> {
    const requests: AgentRequest[] = []
    const meta: Array<{ ip: string; template: string }> = []
    const refused: ActionOutcome[] = []

    for (const pair of pairs) {
      const [ip, template] = String(pair).split('|')
      if (!ip || !template) continue
      const live = this.roster.liveFor(ip)
      const token = this.roster.tokenFor(ip)
      if (!live || !token) {
        refused.push({
          ip,
          template,
          ok: false,
          message: live ? 'no token is stored for this machine' : 'this machine is not in the roster'
        })
        continue
      }
      const suffix = action === 'uninstall' && options.forget ? '?forget=1' : ''
      requests.push({
        ip,
        port: rules.agentPort,
        token,
        method: 'POST',
        path: `/v1/instances/${encodeURIComponent(template)}/${action}${suffix}`
      })
      meta.push({ ip, template })
    }

    if (!requests.length) return refused

    const answers = await runAgentFanout(this.ctx, requests, rules, { signal: options.signal })
    const done = answers.map((response, index) => {
      const { ip, template } = meta[index]
      const reach = classifyAgent(response)
      if (reach !== 'ok') {
        return { ip, template, ok: false, message: agentReachMessage(response) }
      }
      if (response.status >= 400) {
        return { ip, template, ok: false, message: messageOf(response.json, `the agent answered ${response.status}`) }
      }
      // `validate` answers with a report rather than an ok/message pair, so its
      // verdict is read from `ok` and its issues become the message.
      if (action === 'validate') {
        const report = response.json as { ok?: boolean; issues?: Array<{ message?: string }> } | null
        const issues = (report?.issues ?? []).map((issue) => issue.message).filter(Boolean)
        return {
          ip,
          template,
          ok: report?.ok === true,
          message: issues.length ? issues.join('; ') : 'nothing to report'
        }
      }
      return { ip, template, ok: true, message: messageOf(response.json, `${action}ed`) }
    })

    return [...done, ...refused]
  }

  /**
   * Push a template to a machine and install an instance from it.
   *
   * The push is unconditional. A template that is already there is replaced,
   * which is how an edit reaches the fleet - and skipping it when the id
   * matched would mean an edited template silently never arriving.
   */
  async deploy(
    ips: readonly string[],
    entry: LibraryEntry,
    values: Record<string, string>,
    rules: FleetRules,
    signal?: AbortSignal
  ): Promise<ActionOutcome[]> {
    const usable: string[] = []
    const refused: ActionOutcome[] = []
    for (const ip of ips) {
      const token = this.roster.tokenFor(ip)
      if (!token) {
        refused.push({ ip, template: entry.id, ok: false, message: 'no token is stored for this machine' })
        continue
      }
      usable.push(ip)
    }
    if (!usable.length) return refused

    const push = await runAgentFanout(
      this.ctx,
      usable.map((ip) => ({
        ip,
        port: rules.agentPort,
        token: this.roster.tokenFor(ip),
        method: 'PUT',
        path: `/v1/templates/${encodeURIComponent(entry.id)}`,
        body: entry.document
      })),
      rules,
      { signal }
    )

    const ready: string[] = []
    const outcomes: ActionOutcome[] = [...refused]
    push.forEach((response, index) => {
      const ip = usable[index]
      const reach = classifyAgent(response)
      if (reach !== 'ok' || response.status >= 400) {
        outcomes.push({
          ip,
          template: entry.id,
          ok: false,
          message:
            reach === 'ok'
              ? messageOf(response.json, `the agent refused the template (${response.status})`)
              : agentReachMessage(response)
        })
        return
      }
      ready.push(ip)
    })

    if (!ready.length) return outcomes

    const install = await runAgentFanout(
      this.ctx,
      ready.map((ip) => ({
        ip,
        port: rules.agentPort,
        token: this.roster.tokenFor(ip),
        method: 'POST',
        path: `/v1/instances/${encodeURIComponent(entry.id)}/install`,
        body: values
      })),
      rules,
      { signal }
    )

    install.forEach((response, index) => {
      const ip = ready[index]
      const reach = classifyAgent(response)
      if (reach !== 'ok') {
        outcomes.push({ ip, template: entry.id, ok: false, message: agentReachMessage(response) })
        return
      }
      outcomes.push({
        ip,
        template: entry.id,
        ok: response.status < 400,
        message: messageOf(
          response.json,
          response.status < 400 ? 'installed' : `the agent answered ${response.status}`
        )
      })
    })

    return outcomes
  }

  /** One instance's log tail, redacted by the agent before it left the machine. */
  async logs(
    ip: string,
    template: string,
    rules: FleetRules,
    options: { unit?: string; tail?: number } = {}
  ): Promise<LogsResult> {
    const token = this.roster.tokenFor(ip)
    if (!token) return { ok: false, error: 'no token is stored for this machine' }
    const query = new URLSearchParams({ tail: String(options.tail ?? 200) })
    if (options.unit) query.set('unit', options.unit)
    const [response] = await runAgentFanout(
      this.ctx,
      [
        {
          ip,
          port: rules.agentPort,
          token,
          method: 'GET',
          path: `/v1/instances/${encodeURIComponent(template)}/logs?${query.toString()}`
        }
      ],
      rules
    )
    if (!response || classifyAgent(response) !== 'ok') {
      return { ok: false, error: response ? agentReachMessage(response) : 'no answer' }
    }
    if (response.status >= 400) {
      return { ok: false, error: messageOf(response.json, `the agent answered ${response.status}`) }
    }
    const body = response.json as { unit?: string; lines?: unknown } | null
    return {
      ok: true,
      unit: typeof body?.unit === 'string' ? body.unit : (options.unit ?? ''),
      lines: Array.isArray(body?.lines) ? body.lines.filter((l): l is string => typeof l === 'string') : []
    }
  }
}
