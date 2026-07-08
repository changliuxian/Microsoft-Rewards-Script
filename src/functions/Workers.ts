import { URLs } from '../constants/urls'
import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../index'
import type { DashboardData, PunchCard, BasePromotion } from '../interface/DashboardData'
import type { AppDashboardData } from '../interface/AppDashBoardData'
import type { QuestChild, ParentQuest } from '../browser/ReactFunc'

export class Workers {
    public bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    public async doDailySet(data: DashboardData) {
        const todayKey = this.bot.utils.getFormattedDate()
        const todayData = data.dashboard.dailySetPromotions[todayKey]

        const activitiesUncompleted = todayData?.filter(x => !x?.complete && x.pointProgressMax > 0) ?? []

        if (!activitiesUncompleted.length) {
            this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'All "Daily Set" items have already been completed')
            return
        }

        this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'Started solving "Daily Set" items')

        await this.solveActivities(activitiesUncompleted)

        this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'All "Daily Set" items have been completed')
    }

    public async doMorePromotions(data: DashboardData) {
        const morePromotions: BasePromotion[] = [
            ...new Map(
                [
                    ...(data.dashboard.morePromotions ?? []),
                    ...(data.dashboard.morePromotionsWithoutPromotionalItems ?? [])
                ]
                    .filter(Boolean)
                    .map(p => [p.offerId, p as BasePromotion] as const)
            ).values()
        ]

        const activitiesUncompleted: BasePromotion[] =
            morePromotions?.filter(x => {
                if (x.complete) return false
                if (x.pointProgressMax <= 0) return false
                if (x.exclusiveLockedFeatureStatus === 'locked') return false
                if (!x.promotionType) return false
                if (x.priority < 0 && x.exclusiveLockedFeatureStatus !== 'unlocked') return false
                if (x.attributes?.promotional === 'True') return false
                return true
            }) ?? []

        if (!activitiesUncompleted.length) {
            this.bot.logger.info(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                'All "More Promotion" items have already been completed'
            )
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'MORE-PROMOTIONS',
            `Started solving ${activitiesUncompleted.length} "More Promotions" items`
        )

        await this.solveActivities(activitiesUncompleted)

        this.bot.logger.info(this.bot.isMobile, 'MORE-PROMOTIONS', 'All "More Promotion" items have been completed')
    }

    public async doAppPromotions(data: AppDashboardData) {
        const appRewards = data.response.promotions.filter(x => {
            if (x.attributes['complete']?.toLowerCase() !== 'false') return false
            if (!x.attributes['offerid']) return false
            if (!x.attributes['type']) return false
            if (x.attributes['type'] !== 'sapphire') return false

            return true
        })

        if (!appRewards.length) {
            this.bot.logger.info(
                this.bot.isMobile,
                'APP-PROMOTIONS',
                'All "App Promotions" items have already been completed'
            )
            return
        }

        for (const reward of appRewards) {
            await this.bot.activities.doAppReward(reward)
            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
        }

        this.bot.logger.info(this.bot.isMobile, 'APP-PROMOTIONS', 'All "App Promotions" items have been completed')
    }

    public async doPunchCards(data: DashboardData, page: Page) {
        let parents: ParentQuest[]

        try {
            const earn = await page.request.get(URLs.rewards.earn)
            if (!earn.ok()) {
                this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', `/earn ${earn.status()} - cannot list quests`)
                return
            }
            const html = await earn.text()
            parents = this.bot.browser.react.snapshotQuestList(html)

            // Some deploys render the carousel only on /dashboard
            if (!parents.length) {
                const dash = await page.request.get(URLs.rewards.dashboard)
                if (dash.ok()) parents = this.bot.browser.react.snapshotQuestList(html, await dash.text())
            }
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'PUNCHCARD',
                `Failed fetching /earn for quest list | ${error instanceof Error ? error.message : String(error)}`
            )
            return
        }

        const apiById = new Map(
            (data.dashboard.punchCards ?? [])
                .filter(c => c.parentPromotion?.offerId)
                .map(c => [c.parentPromotion.offerId, c] as const)
        )

        const seen = new Set(parents.map(p => p.offerId))
        for (const card of apiById.values()) {
            const pp = card.parentPromotion
            if (!pp?.offerId || seen.has(pp.offerId)) continue
            parents.push({
                offerId: pp.offerId,
                title: pp.title ?? '',
                pointProgressMax: pp.pointProgressMax ?? 0,
                complete: !!pp.complete
            })
            seen.add(pp.offerId)
        }

        for (const p of parents) {
            if (p.pointProgressMax <= 0) {
                p.pointProgressMax = apiById.get(p.offerId)?.parentPromotion?.pointProgressMax ?? p.pointProgressMax
            }
        }

        const incomplete = parents.filter(p => {
            if (p.complete) return false
            if (this.bot.config.skipNonPointTasks && p.pointProgressMax <= 0) return false
            return true
        })
        if (!incomplete.length) {
            this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', 'No actionable quests')
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'PUNCHCARD',
            `Found ${incomplete.length} incomplete quest(s) on /earn | api-matched=${incomplete.filter(p => apiById.has(p.offerId)).length}`
        )

        for (const parent of incomplete) {
            try {
                await this.solvePunchCard(parent, apiById.get(parent.offerId), page)
            } catch (error) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'PUNCHCARD',
                    `Error solving quest "${parent.title || parent.offerId}" | message=${error instanceof Error ? error.message : String(error)}`
                )
            }
        }

        this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', 'Finished processing quests')
    }

    public async doClaimBonusPoints(data: DashboardData) {
        const pointsActivity = data.dashboard.pointClaimBannerPromotion

        if (!pointsActivity) {
            this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', 'No claim bonus points banner found')
            return
        }

        if (pointsActivity.complete) {
            this.bot.logger.info(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `Bonus points have already been claimed | offerId=${pointsActivity.offerId}`
            )
            return
        }

        await this.bot.activities.doClaimBonusPoints()

        this.bot.logger.info(
            this.bot.isMobile,
            'CLAIM-BONUS-POINTS',
            `Bonus points have been claimed | title="${pointsActivity.title}" | offerId=${pointsActivity.offerId}`
        )
    }

    private async solvePunchCard(parent: ParentQuest, apiCard: PunchCard | undefined, page: Page) {
        const parentId = parent.offerId
        const title = parent.title || apiCard?.parentPromotion?.title || parentId

        let questChildren: QuestChild[]
        try {
            const res = await page.request.get(URLs.rewards.quest(parentId))
            if (!res.ok()) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'PUNCHCARD',
                    `Quest page ${res.status()} for "${title}" - skipping`
                )
                return
            }
            questChildren = this.bot.browser.react.snapshotQuestPage(await res.text())
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'PUNCHCARD',
                `Failed fetching quest page for "${title}" | ${error instanceof Error ? error.message : String(error)}`
            )
            return
        }

        if (!questChildren.length) {
            this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `No actionable children rendered for "${title}"`)
            return
        }

        const apiChildById = new Map(
            (apiCard?.childPromotions ?? []).filter(c => c.offerId).map(c => [c.offerId, c] as const)
        )
        const ordered = [...questChildren].sort(
            (a, b) =>
                (apiChildById.get(a.offerId)?.priority ?? Number.MAX_SAFE_INTEGER) -
                (apiChildById.get(b.offerId)?.priority ?? Number.MAX_SAFE_INTEGER)
        )

        this.bot.logger.info(
            this.bot.isMobile,
            'PUNCHCARD',
            `Solving "${title}" | children=${ordered.length} | reportable=${ordered.filter(c => c.reportable).length}`
        )

        const startBalance = this.bot.userData.currentPoints
        let reported = 0
        let remaining = 0

        for (const child of ordered) {
            const offerId = child.offerId
            const api = apiChildById.get(offerId)

            if (!child.reportable) {
                remaining++
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'PUNCHCARD',
                    `Skip ${offerId}: not reportable (locked=${child.isLocked} disabled=${child.isDisabled} done=${child.isCompleted} hash=${!!child.hash})`
                )
                continue
            }

            if (this.isSearchQuotaChild(offerId, api)) {
                remaining++
                this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `Skip ${offerId}: multi-day search task`)
                continue
            }

            if (this.isClaimChild(offerId, api)) {
                if (!this.bot.config.autoClaimPunchcardRewards) {
                    remaining++
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `Reward for "${title}" ready to claim - left for manual redemption (autoClaimPunchcardRewards=false) | ${offerId}`
                    )
                    continue
                }
                await this.bot.activities.doClaimReward(child, parentId)
                reported++
                continue
            }

            await this.reportQuestChild(child, parentId)
            reported++
            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
        }

        const gained = this.bot.userData.currentPoints - startBalance
        this.bot.logger.info(
            this.bot.isMobile,
            'PUNCHCARD',
            `Quest "${title}" ${remaining === 0 ? 'COMPLETE' : 'in progress'} | reported=${reported}${remaining ? ` | remaining=${remaining}` : ''} | gainedPoints=${gained}${parent.pointProgressMax > 0 ? `/${parent.pointProgressMax}` : ''}`,
            gained > 0 ? 'green' : undefined
        )
    }

    private async reportQuestChild(child: QuestChild, parentId: string) {
        const offerId = child.offerId
        const actionId = this.bot.nextActions.reportActivity
        if (!actionId) {
            this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', `Skip ${offerId}: "reportActivity" not discovered`)
            return
        }
        if (!child.hash) {
            this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', `Skip ${offerId}: no live hash on quest child`)
            return
        }

        const oldBalance = this.bot.userData.currentPoints
        try {
            const questUrl = URLs.rewards.quest(parentId)
            const { status, acknowledged } = await this.bot.browser.func.reportServerAction(
                actionId,
                [
                    child.hash,
                    11,
                    { offerid: offerId, isPromotional: '$undefined', timezoneOffset: this.bot.userData.timezoneOffset }
                ],
                {
                    url: questUrl,
                    referer: questUrl,
                    routerStateTree: this.bot.browser.react.questRouterStateTree(parentId)
                }
            )

            const newBalance = await this.bot.browser.func.getCurrentPoints()
            const gained = newBalance - oldBalance
            if (gained > 0) {
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'PUNCHCARD',
                `Reported child | offerId=${offerId} | status=${status} | acknowledged=${acknowledged}${gained > 0 ? ` | gainedPoints=${gained}` : ''}`,
                gained > 0 || acknowledged ? 'green' : undefined
            )
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'PUNCHCARD',
                `Error reporting child | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async solveActivities(activities: BasePromotion[]) {
        for (const activity of activities) {
            try {
                const type = activity.promotionType?.toLowerCase() ?? ''
                const name = activity.name?.toLowerCase() ?? ''
                const offerId = (activity as BasePromotion).offerId

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'ACTIVITY',
                    `Processing activity | title="${activity.title}" | offerId=${offerId} | type=${type}`
                )

                switch (type) {
                    case 'urlreward': {
                        const basePromotion = activity as BasePromotion

                        // Search on Bing are subtypes of "urlreward"
                        const isSearchOnBing = name.includes('exploreonbing')

                        if (isSearchOnBing && !this.bot.config.activities.searchOnBing) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Skipping "SearchOnBing" (disabled in config) | offerId=${offerId}`
                            )
                            continue
                        }
                        if (!isSearchOnBing && !this.bot.config.activities.urlReward) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Skipping "UrlReward" (disabled in config) | offerId=${offerId}`
                            )
                            continue
                        }

                        if (isSearchOnBing) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Found activity type "SearchOnBing" | title="${activity.title}" | offerId=${offerId}`
                            )

                            const page = this.bot.isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage
                            await this.bot.activities.doSearchOnBing(basePromotion, page)
                        } else {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'ACTIVITY',
                                `Found activity type "UrlReward" | title="${activity.title}" | offerId=${offerId}`
                            )

                            await this.bot.activities.doUrlReward(basePromotion)
                        }
                        break
                    }

                    default: {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'ACTIVITY',
                            `Skipped activity "${activity.title}" | offerId=${offerId} | Reason: Unsupported type "${activity.promotionType}"`
                        )
                        break
                    }
                }

                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
            } catch (error) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'ACTIVITY',
                    `Error while solving activity "${activity.title}" | message=${error instanceof Error ? error.message : String(error)}`
                )
            }
        }
    }

    // Util
    private isSearchQuotaChild(offerId: string, api?: BasePromotion): boolean {
        if (api) {
            const type = (api.promotionType ?? '').toLowerCase()
            const attrType = String(api.attributes?.type ?? '').toLowerCase()
            const progressMax = Number(api.activityProgressMax ?? 0)
            if (type === 'search' || attrType === 'search' || progressMax > 1) {
                return true
            }
        }

        return /search/i.test(offerId) && /(day|streak|\dx)/i.test(offerId)
    }

    private isClaimChild(offerId: string, api?: BasePromotion): boolean {
        const dest = (api?.destinationUrl ?? '').toLowerCase()
        if (/\/redeem\//.test(dest)) return true
        return /(redeem|claim|(?<!url)reward)/i.test(offerId)
    }
}
