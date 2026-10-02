import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateSeed } from "./utils.js";

/**
 * Tournament mode state. While enabled:
 *  - hosts cannot start games themselves; only admins can (see Lobby.startGame)
 *  - every game uses the same server seed until it is rerolled
 *  - the deck/stake (if set) are forced on both players at game start
 *
 * Persisted to disk so a container restart mid-tournament keeps the same seed.
 */
export type TourneyState = {
	enabled: boolean;
	seed: string;
	/** Deck name as the mod knows it (e.g. "Red Deck"), or null to leave the host's choice */
	back: string | null;
	/** Stake number (1 = White ... 8 = Gold, mod stakes after that), or null to leave the host's choice */
	stake: number | null;
};

const STATE_PATH =
	process.env.TOURNEY_STATE_PATH ||
	(existsSync("/data") ? "/data/tourney.json" : "./data/tourney.json");

const load = (): TourneyState => {
	// Locked by default: until an admin turns tourney mode off, only admins can start games
	const fallback: TourneyState = {
		enabled: process.env.TOURNEY_ENABLED_DEFAULT !== "false",
		seed: generateSeed(),
		back: null,
		stake: null,
	};
	try {
		if (!existsSync(STATE_PATH)) return fallback;
		return { ...fallback, ...JSON.parse(readFileSync(STATE_PATH, "utf-8")) };
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

export const setTourneyEnabled = (enabled: boolean) => {
	state.enabled = enabled;
	save();
	console.log(`Tourney mode ${enabled ? "enabled" : "disabled"}`);
};

/** Picks a new random seed, or sets the given one. Applies to the next games started. */
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

/**
 * Lobby options pushed to both players right before startGame. The client
 * applies lobbyOptions from the server regardless of host/guest, and TCP keeps
 * them ordered before startGame, so these override whatever the host picked:
 *  - custom_seed/different_seeds: otherwise the host's custom seed (or per-player
 *    seeds) would replace the server seed client-side
 *  - different_decks=false makes both clients copy back/stake from these options
 */
export const forcedLobbyOptions = (): Record<string, string | number | boolean> => {
	const options: Record<string, string | number | boolean> = {
		custom_seed: "random",
		different_seeds: false,
	};
	if (state.back !== null || state.stake !== null) {
		options.different_decks = false;
		options.random_loadout = false;
		options.challenge = "";
		if (state.back !== null) options.back = state.back;
		if (state.stake !== null) options.stake = state.stake;
	}
	return options;
};
