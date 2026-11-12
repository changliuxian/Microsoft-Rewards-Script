import type { CNHotBoardItem, CNTrends } from '../search/SearchTypes'
import { CN_HOT_SOURCES, URLs } from '../../../constants/urls'
import type { QueryKind, QueryOrigin, QueryTopic } from './QueryContext'

// Falling through every board must not stall the search flow, so the whole cascade
// shares one budget and whatever is left over falls back to the local query list.
export const CN_HOT_BUDGET_MS = 15 * 1000

export type CNHotLogLevel = 'debug' | 'warn'

export interface CNHotDeps {
    /** Fetches one board through the caller's HTTP stack and proxy settings. */
    fetchBoard: (sourceUrl: string) => Promise<CNTrends | undefined>
    log: (level: CNHotLogLevel, message: string) => void
    now?: () => number
}

interface CNHotCandidate {
    label: string
    sourceUrl: string
}

function readCNHotTitle(item: CNHotBoardItem): string {
    if (typeof item?.title === 'string') return item.title.trim()
    // The xxapi douyin board labels the headline `word` instead of `title`.
    if (typeof item?.word === 'string') return item.word.trim()
    return ''
}

function shuffledCNHotCandidates(): CNHotCandidate[] {
    const candidates: CNHotCandidate[] = []
    for (const api of CN_HOT_SOURCES) {
        for (const board of api.boards) {
            candidates.push({
                label: `${api.base}${board}`,
                sourceUrl: URLs.queryEngine.cnHotBoard(api.base, board)
            })
        }
    }
    // Fisher-Yates, so consecutive runs do not hammer the same aggregator first.
    for (let index = candidates.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(Math.random() * (index + 1))
        const held = candidates[index]!
        candidates[index] = candidates[swap]!
        candidates[swap] = held
    }
    // The self-hosted board is the backup and therefore always comes last.
    candidates.push({ label: 'self-hosted', sourceUrl: URLs.queryEngine.customCNTrends() })
    return candidates
}

/**
 * Walks the CN hot-topic boards and returns the first non-empty board as topics.
 *
 * The candidate order is shuffled per call, every failure falls through to the next
 * board, and the self-hosted board is always the last resort, so one dead aggregator
 * never leaves the search pool without trending topics.
 */
export async function fetchCNHotTopics(deps: CNHotDeps, language = 'zh', country = 'CN'): Promise<QueryTopic[]> {
    const now = deps.now ?? Date.now
    const deadline = now() + CN_HOT_BUDGET_MS
    for (const candidate of shuffledCNHotCandidates()) {
        if (now() > deadline) {
            deps.log('debug', `Stopped after ${CN_HOT_BUDGET_MS}ms without a usable board`)
            break
        }
        const topics = await fetchCNHotBoard(deps, candidate, language, country)
        if (topics.length > 0) return topics
    }
    deps.log('warn', 'Every CN hot-topic board failed, the search pool keeps its other sources')
    return []
}

async function fetchCNHotBoard(
    deps: CNHotDeps,
    candidate: CNHotCandidate,
    language: string,
    country: string
): Promise<QueryTopic[]> {
    const origin: QueryOrigin = {
        source: 'customCN',
        sourceUrl: candidate.sourceUrl,
        language,
        country
    }
    let data: CNTrends | undefined
    try {
        data = await deps.fetchBoard(candidate.sourceUrl)
    } catch (error) {
        deps.log('debug', `Request failed | board=${candidate.label} | ${String(error)}`)
        return []
    }
    if (!data || data.code !== 200) {
        deps.log('debug', `Board answered a non-200 code | board=${candidate.label} | code=${String(data?.code)}`)
        return []
    }
    const items: CNHotBoardItem[] = Array.isArray(data.data) ? data.data : []
    const topics = items
        .map(item => readCNHotTitle(item))
        .filter((text): text is string => text.length > 0)
        .map((text, sourceRank) => ({
            text: text.toLowerCase(),
            ...origin,
            kind: 'trend' as QueryKind,
            sourceRank
        }))
    if (topics.length === 0) {
        deps.log('debug', `Board returned no usable titles | board=${candidate.label}`)
        return []
    }
    deps.log('debug', `Got ${topics.length} topics | board=${candidate.label}`)
    return topics
}
