import {
    getDirname,
    getProjectRoot,
    log,
    parseArgs,
    loadConfig,
    getSessionDbPath,
    openSessionDb,
    listSessionRows,
    clearSessionRows,
    closeSessionDb
} from '../utils.js'

const __dirname = getDirname(import.meta.url)
const projectRoot = getProjectRoot(__dirname)

const args = parseArgs()

const email = typeof args.email === 'string' ? args.email : null

const { data: config } = loadConfig(projectRoot)

const { dbPath, exists } = getSessionDbPath(projectRoot, config.sessionPath)

if (!exists) {
    log('INFO', `No sessions database found (looked for ${dbPath}) - nothing to clear.`)
    process.exit(0)
}

const db = openSessionDb(dbPath, { readonly: false })

let rows = []
try {
    rows = listSessionRows(db)
} catch {}

if (!rows.length) {
    log('INFO', `Sessions database is empty (${dbPath}) - nothing to clear.`)
    closeSessionDb(db)
    process.exit(0)
}

if (email) {
    const matches = rows.filter(r => r.email.toLowerCase() === email.toLowerCase())
    if (!matches.length) {
        log('WARN', `No stored sessions for ${email}. Stored accounts:`)
        const uniqueEmails = [...new Set(rows.map(r => r.email))]
        uniqueEmails.forEach(e => log('WARN', `  - ${e}`))
        closeSessionDb(db)
        process.exit(0)
    }
    log('INFO', `Clearing ${matches.length} session row(s) for ${email}...`)
} else {
    log('INFO', `Clearing all ${rows.length} session row(s) from ${dbPath}...`)
}

const removed = clearSessionRows(db, email)
closeSessionDb(db)

log('SUCCESS', `Removed ${removed} session row(s).`)
log('INFO', 'Done.')
