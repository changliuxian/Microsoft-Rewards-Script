import { ghostClick } from '../../../browser/GhostClick'
import type { Locator, Page } from 'patchright'
import { isBingHost } from '../../../constants/urls'

const KEY_DELAY_MS = 70
const PRE_FOCUS_PAUSE_MS = 600

export function bingSearchBox(page: Page): Locator {
    return page.locator('#sb_form_q:visible:not([disabled]):not([readonly])').first()
}

export async function humanType(page: Page, query: string, timeout = 30000, signal?: AbortSignal): Promise<Locator> {
    await page.bringToFront()
    const searchBox = bingSearchBox(page)
    await searchBox.waitFor({ state: 'visible', timeout })
    await ghostClick(page, searchBox, timeout, signal)
    await searchBox.fill('', { timeout })
    await searchBox.pressSequentially(query, { delay: KEY_DELAY_MS, timeout })
    return searchBox
}

export async function submitSearch(
    page: Page,
    query: string,
    searchBox: Locator,
    timeout = 45000,
    signal?: AbortSignal
): Promise<void> {
    const deadline = Date.now() + timeout
    const remaining = (): number => {
        signal?.throwIfAborted()
        return Math.max(1, deadline - Date.now())
    }
    const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()
    remaining()
    await page.bringToFront()
    await searchBox.press('Escape', { timeout: remaining() })
    if ((await searchBox.inputValue({ timeout: remaining() })) !== query) {
        await searchBox.fill(query, { timeout: remaining() })
    }
    try {
        await Promise.all([
            page.waitForURL(
                url =>
                    isBingHost(url.hostname) &&
                    url.pathname === '/search' &&
                    normalize(url.searchParams.get('q') ?? '') === normalize(query),
                { waitUntil: 'commit', timeout: remaining() }
            ),
            searchBox.press('Enter', { timeout: remaining() })
        ])
    } catch (error) {
        // The host and the path are what usually drift, so name them in the failure.
        const landed = page.isClosed() ? '<closed>' : page.url()
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${message} | expected=${JSON.stringify(query)} on *.bing.com/search | landed=${landed}`, {
            cause: error
        })
    }

    await page.locator('#b_results').waitFor({ state: 'visible', timeout: remaining() })
    remaining()
}

export function humanPreFocusPauseMs(): number {
    return PRE_FOCUS_PAUSE_MS
}
