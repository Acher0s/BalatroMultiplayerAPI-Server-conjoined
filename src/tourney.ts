import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateSeed } from "./utils.js";

/**
 * Tournament settings, three independent switches:
 *  - manualStart: when false (the default), lobbies are locked and hosts can't start
 *    games themselves; only admins can (see admin.ts `start`)
 *  - forceSeed: when true, every game in every lobby uses `seed`, including games
 *    played back to back, until it's rerolled. When false, each game gets a random
 *    seed as normal. Turning it back on brings back the last rolled seed.
 *  - forceCombo: when true, the deck/stake (whichever is set) are forced on both players
 *
 * Forcing applies to every game start, whether a host or an admin started it.
 * Persisted to disk so a container restart mid-tournament keeps the same settings and seed.
 */
export type TourneyState = {
	manualStart: boolean;
	forceSeed: boolean;
	forceCombo: boolean;
	seed: string;
	/** Deck name as the mod knows it (e.g. "Red Deck"), or null to leave the host's choice */
	back: string | null;
	/** Stake number (1 = White ... 8 = Gold, mod stakes after that), or null to leave the host's choice */
	stake: number | null;
};

export type TourneySwitch = "manualStart" | "forceSeed" | "forceCombo";

const STATE_PATH =
	process.env.TOURNEY_STATE_PATH ||
	(existsSync("/data") ? "/data/tourney.json" : "./data/tourney.json");

const load = (): TourneyState => {
	// Default: lobbies locked, seed forced, deck/stake forced once a combo is set
	const fallback: TourneyState = {
		manualStart: false,
		forceSeed: true,
		forceCombo: true,
		seed: generateSeed(),
		back: null,
		stake: null,
	};
	try {
		if (!existsSync(STATE_PATH)) return fallback;
		const saved = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
		// Files from before the switches were split had one `enabled` flag for all three
		if (typeof saved.enabled === "boolean" && saved.manualStart === undefined) {
			saved.manualStart = !saved.enabled;
			saved.forceSeed = saved.enabled;
			saved.forceCombo = saved.enabled;
		}
		delete saved.enabled;
		return { ...fallback, ...saved };
	} catch (error) {
		console.error(`Failed to read tourney state from ${STATE_PATH}:`, error);
		return fallback;
	}
};

const state: TourneyState = load();

const save = () => {
	try {
		mkdirSync(dirname(STATE_PATH), { recursive: true });
		writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
	} catch (error) {
		console.error(`Failed to write tourney state to ${STATE_PATH}:`, error);
	}
};

export const getTourney = (): Readonly<TourneyState> => state;

export const setSwitch = (name: TourneySwitch, value: boolean) => {
	state[name] = value;
	save();
	console.log(`Tourney ${name} set to ${value}`);
};

/** Picks a new random seed, or sets the given one. Used by the next games started while forceSeed is on. */
export const rerollSeed = (seed?: string): string => {
	state.seed = seed ? seed.toUpperCase() : generateSeed();
	save();
	console.log(`Tourney seed set to ${state.seed}`);
	return state.seed;
};

export const setLoadout = (back: string | null, stake: number | null) => {
	state.back = back;
	state.stake = stake;
	save();
	console.log(`Tourney loadout set to back=${back ?? "(host choice)"} stake=${stake ?? "(host choice)"}`);
};

/** The seed a game starting now should use, or null to pick one the normal way. */
export const forcedSeed = (): string | null => (state.forceSeed ? state.seed : null);

/**
 * Lobby options pushed to both players right before startGame. The client
 * applies lobbyOptions from the server regardless of host/guest, and TCP keeps
 * them ordered before startGame, so these override whatever the host picked:
 *  - custom_seed/different_seeds: otherwise the host's custom seed (or per-player
 *    seeds) would replace the server seed client-side
 *  - different_decks=false makes both clients copy back/stake from these options
 * Empty when nothing is forced.
 */
export const forcedLobbyOptions = (): Record<string, string | number | boolean> => {
	const options: Record<string, string | number | boolean> = {};
	if (state.forceSeed) {
		options.custom_seed = "random";
		options.different_seeds = false;
	}
	if (state.forceCombo && (state.back !== null || state.stake !== null)) {
		options.different_decks = false;
		options.random_loadout = false;
		options.challenge = "";
		if (state.back !== null) options.back = state.back;
		if (state.stake !== null) options.stake = state.stake;
	}
	return options;
};
