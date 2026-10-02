// Command-line client for the admin socket, for use inside the container:
//   docker exec <container> node dist/admin-cli.js <command> [args]
// Authenticates with the container's ADMIN_TOKEN env var.
import { connect } from 'node:net'

const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 8789
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''

const USAGE = `Usage: node dist/admin-cli.js <command> [args]

  status                          Switches, seed, loadout, lobby counts
  lobbies [--json]                Every lobby with its players
  manual-start on|off             Let hosts start games themselves (off = lobbies locked, admins start)
  force-seed on|off               Every game uses the rolled seed (off = random seed per game)
  force-combo on|off              Force the loadout's deck/stake (off = host's choice)
  reroll [SEED]                   New random seed, or set SEED (used while force-seed is on)
  loadout <deck|-> [stake|-]      Force deck (e.g. "Red Deck") and stake (1 = White, 8 = Gold, 11 = Spectral+); "-" = host's choice
  start <CODE...|all> [--force] [--ready-only]
                                  Start lobbies. --force restarts lobbies already in game,
                                  --ready-only skips lobbies whose guest isn't ready
  message <text> [CODE]           Show a message to everyone, or one lobby
`

// biome-ignore lint/suspicious/noExplicitAny: admin payloads are free-form JSON
const buildPayload = (args: string[]): Record<string, any> | null => {
	const [command, ...rest] = args
	const flags = new Set(rest.filter((a) => a.startsWith('--')))
	const positional = rest.filter((a) => !a.startsWith('--'))

	switch (command) {
		case 'status':
		case 'lobbies':
			return { command }
		case 'manual-start':
		case 'force-seed':
		case 'force-combo':
			if (positional[0] !== 'on' && positional[0] !== 'off') return null
			return { command: 'settings', [command.replace('-', '_')]: positional[0] === 'on' }
		case 'reroll':
			return positional[0] ? { command, seed: positional[0] } : { command }
		case 'loadout': {
			if (positional.length === 0) return null
			const back = positional[0] === '-' ? null : positional[0]
			const stake = !positional[1] || positional[1] === '-' ? null : Number(positional[1])
			return { command, back, stake }
		}
		case 'start':
			if (positional.length === 0) return null
			return {
				command,
				...(positional[0] === 'all' ? { all: true } : { lobby_code: positional }),
				force: flags.has('--force'),
				ready_only: flags.has('--ready-only'),
			}
		case 'message':
			if (!positional[0]) return null
			return { command, message: positional[0], lobby_code: positional[1] }
		default:
			return null
	}
}

type Player = { username: string; ready: boolean; lives: number; ante: number; location: string } | null
type LobbyRow = {
	code: string
	gameMode: string
	inGame: boolean
	seed: string | null
	host: Player
	guest: Player
	awaitingReconnect: string | null
}

const formatPlayer = (p: Player) =>
	p ? `${p.username}${p.ready ? ' (ready)' : ''} [lives ${p.lives}, ante ${p.ante}, ${p.location}]` : '-'

const printLobbies = (lobbies: LobbyRow[]) => {
	if (lobbies.length === 0) {
		console.log('No lobbies.')
		return
	}
	for (const l of lobbies) {
		const state = l.inGame ? `IN GAME seed ${l.seed ?? '(per-player)'}` : 'waiting'
		const reconnect = l.awaitingReconnect ? `, ${l.awaitingReconnect} reconnecting` : ''
		console.log(`${l.code}  ${l.gameMode}  ${state}${reconnect}`)
		console.log(`  host:  ${formatPlayer(l.host)}`)
		console.log(`  guest: ${formatPlayer(l.guest)}`)
	}
	console.log(`${lobbies.length} lobb${lobbies.length === 1 ? 'y' : 'ies'}`)
}

const main = () => {
	const args = process.argv.slice(2)
	const payload = buildPayload(args)
	if (!payload) {
		console.error(USAGE)
		process.exit(1)
	}
	if (!ADMIN_TOKEN) {
		console.error('ADMIN_TOKEN is not set in this environment')
		process.exit(1)
	}

	const socket = connect(ADMIN_PORT, '127.0.0.1')
	let data = ''
	socket.setTimeout(5000, () => {
		console.error('Timed out waiting for the admin server')
		socket.destroy()
		process.exit(1)
	})
	socket.on('connect', () => {
		socket.write(`${JSON.stringify({ payload: JSON.stringify(payload), token: ADMIN_TOKEN })}\n`)
	})
	socket.on('data', (chunk) => {
		data += chunk
	})
	socket.on('error', (error) => {
		console.error(`Could not reach the admin server on 127.0.0.1:${ADMIN_PORT}: ${error.message}`)
		process.exit(1)
	})
	socket.on('end', () => {
		let result
		try {
			result = JSON.parse(data)
		} catch {
			console.error(`Unexpected response: ${data}`)
			process.exit(1)
		}
		if (result.success && payload.command === 'lobbies' && !args.includes('--json')) {
			printLobbies(result.lobbies)
		} else {
			console.log(JSON.stringify(result, null, 2))
		}
		// Let the socket close cleanly instead of process.exit(), which resets it
		process.exitCode = result.success ? 0 : 1
	})
}

main()
