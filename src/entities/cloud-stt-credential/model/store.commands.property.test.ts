import { beforeEach, test } from "bun:test";
import fc from "fast-check";
import { useSettingsStore } from "@/entities/setting/@x/cloud-stt-credential";
import type { CloudSttProvider } from "@/shared/api/models";
import {
	type CredentialStatus,
	type ProviderStatusEntry,
	useCredentialStatusStore,
} from "./store";

const PROVIDERS: CloudSttProvider[] = ["openai", "elevenlabs"];
const STATUSES: CredentialStatus[] = [
	"idle",
	"verifying",
	"verified",
	"invalid",
	"offline",
];

interface Model {
	byProvider: Record<CloudSttProvider, CredentialStatus>;
}

type Real = typeof useCredentialStatusStore;

function resetAll(): void {
	window.localStorage.removeItem("winstt-settings");
	useSettingsStore.getState().resetSettings();
	useSettingsStore.getState().updateIntegrations({
		openai: { apiKey: "" },
		elevenlabs: { apiKey: "" },
	});
	useCredentialStatusStore.setState({
		byProvider: {
			openai: { status: "idle" },
			elevenlabs: { status: "idle" },
		},
	});
}

beforeEach(resetAll);

function freshModel(): Model {
	return { byProvider: { openai: "idle", elevenlabs: "idle" } };
}

function assertInvariants(real: Real): void {
	const s = real.getState();
	// shape: each provider must have an entry with a known status
	for (const p of PROVIDERS) {
		const entry = s.byProvider[p];
		if (entry === undefined) {
			throw new Error(`missing entry for ${p}`);
		}
		if (!STATUSES.includes(entry.status)) {
			throw new Error(`status out of enum: ${entry.status}`);
		}
	}
}

class SetStatusCmd implements fc.Command<Model, Real> {
	readonly provider: CloudSttProvider;
	readonly entry: ProviderStatusEntry;
	constructor(provider: CloudSttProvider, entry: ProviderStatusEntry) {
		this.provider = provider;
		this.entry = entry;
	}
	check(): boolean {
		return true;
	}
	run(m: Model, real: Real): void {
		const otherProvider: CloudSttProvider =
			this.provider === "openai" ? "elevenlabs" : "openai";
		const otherBefore = real.getState().byProvider[otherProvider];
		real.getState().setStatus(this.provider, this.entry);
		m.byProvider[this.provider] = this.entry.status;
		const after = real.getState();
		if (after.byProvider[this.provider].status !== this.entry.status) {
			throw new Error("setStatus did not persist");
		}
		// orthogonality: other provider untouched (reference equality holds)
		if (after.byProvider[otherProvider] !== otherBefore) {
			throw new Error("setStatus mutated other provider");
		}
		assertInvariants(real);
	}
	toString(): string {
		return `setStatus(${this.provider}=${this.entry.status})`;
	}
}

class ResetCmd implements fc.Command<Model, Real> {
	readonly provider: CloudSttProvider;
	constructor(provider: CloudSttProvider) {
		this.provider = provider;
	}
	check(): boolean {
		return true;
	}
	run(m: Model, real: Real): void {
		const otherProvider: CloudSttProvider =
			this.provider === "openai" ? "elevenlabs" : "openai";
		const otherBefore = real.getState().byProvider[otherProvider];
		real.getState().reset(this.provider);
		m.byProvider[this.provider] = "idle";
		const after = real.getState();
		if (after.byProvider[this.provider].status !== "idle") {
			throw new Error("reset did not flip to idle");
		}
		if (after.byProvider[otherProvider] !== otherBefore) {
			throw new Error("reset mutated other provider");
		}
		assertInvariants(real);
	}
	toString(): string {
		return `reset(${this.provider})`;
	}
}

