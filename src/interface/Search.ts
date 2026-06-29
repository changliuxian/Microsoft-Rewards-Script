export type GoogleTrendsResponse = [string, [string, ...null[], [string, ...string[]]][]]

export interface SearchTracker {
    readonly context: string
    readonly maxSearches: number
    readonly stagnantLimit: number

    prepare(): Promise<boolean>

    measure(): Promise<number>
    done(): boolean
    progress(): string
}

export interface GoogleSearch {
    topic: string
    related: string[]
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
            }
        }>
    }
}

export interface HackerNewsResponse {
    hits: Array<{
        title: string | null
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

export interface CNTrends {
    code: number
    name: string
    title: string
    type: string
    link: string
    total: number
    updateTime: string
    fromCache: boolean
    data: CNTrendItem[]
}

export interface CNTrendItem {
    id: number
    title: string
    desc: string
    cover: string
    author: string
    timestamp: string | null
    hot: number
    url: string
    mobileUrl: string
}
