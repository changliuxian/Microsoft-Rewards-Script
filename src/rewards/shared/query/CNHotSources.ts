import type { CNHotBoardItem, CNTrends } from '../search/SearchTypes'
import { CN_HOT_SOURCES, URLs } from '../../../constants/urls'
import type { QueryKind, QueryOrigin, QueryTopic } from './QueryContext'

// Falling through every board must not stall the search flow, so the whole cascade
// shares one budget and whatever is left over falls back to the local query list.
export const CN_HOT_BUDGET_MS = 15 * 1000

// One board is one list, so stopping at the first board that answers would hand the
// search queue the same headlines every run and only a handful of distinct topics.
// Several boards are merged instead, each contributing only its leading titles, so the
// pool holds a spread of headlines that can take turns as the main topic.
// CN searches run without Bing expansion, so one headline is one search: the pool has to
// be wide enough to cover a full search quota before the queue has to refill.
export const CN_HOT_BOARD_LIMIT = 6
export const CN_HOT_PER_BOARD = 30

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

const SELF_HOSTED_CANDIDATE: CNHotCandidate = {
    label: 'self-hosted',
    sourceUrl: URLs.queryEngine.customCNTrends()
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
    return candidates
}

/**
 * Collects trending titles from several CN hot-topic boards.
 *
 * The candidate order is shuffled per call and every failure falls through to the next
 * board, so one dead aggregator never leaves the search pool without trending topics.
 * Boards are merged until `CN_HOT_BOARD_LIMIT` of them answered, because a single board
 * only carries one list of headlines. The self-hosted board is the backup and is only
 * asked when every public board failed.
 */
export async function fetchCNHotTopics(deps: CNHotDeps, language = 'zh', country = 'CN'): Promise<QueryTopic[]> {
    const now = deps.now ?? Date.now
    const deadline = now() + CN_HOT_BUDGET_MS
    const topics = await collectCNHotTopics(deps, shuffledCNHotCandidates(), deadline, now, language, country)
    if (topics.length > 0) return topics

    deps.log('warn', 'Every public CN hot-topic board failed, trying the self-hosted board')
    const fallback = await collectCNHotTopics(deps, [SELF_HOSTED_CANDIDATE], deadline, now, language, country)
    if (fallback.length > 0) return fallback

    deps.log('warn', 'Every CN hot-topic board failed, the search pool keeps its other sources')
    return []
}

async function collectCNHotTopics(
    deps: CNHotDeps,
    candidates: CNHotCandidate[],
    deadline: number,
    now: () => number,
    language: string,
    country: string
): Promise<QueryTopic[]> {
    const collected: QueryTopic[] = []
    const seen = new Set<string>()
    let answered = 0
    for (const candidate of candidates) {
        if (answered >= CN_HOT_BOARD_LIMIT) break
        if (now() > deadline) {
            deps.log('debug', `Stopped after ${CN_HOT_BUDGET_MS}ms with ${answered} board(s) merged`)
            break
        }
        const topics = await fetchCNHotBoard(deps, candidate, language, country)
        if (topics.length === 0) continue
        answered += 1
        for (const topic of topics.slice(0, CN_HOT_PER_BOARD)) {
            if (seen.has(topic.text)) continue
            seen.add(topic.text)
            collected.push({ ...topic, sourceRank: collected.length })
        }
    }
    if (collected.length > 0) {
        deps.log('debug', `CN hot-topic pool ready | boards=${answered} | topics=${collected.length}`)
    }
    return collected
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
