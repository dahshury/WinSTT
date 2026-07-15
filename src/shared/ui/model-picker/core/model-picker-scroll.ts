const MODEL_LIST_SELECTOR = [
	'[data-slot="ollama-model-list"]',
	'[data-slot="stt-model-list"]',
	'[data-slot="tts-model-list"]',
].join(",");

function findModelItem(root: ParentNode, modelId: string): HTMLElement | null {
	for (const item of root.querySelectorAll<HTMLElement>("[data-model-id]")) {
		if (item.dataset["modelId"] === modelId) {
			return item;
		}
	}
	return null;
}

function findModelListContainer(
	root: HTMLElement,
	target: HTMLElement,
): HTMLElement {
	const slottedList = target.closest<HTMLElement>(MODEL_LIST_SELECTOR);
	if (slottedList && root.contains(slottedList)) {
		return slottedList;
	}
	for (
		let element = target.parentElement;
		element;
		element = element.parentElement
	) {
		if (element.scrollHeight > element.clientHeight) {
			return element;
		}
		if (element === root) {
			break;
		}
	}
	return root;
}

export function scrollModelItemIntoView(
	root: HTMLElement,
	modelId: string,
): boolean {
	const target = findModelItem(root, modelId);
	if (!target) {
		return false;
	}
	const scrollContainer = findModelListContainer(root, target);
	const targetRect = target.getBoundingClientRect();
	const containerRect = scrollContainer.getBoundingClientRect();
	scrollContainer.scrollTop += targetRect.top - containerRect.top;
	return true;
}
