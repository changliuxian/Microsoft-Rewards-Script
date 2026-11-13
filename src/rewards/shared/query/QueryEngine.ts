import type { QueryEngine as QueryEngineName, QueryEngineEntry } from '../../../config/Config'
import type { BotContext } from '../../../core/BotContext'
import { QuerySources } from './QuerySources'
import { cleanQuery, isRelevantSuggestion, orderTopics, prepareTopics, queryFingerprint } from './QueryQuality'
import { resolveQueryLocale, type QueryTopic, type SearchQuery, type SourcedQuery } from './QueryContext'

const MAX_CLUSTER_SUGGESTIONS = 4

interface TopicOptions {
    shuffle?: boolean
    sourceOrder?: QueryEngineEntry[]
    langCode?: string
    geoLocale?: string
}

export class QueryEngine {
    private readonly sources: QuerySources

    constructor(private readonly bot: BotContext) {
        this.sources = new QuerySources(bot)
    }

    async fetchTopics(options: TopicOptions = {}): Promise<QueryTopic[]> {
        const locale = resolveQueryLocale(this.bot)
        const {
            shuffle = false,
            sourceOrder = ['google', 'local', 'wikipedia', 'rss.googleNews'],
            langCode = locale.language,
            geoLocale = locale.country
        } = options
        const language = langCode.toLowerCase()
        const country = geoLocale.toUpperCase()
        this.bot.logger.debug(
            this.bot.isMobile,
            'QUERY-MANAGER',
            `Fetching main topics | localeMode=${locale.mode} | language=${language} | country=${country} | engines=${sourceOrder.join(',')}`
        )
        const sourceHandlers: Record<QueryEngineName, () => Promise<QueryTopic[]> | QueryTopic[]> = {
            google: () => this.sources.getGoogleTrends(country, language),
            wikipedia: () => this.sources.getWikipediaTrending(language),
            wikirandom: () => this.sources.getWikipediaRandom(language),
            hackernews: () => this.sources.getHackerNewsTopics(),
            reddit: () => this.sources.getRedditTopics(),
            local: () => this.sources.getLocalQueryList(language),
            customCN: () => this.sources.getCustomCNTrends(language, country)
        }
        const selected = [...new Set(sourceOrder)]
        // CN locale prefers the self-hosted hot-topic board even when the config omits it.
        if (country === 'CN' && !selected.includes('customCN')) {
            selected.unshift('customCN')
            this.bot.logger.debug(
                this.bot.isMobile,
                'QUERY-MANAGER',
                `CN locale detected, prepending customCN | language=${language} | country=${country}`
            )
        }
        const isRss = (source: string) => source === 'rss' || source.startsWith('rss.')
        const coreSources = selected.filter(source => !isRss(source)) as QueryEngineName[]
        const rssSelectors = selected.filter(isRss)
        const jobs: { source: string; load: () => Promise<QueryTopic[]> | QueryTopic[] }[] = coreSources.map(
            source => ({ source, load: sourceHandlers[source] })
        )
        if (rssSelectors.length)
            jobs.push({ source: 'rss', load: () => this.sources.getRssTopics(rssSelectors, language, country) })
        const lists = await Promise.all(
            jobs.map(async ({ source, load }) => {
                try {
                    const topics = await load()
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'QUERY-MANAGER',
                        `Source results | engine=${source} | topics=${topics.length} | language=${language} | country=${country}`
                    )
                    return { source, topics }
                } catch (error) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'QUERY-MANAGER',
                        `Source unavailable | engine=${source} | language=${language} | country=${country} | ${String(error)}`
                    )
                    return { source, topics: [] as QueryTopic[] }
                }
            })
        )
        // The CN locale searches the hot-topic headlines and nothing else: they are real
        // headlines, while the evergreen list and the RSS feeds read like filler.
        const cnTopics = lists.find(entry => entry.source === 'customCN')?.topics ?? []
        const cnOnly = country === 'CN' && cnTopics.length > 0
        const raw = cnOnly ? cnTopics : lists.flatMap(entry => entry.topics)
        this.bot.logger.debug(
            this.bot.isMobile,
            'QUERY-MANAGER',
            `Pool selection | source=${cnOnly ? 'customCN-only' : 'all-engines'} | raw=${raw.length} | language=${language} | country=${country}`
        )
        let topics = prepareTopics(raw, language, country)
        if (!topics.length) {
            topics = prepareTopics(this.sources.getLocalQueryList(language), language, country)
            this.bot.logger.warn(
                this.bot.isMobile,
                'QUERY-MANAGER',
                `Selected sources returned no usable topics | fallback=local | topics=${topics.length} | language=${language} | country=${country}`
            )
        }
        this.bot.logger.debug(
            this.bot.isMobile,
            'QUERY-MANAGER',
            `Topic pool ready | raw=${raw.length} | usable=${topics.length} | language=${language} | country=${country}`
        )
        return orderTopics(topics, language, country, shuffle)
    }

    async getTopics(forceRefresh = false): Promise<QueryTopic[]> {
        const { language: langCode, country: geoLocale, mode } = resolveQueryLocale(this.bot)
        const sourceOrder = this.bot.config.searchSettings.queryEngines
        const cacheKey = JSON.stringify([mode, langCode, geoLocale, sourceOrder])
        let cache = this.bot.searchTopicsCache
        if (forceRefresh || cache?.key !== cacheKey) {
            cache = { key: cacheKey, topics: this.fetchTopics({ langCode, geoLocale, sourceOrder }) }
            this.bot.searchTopicsCache = cache
        } else {
            this.bot.logger.debug(
                this.bot.isMobile,
                'QUERY-MANAGER',
                `Using cached topic pool | localeMode=${mode} | language=${langCode} | country=${geoLocale} | engines=${sourceOrder.join(',')}`
            )
        }
        const topics = await cache.topics
        if (!topics.length && this.bot.searchTopicsCache === cache) this.bot.searchTopicsCache = null
        return orderTopics(topics, langCode, geoLocale, true)
    }

    async getCluster(mainTopic: QueryTopic): Promise<SearchQuery[]> {
        const main = cleanQuery(mainTopic.text)
        if (!main) return []
        const locale = resolveQueryLocale(this.bot)
        const { language, country } = locale
        const first: SearchQuery = { ...mainTopic, text: main, topic: mainTopic, locale }
        // CN headlines are already complete queries. Expanding them with Bing suggestions only
        // stitches fragments together ("秋冬落地签是一杯warm drink"), so the CN locale searches
        // the headline verbatim and moves straight on to the next topic.
        if (country === 'CN') {
            this.bot.logger.debug(
                this.bot.isMobile,
                'QUERY-CLUSTER',
                `Cluster skipped | main=${JSON.stringify(main)} | topicSource=${mainTopic.source} | reason=cn-headline`
            )
            return [first]
        }
        if (!this.bot.config.searchSettings.clusterSearch) return [first]
        const results = await Promise.allSettled([
            this.sources.getBingSuggestions(main, language, country),
            this.sources.getBingRelatedTerms(main, language, country)
        ])
        const lists = results.map(result => (result.status === 'fulfilled' ? result.value : []))
        const seen = new Set([queryFingerprint(main)])
        const selected: SourcedQuery[] = []
        const count = Math.max(...lists.map(list => list.length))
        for (let index = 0; index < count && selected.length < MAX_CLUSTER_SUGGESTIONS; index++) {
            for (const list of lists) {
                const candidate = list[index]
                if (!candidate) continue
                const query = cleanQuery(candidate.text)
                if (!query || !isRelevantSuggestion(main, query)) continue
                const key = queryFingerprint(query)
                if (!key || seen.has(key)) continue
                seen.add(key)
                selected.push({ ...candidate, text: query })
                if (selected.length === MAX_CLUSTER_SUGGESTIONS) break
            }
        }

        const cluster = [first, ...selected.map(query => ({ ...query, topic: mainTopic, locale }))]
        this.bot.logger.debug(
            this.bot.isMobile,
            'QUERY-CLUSTER',
            `Cluster ready | main=${JSON.stringify(main)} | topicSource=${mainTopic.source} | language=${language} | country=${country}` +
                ` | candidates=${lists.reduce((total, list) => total + list.length, 0)} | related=${selected.length} | queries=${JSON.stringify(cluster.map(query => ({ query: query.text, source: query.source })))}`
        )
        return cluster
    }
}
