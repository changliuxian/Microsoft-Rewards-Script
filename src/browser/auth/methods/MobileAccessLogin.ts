import { URLs } from '../../../constants/urls'
import type { Page } from 'patchright'
import { randomBytes } from 'crypto'
import { URLSearchParams } from 'url'

import type { MicrosoftRewardsBot } from '../../../index'

export class MobileAccessLogin {
    private clientId = '0000000040170455'
    private authUrl = URLs.auth.oauthAuthorize
    private redirectUrl = URLs.auth.oauthRedirect
    private tokenUrl = URLs.auth.oauthToken
    private scope = 'service::prod.rewardsplatform.microsoft.com::MBI_SSL'

    constructor(
        private bot: MicrosoftRewardsBot,
        private page: Page
    ) {}

    async get(email: string): Promise<string> {
        try {
            const authorizeUrl = new URL(this.authUrl)
            authorizeUrl.searchParams.append('response_type', 'code')
            authorizeUrl.searchParams.append('client_id', this.clientId)
            authorizeUrl.searchParams.append('redirect_uri', this.redirectUrl)
            authorizeUrl.searchParams.append('scope', this.scope)
            authorizeUrl.searchParams.append('state', randomBytes(16).toString('hex'))
            authorizeUrl.searchParams.append('access_type', 'offline_access')
            authorizeUrl.searchParams.append('login_hint', email)

            this.bot.logger.debug(
                this.bot.isMobile,
                'LOGIN-APP',
                `Auth URL constructed: ${authorizeUrl.origin}${authorizeUrl.pathname}`
            )

            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-APP', 'Resolving mobile OAuth code via request')

            let code = ''
            try {
                const resp = await this.page.request.get(authorizeUrl.href, { maxRedirects: 20 })
                const finalUrl = new URL(resp.url())

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN-APP',
                    `OAuth redirect resolved → ${finalUrl.origin}${finalUrl.pathname} (status ${resp.status()})`
                )

                if (finalUrl.pathname === '/oauth20_desktop.srf') {
                    code = finalUrl.searchParams.get('code') || ''
                }
            } catch (err) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN-APP',
                    `OAuth code request failed: ${err instanceof Error ? err.message : String(err)}`
                )
            }

            if (!code) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN-APP',
                    'Could not resolve mobile OAuth code - app activities will be skipped this run'
                )
                return ''
            }

            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-APP', 'OAuth code resolved, exchanging for access token')

            const data = new URLSearchParams()
            data.append('grant_type', 'authorization_code')
            data.append('client_id', this.clientId)
            data.append('code', code)
            data.append('redirect_uri', this.redirectUrl)

            const response = await this.bot.http.request<{ access_token?: string }>({
                url: this.tokenUrl,
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                data: data.toString()
            })

            const token = response?.data?.access_token ?? ''

            if (!token) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-APP', 'No access_token in token response')
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN-APP',
                    `Token response payload: ${JSON.stringify(response?.data)}`
                )
                return ''
            }

            this.bot.logger.info(this.bot.isMobile, 'LOGIN-APP', 'Mobile access token received')
            return token
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-APP',
                `MobileAccess error: ${error instanceof Error ? error.stack || error.message : String(error)}`
            )
            return ''
        }
    }
}
