import { MicrosoftRewardsBot, executionContext } from '../index'
import type { Account } from '../interface/Account'
import { URLs } from '../constants/urls'

interface SearchResults {
    mobilePoints: number
    desktopPoints: number
}

export class SearchManager {
    constructor(private bot: MicrosoftRewardsBot) {}

    async doSearches(account: Account): Promise<SearchResults> {
        const counters = await this.bot.browser.func.getSearchPoints()
        const mobileMissing = this.bot.browser.func.missingSearchPoints(counters, true).totalPoints
        const desktopMissing = this.bot.browser.func.missingSearchPoints(counters, false).totalPoints

        const doMobile = this.bot.config.workers.doMobileSearch && mobileMissing > 0
        const doDesktop = this.bot.config.workers.doDesktopSearch && desktopMissing > 0

        this.bot.logger.info(
            'main',
            'SEARCH-MANAGER',
            `Mobile: ${this.status(this.bot.config.workers.doMobileSearch, mobileMissing)} | Desktop: ${this.status(
                this.bot.config.workers.doDesktopSearch,
                desktopMissing
            )}`
        )

        if (!doMobile && !doDesktop) {
            return { mobilePoints: 0, desktopPoints: 0 }
        }

        let mobilePoints = 0
        let desktopPoints = 0

        if (doMobile || doDesktop) {
            const parallel = this.bot.config.searchSettings.parallelSearching
            this.bot.logger.info('main', 'SEARCH-MANAGER', `Running ${parallel ? 'in parallel' : 'sequentially'}`)

            if (parallel) {
                ;[mobilePoints, desktopPoints] = await Promise.all([
                    doMobile ? this.runMobile(account) : Promise.resolve(0),
                    doDesktop ? this.runDesktop(account) : Promise.resolve(0)
                ])
            } else {
                mobilePoints = doMobile ? await this.runMobile(account) : 0
                desktopPoints = doDesktop ? await this.runDesktop(account) : 0
            }
        }

        return this.summarize(mobilePoints, desktopPoints)
    }

    private status(enabled: boolean, missing: number): string {
        if (!enabled) return 'skip (disabled)'
        if (missing <= 0) return 'skip (no points)'
        return `run (missing ${missing})`
    }

    private summarize(mobilePoints: number, desktopPoints: number): SearchResults {
        this.bot.logger.info(
            'main',
            'SEARCH-MANAGER',
            `Search summary | mobile=${mobilePoints} | desktop=${desktopPoints} | total=${mobilePoints + desktopPoints}`
        )
        return { mobilePoints, desktopPoints }
    }

    async doBonusSearches(account: Account): Promise<number> {
        if (!this.bot.config.workers.doBonusSearches) return 0

        this.bot.logger.info('main', 'SEARCH-MANAGER', 'Starting bonus search farming')

        const gained = await executionContext.run({ isMobile: true, account }, async () => {
            try {
                return await this.bot.activities.doBonusSearches(this.bot.mainMobilePage)
            } catch (error) {
                this.bot.logger.error(
                    'main',
                    'SEARCH-MANAGER',
                    `Bonus search failed | ${error instanceof Error ? error.message : String(error)}`
                )
                return 0
            } finally {
                await this.bot.mainMobilePage.goto(URLs.bing.origin).catch(() => {})
            }
        })

        this.bot.logger.info('main', 'SEARCH-MANAGER', `Bonus search summary | gained=+${gained}`)
        return gained
    }

    private runMobile(account: Account): Promise<number> {
        return executionContext.run({ isMobile: true, account }, async () => {
            try {
                return await this.bot.activities.doSearch(this.bot.mainMobilePage, true)
            } catch (error) {
                this.bot.logger.error(
                    'main',
                    'SEARCH-MANAGER',
                    `Mobile search failed | ${error instanceof Error ? error.message : String(error)}`
                )
                return 0
            }
        })
    }

    private runDesktop(account: Account): Promise<number> {
        return executionContext.run({ isMobile: false, account }, async () => {
            const session = await this.bot.createDesktopSession(account)
            try {
                return await this.bot.activities.doSearch(this.bot.mainDesktopPage, false)
            } catch (error) {
                this.bot.logger.error(
                    'main',
                    'SEARCH-MANAGER',
                    `Desktop search failed | ${error instanceof Error ? error.message : String(error)}`
                )
                return 0
            } finally {
                await this.bot.browser.func.closeBrowser(session.context, account.email).catch(() => {})
            }
        })
    }
}
