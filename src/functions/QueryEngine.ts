import type { HttpRequestConfig } from '../util/Http'
import * as fs from 'fs'
import path from 'path'
import { XMLParser } from 'fast-xml-parser'

import { URLs } from '../constants/urls'
import { RSS_FEEDS } from '../constants/rssFeeds'
import type {
    GoogleSearch,
    GoogleTrendsResponse,
    HackerNewsResponse,
    RedditListing,
    WikipediaRandomResponse,
    WikipediaTopResponse
} from '../interface/Search'
import type { QueryEngine, QueryEngineEntry } from '../interface/Config'
import type { MicrosoftRewardsBot } from '../index'

const GOOGLE_TRENDS_RPC_ID = 'i0OFE'

const RELATED_EXPANSION_LIMIT = 50

interface QueryManagerOptions {
    shuffle?: boolean
    sourceOrder?: QueryEngineEntry[]
    related?: boolean
    langCode?: string
    geoLocale?: string
}

interface RssEntry {
    title?: unknown
}
interface RssDocument {
    rss?: { channel?: { item?: RssEntry | RssEntry[] } }
    'rdf:RDF'?: { item?: RssEntry | RssEntry[] }
    feed?: { entry?: RssEntry | RssEntry[] }
}

function toArray(value: RssEntry | RssEntry[] | undefined): RssEntry[] {
    if (!value) return []
    return Array.isArray(value) ? value : [value]
}

function readTitle(title: unknown): string {
    if (typeof title === 'string') return title
    if (typeof title === 'number') return String(title)
    if (title && typeof title === 'object' && '#text' in title) {
        const text = (title as { '#text'?: unknown })['#text']
        return typeof text === 'string' ? text : typeof text === 'number' ? String(text) : ''
    }
    return ''
}

function stripHtml(text: string): string {
    return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
}

export class QueryCore {
    constructor(private bot: MicrosoftRewardsBot) {}

    async queryManager(options: QueryManagerOptions = {}): Promise<string[]> {
        const {
            shuffle = false,
            sourceOrder = ['google', 'wikipedia', 'wikirandom', 'hackernews', 'reddit', 'local'],
            related = true,
            langCode = 'en',
            geoLocale = 'US'
        } = options

        try {
            const sourceHandlers: Record<QueryEngine, () => Promise<string[]> | string[]> = {
                google: () => this.getGoogleTrends(geoLocale.toUpperCase()).catch(() => []),
                wikipedia: () => this.getWikipediaTrending(langCode).catch(() => []),
                wikirandom: () => this.getWikipediaRandom(langCode).catch(() => []),
                hackernews: () => this.getHackerNewsTopics().catch(() => []),
                reddit: () => this.getRedditTopics().catch(() => []),
                local: () => this.getLocalQueryList()
            }

            const isRss = (s: string) => s === 'rss' || s.startsWith('rss.')
            const coreSources = sourceOrder.filter(s => !isRss(s)) as QueryEngine[]
            const rssSelectors = sourceOrder.filter(isRss)

            const topicLists: string[][] = []
            for (const source of coreSources) {
                const handler = sourceHandlers[source]
                if (!handler) continue

                const topics = await Promise.resolve(handler())
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'QUERY-MANAGER',
                    `Source "${source}" returned ${topics.length}`
                )
                if (topics.length) topicLists.push(topics)
            }

            if (rssSelectors.length) {
                const rssTopics = await this.getRssTopics(rssSelectors).catch(() => [])
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'QUERY-MANAGER',
                    `Source "rss" returned ${rssTopics.length} (${rssSelectors.length} selector(s))`
                )
                if (rssTopics.length) topicLists.push(rssTopics)
            }

            const baseTopics = this.normalizeAndDedupe(topicLists.flat())
            if (!baseTopics.length) {
                this.bot.logger.warn(this.bot.isMobile, 'QUERY-MANAGER', 'No topics returned by any source')
                return []
            }

            const clusters = related ? await this.buildRelatedClusters(baseTopics, langCode) : baseTopics.map(t => [t])
            this.bot.utils.shuffleArray(clusters)

            let finalQueries = clusters.flat()
            if (shuffle) this.bot.utils.shuffleArray(finalQueries)

            finalQueries = this.normalizeAndDedupe(finalQueries)
            this.bot.logger.debug(
                this.bot.isMobile,
                'QUERY-MANAGER',
                `Built query pool | base=${baseTopics.length} | final=${finalQueries.length} | related=${related}`
            )

