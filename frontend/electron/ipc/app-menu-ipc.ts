import {
	type AppMenuBuiltItem,
	buildAppMenuTemplate,
	normalizeAppMenuTemplate,
} from "./app-menu-template";

export const APP_MENU_SET_TEMPLATE_CHANNEL = "app-menu:set-template";
export const APP_MENU_RESET_CHANNEL = "app-menu:reset";

type IpcHandler = (_event: unknown, payload?: unknown) => unknown | Promise<unknown>;

export interface IpcMainLike {
	handle(channel: string, listener: IpcHandler): void;
	removeHandler(channel: string): void;
}

export interface AppMenuController {
	applyTemplate(template: AppMenuBuiltItem[]): void;
	reset(): void;
}

export interface RegisterAppMenuIpcHandlersOptions {
	actionHandlers: Readonly<Record<string, () => void>>;
	ipcMain: IpcMainLike;
	menuController: AppMenuController;
}

export function registerAppMenuIpcHandlers({
	ipcMain,
	menuController,
	actionHandlers,
}: RegisterAppMenuIpcHandlersOptions): () => void {
	ipcMain.removeHandler(APP_MENU_SET_TEMPLATE_CHANNEL);
	ipcMain.removeHandler(APP_MENU_RESET_CHANNEL);

	ipcMain.handle(APP_MENU_SET_TEMPLATE_CHANNEL, (_event, payload: unknown) => {
		const normalized = normalizeAppMenuTemplate(payload);
		const template = buildAppMenuTemplate(normalized, actionHandlers);
		menuController.applyTemplate(template);
		return { applied: true, itemCount: template.length };
	});

	ipcMain.handle(APP_MENU_RESET_CHANNEL, () => {
		menuController.reset();
		return { applied: true };
	});

	return () => {
		ipcMain.removeHandler(APP_MENU_SET_TEMPLATE_CHANNEL);
		ipcMain.removeHandler(APP_MENU_RESET_CHANNEL);
		menuController.reset();
	};
}
