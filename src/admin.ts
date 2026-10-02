// Admin interface: a localhost socket (used by .github/admin_message.py and
// dist/admin-cli.js via `docker exec`) and an optional token-protected HTTP API
// meant to sit behind a reverse proxy. Both dispatch to the same handlers.
import { createHash, verify as cryptoVerify, createPublicKey, timingSafeEqual } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Client from './Client.js'
import Lobby, { Lobbies } from './Lobby.js'
import { type TourneySwitch, forcedSeed, getTourney, rerollSeed, setLoadout, setSwitch } from './tourney.js'

const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 8789
const ADMIN_HTTP_PORT = Number(process.env.ADMIN_HTTP_PORT) || 8790
/** Shared secret accepted instead of an Ed25519 signature. Also required for the HTTP API. */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''
const MAX_HTTP_BODY_BYTES = 64 * 1024

// Works under both tsc-emitted ESM (npm run start) and the esbuild CJS bundle
// used by pkg. import.meta.url is undefined in CJS output; __dirname is
// undefined in ESM. typeof is the only safe way to probe an undeclared name.
const scriptDir = typeof __dirname !== 'undefined'
	? __dirname
	: dirname(fileURLToPath(import.meta.url))
const ADMIN_PUBLIC_KEY_PATH = resolve(scriptDir, '..', '.github', 'admin_public.pem')
const adminPublicKey = existsSync(ADMIN_PUBLIC_KEY_PATH)
	? createPublicKey(readFileSync(ADMIN_PUBLIC_KEY_PATH, 'utf-8'))
	: null

if (!adminPublicKey && !ADMIN_TOKEN) {
	console.warn('WARNING: neither admin_public.pem nor ADMIN_TOKEN is set, admin server will reject all requests')
}

const verifyAdminSignature = (payload: string, signature: string): boolean => {
	if (!adminPublicKey) return false
	try {
		return cryptoVerify(null, Buffer.from(payload), adminPublicKey, Buffer.from(signature, 'base64'))
	} catch {
		return false
	}
}

const verifyAdminToken = (token: unknown): boolean => {
	if (!ADMIN_TOKEN || typeof token !== 'string') return false
	// Compare fixed-length digests so the comparison is constant-time regardless of input length
	const a = createHash('sha256').update(token).digest()
	const b = createHash('sha256').update(ADMIN_TOKEN).digest()
	return timingSafeEqual(a, b)
}

// biome-ignore lint/suspicious/noExplicitAny: admin results are free-form JSON
type AdminResult = { success: boolean; error?: string; [key: string]: any }
// biome-ignore lint/suspicious/noExplicitAny: admin payloads are free-form JSON
type AdminHandler = (parsed: any) => AdminResult

const sendToTargets = (
	lobby_code: string | undefined,
	is_host: boolean | undefined,
	// biome-ignore lint/suspicious/noExplicitAny: forwarded as-is to clients
	action: any,
): AdminResult => {
	let recipients = 0

	if (lobby_code) {
		const lobby = Lobbies.get(lobby_code)
		if (!lobby) return { success: false, error: 'Lobby not found' }

		if (is_host === true) {
			if (lobby.host) { lobby.host.sendAction(action); recipients++ }
		} else if (is_host === false) {
			if (lobby.guest) { lobby.guest.sendAction(action); recipients++ }
		} else {
			if (lobby.host) { lobby.host.sendAction(action); recipients++ }
			if (lobby.guest) { lobby.guest.sendAction(action); recipients++ }
		}
	} else {
		for (const lobby of Lobbies.values()) {
			if (lobby.host) { lobby.host.sendAction(action); recipients++ }
			if (lobby.guest) { lobby.guest.sendAction(action); recipients++ }
		}
	}

	return { success: true, recipients }
}

/** Usernames arrive as "<name>~<blind colour>"; strip the colour for display. */
const displayName = (client: Client) => client.username.replace(/~\d+$/, '')

const describePlayer = (client: Client | null) => {
	if (!client) return null
	return {
		username: displayName(client),
		ready: client.isReadyLobby,
		lives: client.lives,
		ante: client.ante,
		location: client.location,
	}
}

const describeLobby = (lobby: Lobby) => ({
	code: lobby.code,
	gameMode: lobby.gameMode,
	inGame: lobby.isInGame,
	seed: lobby.seed,
	host: describePlayer(lobby.host),
	guest: describePlayer(lobby.guest),
	/** A player dropped mid-game and their slot is reserved for reconnection */
	awaitingReconnect: lobby.disconnectedSlot ? lobby.disconnectedSlot.role : null,
})

/** Why a lobby can't be started right now, or null if it can. */
const startBlocker = (lobby: Lobby, force: boolean, readyOnly: boolean): string | null => {
	if (!lobby.host || !lobby.guest) return 'needs two players'
	if (lobby.disconnectedSlot) return 'a player is reconnecting'
	if (lobby.isInGame && !force) return 'already in game (use force to restart)'
	if (readyOnly && !lobby.guest.isReadyLobby) return 'guest not ready'
	return null
}