            return finalQueries
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'QUERY-MANAGER',
                `Failed building query pool | ${error instanceof Error ? error.message : String(error)}`
            )
            return []
        }
    }

    private async buildRelatedClusters(baseTopics: string[], langCode: string): Promise<string[][]> {
        const clusters: string[][] = []

        const head = baseTopics.slice(0, RELATED_EXPANSION_LIMIT)
        const tail = baseTopics.slice(RELATED_EXPANSION_LIMIT)

        for (const topic of head) {
            const suggestions = (await this.getBingSuggestions(topic, langCode).catch(() => [])).slice(0, 6)
            const related = (await this.getBingRelatedTerms(topic).catch(() => [])).slice(0, 3)
            clusters.push(this.normalizeAndDedupe([topic, ...suggestions, ...related]))
        }

        for (const topic of tail) {
            clusters.push([topic])
        }

        return clusters
    }

    private normalizeAndDedupe(queries: string[]): string[] {
        const seen = new Set<string>()
        const out: string[] = []

        for (const q of queries) {
            const trimmed = q?.trim()
            if (!trimmed) continue

            const norm = trimmed.replace(/\s+/g, ' ').toLowerCase()
            if (seen.has(norm)) continue

            seen.add(norm)
            out.push(trimmed)
        }

        return out
    }

    async getGoogleTrends(geoLocale: string): Promise<string[]> {
        const queryTerms: GoogleSearch[] = []

        try {
            const request: HttpRequestConfig = {
                url: URLs.queryEngine.googleTrends,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
                },
                data: `f.req=[[[${GOOGLE_TRENDS_RPC_ID},"[null, null, \\"${geoLocale.toUpperCase()}\\", 0, null, 48]"]]]`
            }

            const response = await this.bot.http.request<string>(request, this.bot.config.proxy.queryEngine)
            const trendsData = this.extractJsonFromResponse(response.data)
            if (!trendsData) {
                this.bot.logger.debug(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'No trends data parsed from response')
                return []
            }

            const mapped = trendsData.map(q => [q[0], q[9]!.slice(1)])

            if (mapped.length < 90 && geoLocale !== 'US') {
                return this.getGoogleTrends('US')
            }

            for (const [topic, related] of mapped) {
                queryTerms.push({ topic: topic as string, related: related as string[] })
            }
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-GOOGLE-TRENDS',
                `Request failed | ${error instanceof Error ? error.message : String(error)}`
            )
            return []
        }

        return queryTerms.flatMap(x => [x.topic, ...x.related])
    }

    private extractJsonFromResponse(text: string): GoogleTrendsResponse[1] | null {
        for (const line of text.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('[')) continue
            try {
                return JSON.parse(JSON.parse(trimmed)[0][2])[1]
            } catch {}
        }
        return null
    }

    async getBingSuggestions(query = '', langCode = 'en'): Promise<string[]> {
        try {
            const request: HttpRequestConfig = {
                url: URLs.queryEngine.bingSuggestions(query, langCode),
                method: 'GET',
                headers: { ...(this.bot.fingerprint?.headers ?? {}) }
            }

            const response = await this.bot.http.request<{
                suggestionGroups?: { searchSuggestions?: { query: string }[] }[]
            }>(request, this.bot.config.proxy.queryEngine)
            return response.data.suggestionGroups?.[0]?.searchSuggestions?.map((x: { query: string }) => x.query) ?? []
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-BING-SUGGESTIONS',
                `Request failed | query="${query}" | ${error instanceof Error ? error.message : String(error)}`
            )
            return []
        }
    }

    async getBingRelatedTerms(query: string): Promise<string[]> {
        try {
            const request: HttpRequestConfig = {
                url: URLs.queryEngine.bingRelated(query),
                method: 'GET',
                headers: { ...(this.bot.fingerprint?.headers ?? {}) }
            }

            const response = await this.bot.http.request<unknown[]>(request, this.bot.config.proxy.queryEngine)
            const related = response.data?.[1]
            return Array.isArray(related) ? related : []
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-BING-RELATED',
                `Request failed | query="${query}" | ${error instanceof Error ? error.message : String(error)}`
            )
            return []
        }
    }

    async getWikipediaTrending(langCode = 'en'): Promise<string[]> {
        try {
            const date = new Date(Date.now() - 24 * 60 * 60 * 1000)
            const year = date.getUTCFullYear()
            const month = String(date.getUTCMonth() + 1).padStart(2, '0')
            const day = String(date.getUTCDate()).padStart(2, '0')

            const request: HttpRequestConfig = {
                url: URLs.queryEngine.wikipediaTop(langCode, year, month, day),
                method: 'GET',
                headers: { ...(this.bot.fingerprint?.headers ?? {}) }
            }

            const response = await this.bot.http.request(request, this.bot.config.proxy.queryEngine)
            const articles = (response.data as WikipediaTopResponse).items?.[0]?.articles ?? []

            return articles.slice(0, 50).map(a => a.article.replace(/_/g, ' '))
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-WIKIPEDIA-TRENDING',
                `Request failed | lang=${langCode} | ${error instanceof Error ? error.message : String(error)}`
            )
            return []
        }
    }

    async getRedditTopics(subreddit = 'popular'): Promise<string[]> {
        const safe = subreddit.replace(/[^a-zA-Z0-9_+]/g, '')
        try {
            const request: HttpRequestConfig = {
                url: URLs.queryEngine.reddit(safe),
                method: 'GET',
                headers: { ...(this.bot.fingerprint?.headers ?? {}) }
            }

            const response = await this.bot.http.request(request, this.bot.config.proxy.queryEngine)
            const posts = (response.data as RedditListing).data?.children ?? []

            return posts.filter(p => !p.data.over_18).map(p => p.data.title)
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-REDDIT',
                `Request failed | subreddit=${safe} | ${error instanceof Error ? error.message : String(error)}`
            )
            return []
        }
    }

    async getHackerNewsTopics(): Promise<string[]> {
        try {
            const request: HttpRequestConfig = {
                url: URLs.queryEngine.hackerNews,
                method: 'GET',
                headers: { ...(this.bot.fingerprint?.headers ?? {}) }
            }

            const response = await this.bot.http.request<HackerNewsResponse>(request, this.bot.config.proxy.queryEngine)
            const hits = response.data?.hits ?? []

            return hits.map(h => (h.title ?? '').replace(/^(?:Show|Ask)\s+HN:\s*/i, '').trim()).filter(Boolean)
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-HACKERNEWS',
                `Request failed | ${error instanceof Error ? error.message : String(error)}`
            )
            return []
        }
    }

    async getWikipediaRandom(langCode = 'en'): Promise<string[]> {
        const lang = (langCode || 'en').split('-')[0] || 'en'
        try {
            const request: HttpRequestConfig = {
                url: URLs.queryEngine.wikipediaRandom(lang),
                method: 'GET',
                headers: { ...(this.bot.fingerprint?.headers ?? {}) }
            }

            const response = await this.bot.http.request<WikipediaRandomResponse>(
                request,
                this.bot.config.proxy.queryEngine
            )
            const pages = response.data?.query?.random ?? []

            return pages.map(p => p.title.trim()).filter(Boolean)
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-WIKIPEDIA-RANDOM',
                `Request failed | lang=${lang} | ${error instanceof Error ? error.message : String(error)}`
            )
            return []
        }
    }

    async getRssTopics(selectors: string[]): Promise<string[]> {
        const urls = this.resolveRssUrls(selectors)
        if (!urls.length) return []

        const lists = await Promise.all(urls.map(url => this.fetchRssTitles(url).catch(() => [])))
        return lists.flat()
    }

    private resolveRssUrls(selectors: string[]): string[] {
        const urls = new Set<string>()

        for (const selector of selectors) {
            const [, site, endpoint] = selector.split('.')

            if (!site) {
                for (const feeds of Object.values(RSS_FEEDS)) {
                    for (const url of Object.values(feeds)) urls.add(url)
                }
                continue
            }

            const feeds = RSS_FEEDS[site]
            if (!feeds) {
                this.bot.logger.warn(this.bot.isMobile, 'SEARCH-RSS', `Unknown RSS site "${site}" in "${selector}"`)
                continue
            }

            if (!endpoint) {
                for (const url of Object.values(feeds)) urls.add(url)
                continue
            }

            const url = feeds[endpoint]
            if (url) urls.add(url)
            else this.bot.logger.warn(this.bot.isMobile, 'SEARCH-RSS', `Unknown RSS feed "${site}.${endpoint}"`)
        }

        return [...urls]
    }

    async fetchRssTitles(url: string): Promise<string[]> {
        try {
            const request: HttpRequestConfig = {
                url,
                method: 'GET',
                headers: { ...(this.bot.fingerprint?.headers ?? {}) }
            }

            const response = await this.bot.http.request<string>(request, this.bot.config.proxy.queryEngine)
            const xml = typeof response.data === 'string' ? response.data : String(response.data ?? '')
            return this.parseRssTitles(xml)
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-RSS',
                `Feed failed | ${url} | ${error instanceof Error ? error.message : String(error)}`
            )
            return []
        }
    }

    private parseRssTitles(xml: string): string[] {
        if (!xml) return []

        let doc: RssDocument
        try {
            doc = new XMLParser({ ignoreAttributes: true, htmlEntities: true, parseTagValue: false }).parse(xml)
        } catch {
            return []
        }

        const entries = [
            ...toArray(doc?.rss?.channel?.item),
            ...toArray(doc?.['rdf:RDF']?.item),
            ...toArray(doc?.feed?.entry)
        ]

        return entries.map(entry => stripHtml(readTitle(entry?.title)).trim()).filter(Boolean)
    }

    getLocalQueryList(): string[] {
        try {
            const file = path.join(__dirname, './search-queries.json')
            const queries = JSON.parse(fs.readFileSync(file, 'utf8')) as string[]
            return Array.isArray(queries) ? queries : []
        } catch (error) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-LOCAL-QUERY-LIST',
                `Failed reading search-queries.json | ${error instanceof Error ? error.message : String(error)}`
            )
            return []
        }
    }
}
