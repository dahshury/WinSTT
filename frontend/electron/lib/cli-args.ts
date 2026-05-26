/**
 * Tiny manual CLI parser for the Electron main process.
 *
 * Why not commander/yargs:
 *   - Surface is just five long-form flags + `--help`; pulling in a
 *     500 KB+ dep for this is overkill.
 *   - The main process bundles via tsup, so every dep adds to the
 *     installer size. Keep the entry-point lean.
 *
 * Supported flags (mirror examples/Handy/src-tauri/src/cli.rs where the
 * action exists in our codebase):
 *
 *   --toggle-transcription   Toggle recording on/off (forwarded to running instance)
 *   --cancel                 Cancel the in-flight transcription / LLM pass
 *   --start-hidden           Launch without showing the main window (tray still visible)
 *   --no-tray                Launch without the system tray (closing window quits the app)
 *   --debug                  Verbose terminal logging (file log is always verbose)
 *   --help, -h               Print help and exit
 *
 * Notes:
 *   - The parser is permissive: unknown flags log a warning to stderr
 *     but don't abort. This is intentional — Electron itself appends
 *     flags like `--allow-file-access-from-files` and we don't want to
 *     reject the launch on every dev run.
 *   - When `--help` is present, every other action flag is ignored so
 *     the help text always wins.
 *   - All flags are runtime-only overrides — they never modify persisted
 *     settings on disk. Matches Handy's behaviour.
 */
export interface CliArgs {
	/** Cancel the in-flight operation (forwarded to running instance). */
	cancel: boolean;
	/** Enable verbose terminal logging. */
	debug: boolean;
	/** Print help and exit. */
	help: boolean;
	/** Launch without the system tray icon. */
	noTray: boolean;
	/** Launch without showing the main window. */
	startHidden: boolean;
	/** Toggle recording on/off (forwarded to running instance via single-instance). */
	toggleTranscription: boolean;
	/** Argv tokens we didn't recognise (for diagnostics). */
	unknown: string[];
}

/** Default CliArgs (all flags off, no unknowns). */
export function defaultCliArgs(): CliArgs {
	return {
		cancel: false,
		debug: false,
		help: false,
		noTray: false,
		startHidden: false,
		toggleTranscription: false,
		unknown: [],
	};
}

const FLAG_HANDLERS: Record<string, (args: CliArgs) => void> = {
	"--help": (a) => {
		a.help = true;
	},
	"-h": (a) => {
		a.help = true;
	},
	"--toggle-transcription": (a) => {
		a.toggleTranscription = true;
	},
	"--cancel": (a) => {
		a.cancel = true;
	},
	"--start-hidden": (a) => {
		a.startHidden = true;
	},
	"--no-tray": (a) => {
		a.noTray = true;
	},
	"--debug": (a) => {
		a.debug = true;
	},
	// `--verbose` is already consumed by debug-log.ts as a console-level
	// boost; keep it silently accepted here so the parser doesn't lump
	// it into `unknown`.
	"--verbose": () => undefined,
};

/**
 * Argv tokens injected by Electron / Chromium that we should silently
 * ignore — they're not "unknown WinSTT flags", they're framework noise.
 * Anything starting with these prefixes is dropped before unknown-flag
 * accounting. Tested explicitly so a future Electron upgrade adding new
 * switches doesn't surprise us with stderr noise.
 */
const ELECTRON_PREFIXES = [
	"--allow-",
	"--enable-",
	"--disable-",
	"--auto-",
	"--no-sandbox",
	"--user-data-dir",
	"--remote-debugging-",
	"--inspect",
	"--lang",
	"--log-",
	"--trace-",
	"--use-",
	"--gtk",
	"--ozone-",
	"--force-",
];

function isElectronFlag(token: string): boolean {
	if (!token.startsWith("--")) {
		return false;
	}
	return ELECTRON_PREFIXES.some((p) => token.startsWith(p));
}

/** Windows drive-letter prefix (e.g. `C:\Program Files\...`). Hoisted to
 *  module scope so the parser loop doesn't re-compile the literal on every
 *  argv token. */
const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:\\/;

/**
 * Parse argv into a CliArgs struct. Accepts the full process.argv
 * (skips argv[0]=node/electron and argv[1]=app entry); pass `slice(2)`
 * if you've already trimmed.
 *
 * @param tokens — array of flag tokens to inspect (without argv[0]/[1]).
 */
export function parseCliArgs(tokens: readonly string[]): CliArgs {
	const result = defaultCliArgs();
	for (const token of tokens) {
		const handler = FLAG_HANDLERS[token];
		if (handler) {
			handler(result);
			continue;
		}
		// Drop the leading argv[0]/[1] if a caller forgot to slice — these
		// are absolute paths to the binary and the app entry. Identifying
		// them by "starts with / or drive letter" keeps the parser pure.
		if (token.includes("/") || WINDOWS_DRIVE_PATH_RE.test(token)) {
			continue;
		}
		if (isElectronFlag(token)) {
			continue;
		}
		result.unknown.push(token);
	}
	return result;
}

/**
 * Strip Electron's own argv noise so the parser sees just the WinSTT
 * flags. process.argv[0] is the binary, [1] is the app entry; everything
 * after is user-supplied.
 */
export function argvForParse(argv: readonly string[]): string[] {
	return argv.slice(2);
}

/**
 * Help text printed to stdout when --help / -h is passed. Kept in this
 * module so the tests can lock the wording.
 */
export const HELP_TEXT = `WinSTT — speech-to-text desktop app

Usage:
  winstt [options]

Options:
  --toggle-transcription   Toggle recording on/off. If WinSTT is already
                           running, the request is forwarded to that
                           instance and this process exits.
  --cancel                 Cancel the in-flight transcription / LLM pass
                           on a running instance.
  --start-hidden           Launch without showing the main window (the
                           tray icon is still visible).
  --no-tray                Launch without the system tray icon (closing
                           the main window quits the app).
  --debug                  Verbose terminal logging (file log is always
                           verbose; see %APPDATA%/WinSTT/debug.log).
  -h, --help               Print this help and exit.

Wayland users (Sway, Hyprland, KDE):
  Bind your window manager's global-hotkey action to:
    winstt --toggle-transcription
  Alternatively, send a Unix signal to the running process:
    pkill -USR2 -n winstt   # toggle transcription
    pkill -USR1 -n winstt   # cancel current operation

CLI flags are runtime-only overrides — they never modify your persisted
settings. Re-run without the flag to restore the default behaviour.
`;
