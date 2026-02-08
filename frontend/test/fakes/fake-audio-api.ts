export function createFakeAudioContext() {
	return {
		createAnalyser: () => ({
			fftSize: 2048,
			frequencyBinCount: 1024,
			getByteFrequencyData: (array: Uint8Array) => {
				array.fill(128);
			},
			getByteTimeDomainData: (array: Uint8Array) => {
				array.fill(128);
			},
		}),
		createMediaStreamSource: () => ({
			connect: () => {
				/* noop mock */
			},
			disconnect: () => {
				/* noop mock */
			},
		}),
		close: () => Promise.resolve(),
		state: "running" as AudioContextState,
	};
}

export function createFakeMediaDevices() {
	return {
		enumerateDevices: async () => [
			{
				deviceId: "default",
				kind: "audioinput" as MediaDeviceKind,
				label: "Default Microphone",
				groupId: "default",
				toJSON: () => ({}),
			},
		],
		getUserMedia: async () =>
			({
				getTracks: () => [],
				getAudioTracks: () => [],
			}) as unknown as MediaStream,
	};
}