const adminHandlers: Record<string, AdminHandler> = {
	message(parsed) {
		const { message, lobby_code, is_host } = parsed
		if (!message || typeof message !== 'string') {
			return { success: false, error: 'Missing message' }
		}
		return sendToTargets(lobby_code, is_host, { action: 'error', message })
	},

	jimboAppear(parsed) {
		const { pos, text, lobby_code, is_host } = parsed
		if (typeof pos !== 'number' || pos < 1 || pos > 4) {
			return { success: false, error: 'pos must be a number 1-4' }
		}
		if (text !== undefined && typeof text !== 'string') {
			return { success: false, error: 'text must be a string' }
		}
		return sendToTargets(lobby_code, is_host, { action: 'jimboAppear', pos, text })
	},

	jimboTalk(parsed) {
		const { text, lobby_code, is_host } = parsed
		if (!text || typeof text !== 'string') {
			return { success: false, error: 'Missing text' }
		}
		return sendToTargets(lobby_code, is_host, { action: 'jimboTalk', text })
	},

	jimboMove(parsed) {
		const { pos, lobby_code, is_host } = parsed
		if (typeof pos !== 'number' || pos < 1 || pos > 4) {
			return { success: false, error: 'pos must be a number 1-4' }
		}
		return sendToTargets(lobby_code, is_host, { action: 'jimboMove', pos })
	},

	jimboRemove(parsed) {
		const { lobby_code, is_host } = parsed
		return sendToTargets(lobby_code, is_host, { action: 'jimboRemove' })
	},

	listLobbies() {
		const lobbies: string[] = []
		for (const [code, lobby] of Lobbies.entries()) {
			const host = lobby.host?.username ?? '???'
			const guest = lobby.guest?.username
			lobbies.push(guest ? `${code} - ${host}, ${guest}` : `${code} - ${host}`)
		}
		return { success: true, count: lobbies.length, lobbies }
	},

	// --- Tournament commands ---

	/** Detailed lobby list with players, for checking up on games */
	lobbies() {
		const lobbies = [...Lobbies.values()].map(describeLobby)
		return { success: true, count: lobbies.length, lobbies }
	},

	status() {
		let inGame = 0
		for (const lobby of Lobbies.values()) if (lobby.isInGame) inGame++
		return { success: true, tourney: getTourney(), lobbyCount: Lobbies.size, inGame }
	},

	/**
	 * { manual_start?: boolean, force_seed?: boolean, force_combo?: boolean } — flip any of
	 * the three switches (see tourney.ts). Omitted ones are left as they are.
	 */
	settings(parsed) {
		const switches: [string, TourneySwitch][] = [
			['manual_start', 'manualStart'],
			['force_seed', 'forceSeed'],
			['force_combo', 'forceCombo'],
		]
		const given = switches.filter(([key]) => parsed[key] !== undefined)
		if (given.length === 0) {
			return { success: false, error: 'Pass at least one of manual_start, force_seed, force_combo' }
		}
		const bad = given.find(([key]) => typeof parsed[key] !== 'boolean')
		if (bad) return { success: false, error: `${bad[0]} must be true or false` }
		for (const [key, name] of given) setSwitch(name, parsed[key])
		return { success: true, tourney: getTourney() }
	},

	/** { seed?: string } — new random seed, or the given one */
	reroll(parsed) {
		const { seed } = parsed
		if (seed !== undefined && (typeof seed !== 'string' || !/^[A-Za-z0-9]{1,16}$/.test(seed))) {
			return { success: false, error: 'seed must be 1-16 letters/digits' }
		}
		return { success: true, seed: rerollSeed(seed), tourney: getTourney() }
	},

	/** { back?: string | null, stake?: number | null } — null/omitted leaves it to the host */
	loadout(parsed) {
		const back = parsed.back ?? null
		const stake = parsed.stake ?? null
		if (back !== null && (typeof back !== 'string' || back.length === 0)) {
			return { success: false, error: 'back must be a deck name like "Red Deck"' }
		}
		// Vanilla stakes are 1-8 (1 = White, 8 = Gold); the mod adds more after Gold
		// (Planet 9, Spectral 10, Spectral+ 11), so only bound it loosely
		if (stake !== null && (!Number.isInteger(stake) || stake < 1 || stake > 32)) {
			return { success: false, error: 'stake must be an integer 1-32 (1 = White, 8 = Gold, 11 = Spectral+)' }
		}
		setLoadout(back, stake)
		return { success: true, tourney: getTourney() }
	},

	/**
	 * { lobby_code?: string | string[], all?: boolean, force?: boolean, ready_only?: boolean }
	 * Starts the given lobbies (or every lobby with `all`). Lobbies that can't start are
	 * reported in `skipped` with the reason.
	 */
	start(parsed) {
		const force = parsed.force === true
		const readyOnly = parsed.ready_only === true

		let targets: Lobby[]
		const missing: string[] = []
		if (parsed.all === true) {
			targets = [...Lobbies.values()]
		} else {
			const codes: unknown[] = Array.isArray(parsed.lobby_code) ? parsed.lobby_code : [parsed.lobby_code]
			if (codes.length === 0 || codes.some((c) => typeof c !== 'string' || !c)) {
				return { success: false, error: 'Pass lobby_code (string or list) or all: true' }
			}
			targets = []
			for (const code of codes as string[]) {
				const lobby = Lobbies.get(code.toUpperCase())
				if (lobby) targets.push(lobby)
				else missing.push(code)
			}
		}

		const started: string[] = []
		const skipped: { code: string; reason: string }[] = missing.map((code) => ({ code, reason: 'lobby not found' }))
		for (const lobby of targets) {
			const reason = startBlocker(lobby, force, readyOnly)
			if (reason) {
				skipped.push({ code: lobby.code, reason })
				continue
			}
			lobby.startGame()
			started.push(lobby.code)
		}
		console.log(`Admin start: started [${started.join(', ')}], skipped ${skipped.length}`)
		return { success: true, seed: forcedSeed(), started, skipped }
	},
}

