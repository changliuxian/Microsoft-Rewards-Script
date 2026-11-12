export interface SearchTracker {
    readonly context: string
    readonly maxSearches: number
    readonly stagnantLimit: number
    readonly pointsGained: number | null

    prepare(): Promise<boolean>

    measure(): Promise<number | null>
    done(): boolean
    progress(): string
}

export interface WikipediaTopResponse {
    items: Array<{
        articles: Array<{
            article: string
            views: number
        }>
    }>
}

export interface RedditListing {
    data: {
        children: Array<{
            data: {
                title: string
                over_18: boolean
                stickied?: boolean
                created_utc?: number
            }
        }>
    }
}

export interface HackerNewsResponse {
    hits: Array<{
        title: string | null
        created_at_i?: number
    }>
}

export interface WikipediaRandomResponse {
    query?: {
        random?: Array<{
            id: number
            ns: number
            title: string
        }>
    }
}

export interface CNTrendItem {
    id: number | string
    title: string
    desc?: string
    cover?: string
    author?: string
    timestamp?: number | string | null
    hot?: number
    url?: string
    mobileUrl?: string
}

export interface CNTrends {
    code: number
    name?: string
    title?: string
    type?: string
    link?: string
    total?: number
    updateTime?: string
    fromCache?: boolean
    data: CNTrendItem[]
}

// The public aggregators share the CNTrends envelope, but the xxapi douyin board
// labels the headline `word` and the hot score `hot_value` instead of `title`/`hot`.
export interface CNHotBoardItem extends Partial<CNTrendItem> {
    word?: string
    hot_value?: number
}
