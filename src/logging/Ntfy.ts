import { httpRequest } from '../util/Http'
import type { HttpRequestConfig } from '../util/Http'
import PQueue from 'p-queue'
import type { WebhookNtfyConfig } from '../interface/Config'
import type { LogLevel } from './Logger'

const ntfyQueue = new PQueue({
    interval: 1000,
    intervalCap: 2,
    carryoverConcurrencyCount: true
})

export async function sendNtfy(config: WebhookNtfyConfig, content: string, level: LogLevel): Promise<void> {
    if (!config?.url) return

    switch (level) {
        case 'error':
            config.priority = 5 // Highest
            break

        case 'warn':
            config.priority = 4
            break

        default:
            break
    }

    const headers: Record<string, string> = { 'Content-Type': 'text/plain' }
    if (config.title) headers['Title'] = config.title
    if (config.tags?.length) headers['Tags'] = config.tags.join(',')
    if (config.priority) headers['Priority'] = String(config.priority)
    if (config.token) headers['Authorization'] = `Bearer ${config.token}`

    const url = config.topic ? `${config.url}/${config.topic}` : config.url

    const request: HttpRequestConfig = {
        method: 'POST',
        url: url,
        headers,
        data: content,
        timeout: 10000
    }

    await ntfyQueue.add(async () => {
        try {
            await httpRequest(request)
        } catch (err) {
            const status = (err as { response?: { status?: number } })?.response?.status
            if (status === 429) return
        }
    })
}

export async function flushNtfyQueue(timeoutMs = 5000): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
        ntfyQueue.onIdle(),
        new Promise<void>((_, reject) => {
            timer = setTimeout(() => reject(new Error('ntfy flush timeout')), timeoutMs)
        })
    ]).catch(() => {})
    if (timer) clearTimeout(timer)
}