// biome-ignore lint/suspicious/noExplicitAny: admin payloads are free-form JSON
const runCommand = (parsed: any): AdminResult => {
	const command = parsed?.command ?? 'message'
	const handler = adminHandlers[command]
	if (!handler) return { success: false, error: `Unknown command: ${command}` }
	try {
		return handler(parsed)
	} catch (error) {
		console.error(`Admin command ${command} failed:`, error)
		return { success: false, error: 'Command failed' }
	}
}

// Socket server: one JSON envelope per line, { payload, signature } or { payload, token },
// where payload is a JSON string like '{"command":"lobbies"}'.
const adminServer = createServer((socket) => {
	// Without a listener, a client resetting the connection would crash the game server
	socket.on('error', (error) => console.warn('Admin socket error:', error.message))
	socket.on('data', (data) => {
		const messages = data.toString().split('\n')
		for (const msg of messages) {
			if (!msg) continue
			try {
				const envelope = JSON.parse(msg)
				const { payload, signature, token } = envelope

				if (!payload || (!signature && !token)) {
					socket.end(JSON.stringify({ success: false, error: 'Missing payload or signature/token' }) + '\n')
					return
				}

				const authorized = signature ? verifyAdminSignature(payload, signature) : verifyAdminToken(token)
				if (!authorized) {
					socket.end(JSON.stringify({ success: false, error: 'Invalid signature or token' }) + '\n')
					return
				}

				socket.end(JSON.stringify(runCommand(JSON.parse(payload))) + '\n')
			} catch (error) {
				socket.end(JSON.stringify({ success: false, error: 'Invalid JSON' }) + '\n')
			}
		}
	})
})

adminServer.listen(ADMIN_PORT, '127.0.0.1', () => {
	console.log(`Admin server listening on 127.0.0.1:${ADMIN_PORT}`)
})

// HTTP API: `GET|POST /admin/<command>` with `Authorization: Bearer <ADMIN_TOKEN>`.
// POST bodies are the command's JSON arguments. Only started when ADMIN_TOKEN is set.
if (ADMIN_TOKEN) {
	const httpServer = createHttpServer((req, res) => {
		// Without listeners, an aborted request would crash the game server
		req.on('error', (error) => console.warn('Admin HTTP request error:', error.message))
		res.on('error', (error) => console.warn('Admin HTTP response error:', error.message))

		const reply = (status: number, body: AdminResult) => {
			if (res.headersSent) return
			res.writeHead(status, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify(body))
		}

		const match = /^\/admin\/([A-Za-z]+)\/?(?:\?.*)?$/.exec(req.url ?? '')
		if (!match) return reply(404, { success: false, error: 'Not found' })
		if (req.method !== 'GET' && req.method !== 'POST') {
			return reply(405, { success: false, error: 'Use GET or POST' })
		}

		const auth = req.headers.authorization ?? ''
		if (!auth.startsWith('Bearer ') || !verifyAdminToken(auth.slice(7))) {
			return reply(401, { success: false, error: 'Unauthorized' })
		}

		let body = ''
		let tooLarge = false
		req.on('data', (chunk) => {
			if (tooLarge) return
			body += chunk
			if (body.length > MAX_HTTP_BODY_BYTES) {
				tooLarge = true
				reply(413, { success: false, error: 'Body too large' })
				req.destroy()
			}
		})
		req.on('end', () => {
			if (tooLarge) return
			let args = {}
			if (body.trim()) {
				try {
					args = JSON.parse(body)
				} catch {
					return reply(400, { success: false, error: 'Invalid JSON body' })
				}
			}
			const result = runCommand({ ...args, command: match[1] })
			reply(result.success ? 200 : 400, result)
		})
	})

	const host = process.env.ADMIN_HTTP_HOST || '0.0.0.0'
	httpServer.listen(ADMIN_HTTP_PORT, host, () => {
		console.log(`Admin HTTP API listening on ${host}:${ADMIN_HTTP_PORT}`)
	})
}