class UpdateApiKeyCmd implements fc.Command<Model, Real> {
	readonly provider: CloudSttProvider;
	readonly key: string;
	constructor(provider: CloudSttProvider, key: string) {
		this.provider = provider;
		this.key = key;
	}
	check(): boolean {
		return true;
	}
	run(m: Model, real: Real): void {
		// settings subscription should reset THIS provider if its key changed AND its status isn't idle
		const currentSettings = useSettingsStore.getState().settings;
		const prevKey = currentSettings.integrations[this.provider].apiKey;
		const keyChanged = prevKey !== this.key;
		const wasNonIdle = m.byProvider[this.provider] !== "idle";

		const otherProvider: CloudSttProvider =
			this.provider === "openai" ? "elevenlabs" : "openai";
		const otherStatusBefore = m.byProvider[otherProvider];

		useSettingsStore
			.getState()
			.updateIntegrations({ [this.provider]: { apiKey: this.key } });

		if (keyChanged && wasNonIdle) {
			m.byProvider[this.provider] = "idle";
		}
		// other provider's status is unchanged (its key didn't change)

		const after = real.getState();
		if (
			after.byProvider[this.provider].status !== m.byProvider[this.provider]
		) {
			throw new Error(
				`status mismatch after updateKey: model=${m.byProvider[this.provider]} real=${after.byProvider[this.provider].status}`,
			);
		}
		if (after.byProvider[otherProvider].status !== otherStatusBefore) {
			throw new Error(
				"other provider's status changed on single-provider key update",
			);
		}
		assertInvariants(real);
	}
	toString(): string {
		return `updateKey(${this.provider}=${this.key.slice(0, 6)})`;
	}
}

const statusArb = fc.constantFrom<CredentialStatus>(...STATUSES);
const providerArb = fc.constantFrom<CloudSttProvider>(...PROVIDERS);
const entryArb: fc.Arbitrary<ProviderStatusEntry> = fc.record({
	status: statusArb,
	lastError: fc.option(fc.string({ maxLength: 24 }), { nil: undefined }),
});

const commandsArb = fc.commands(
	[
		fc.tuple(providerArb, entryArb).map(([p, e]) => new SetStatusCmd(p, e)),
		providerArb.map((p) => new ResetCmd(p)),
		fc
			.tuple(providerArb, fc.string({ maxLength: 12 }))
			.map(([p, k]) => new UpdateApiKeyCmd(p, k)),
	],
	{ maxCommands: 30 },
);

test("credential-status-store: arbitrary commands keep invariants and model-real parity", () => {
	fc.assert(
		fc.property(commandsArb, (cmds) => {
			resetAll();
			fc.modelRun(
				() => ({ model: freshModel(), real: useCredentialStatusStore }),
				cmds,
			);
		}),
		{ numRuns: 60 },
	);
});

// Idempotency: reset twice on same provider == reset once
test("credential-status-store: reset(provider) is idempotent", () => {
	fc.assert(
		fc.property(providerArb, statusArb, (provider, status) => {
			resetAll();
			useCredentialStatusStore.getState().setStatus(provider, { status });
			useCredentialStatusStore.getState().reset(provider);
			const s1 = useCredentialStatusStore.getState().byProvider[provider];
			useCredentialStatusStore.getState().reset(provider);
			const s2 = useCredentialStatusStore.getState().byProvider[provider];
			return s1.status === "idle" && s2.status === "idle";
		}),
		{ numRuns: 40 },
	);
});

// Invariant: a key-change-followed-by-reread leaves the affected provider idle.
test("credential-status-store: after a non-idle key change, that provider becomes idle", () => {
	fc.assert(
		fc.property(
			providerArb,
			statusArb.filter((s) => s !== "idle"),
			fc.string({ maxLength: 16, minLength: 1 }),
			(provider, status, key) => {
				resetAll();
				useCredentialStatusStore.getState().setStatus(provider, { status });
				useSettingsStore
					.getState()
					.updateIntegrations({ [provider]: { apiKey: key } });
				return (
					useCredentialStatusStore.getState().byProvider[provider].status ===
					"idle"
				);
			},
		),
		{ numRuns: 50 },
	);
});
