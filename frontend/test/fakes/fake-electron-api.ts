type IpcHandler = (...args: unknown[]) => void;

export function createFakeElectronApi() {
	const handlers = new Map<string, Set<IpcHandler>>();
	const invokeHandlers = new Map<string, (...args: unknown[]) => unknown>();

	return {
		api: {
			send(channel: string, ...args: unknown[]) {
				const channelHandlers = handlers.get(channel);
				if (channelHandlers) {
					for (const handler of channelHandlers) {
						handler(...args);
					}
				}
			},
			invoke(channel: string, ...args: unknown[]) {
				const handler = invokeHandlers.get(channel);
				if (handler) {
					return handler(...args);
				}
				return undefined;
			},
			on(channel: string, callback: IpcHandler) {
				if (!handlers.has(channel)) {
					handlers.set(channel, new Set());
				}
				handlers.get(channel)!.add(callback);
				return () => {
					handlers.get(channel)?.delete(callback);
				};
			},
		},
		/** Simulate an event from main process */
		emit(channel: string, ...args: unknown[]) {
			const channelHandlers = handlers.get(channel);
			if (channelHandlers) {
				for (const handler of channelHandlers) {
					handler(...args);
				}
			}
		},
		/** Register a handler for invoke calls */
		onInvoke(channel: string, handler: (...args: unknown[]) => unknown) {
			invokeHandlers.set(channel, handler);
		},
	};
}
