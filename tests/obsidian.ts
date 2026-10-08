import { vi } from "vitest";

export interface TestRequestOptions {
	url: string;
	headers?: Record<string, string>;
}

export interface TestResponse {
	status: number;
	json: Record<string, unknown>;
}

export const requestUrl = vi.fn<(options: TestRequestOptions) => Promise<TestResponse>>();

type Handler = (event: Event) => void;

export class TestElement {
	readonly tagName: string;
	readonly children: TestElement[] = [];
	readonly attributes: Record<string, string> = {};
	readonly handlers = new Map<string, Handler[]>();
	textContent = "";
	value = "";
	placeholder = "";
	title = "";
	disabled = false;
	className = "";
	focused = false;
	readonly classList = {
		add: (name: string) => {
			const names = new Set(this.className.split(/\s+/).filter(Boolean));
			names.add(name);
			this.className = [...names].join(" ");
		},
		remove: (name: string) => {
			this.className = this.className
				.split(/\s+/)
				.filter((item) => item && item !== name)
				.join(" ");
		},
		contains: (name: string) => this.className.split(/\s+/).includes(name),
	};

	constructor(tagName: string, options: Record<string, unknown> = {}) {
		this.tagName = tagName.toLowerCase();
		this.applyOptions(options);
	}

	createEl(tagName: string, options: Record<string, unknown> = {}): TestElement {
		const child = new TestElement(tagName, options);
		this.children.push(child);
		return child;
	}

	createDiv(options: Record<string, unknown> = {}): TestElement {
		return this.createEl("div", options);
	}

	empty(): void {
		this.children.length = 0;
		this.textContent = "";
	}

	setText(text: string): void {
		this.textContent = text;
	}

	addClass(name: string): void {
		this.classList.add(name);
	}

	removeClass(name: string): void {
		this.classList.remove(name);
	}

	setAttribute(name: string, value: string): void {
		this.attributes[name] = String(value);
	}

	getAttribute(name: string): string | null {
		return this.attributes[name] ?? null;
	}

	addEventListener(name: string, handler: EventListenerOrEventListenerObject): void {
		const callback: Handler =
			typeof handler === "function"
				? (event) => handler(event)
				: (event) => handler.handleEvent(event);
		this.handlers.set(name, [...(this.handlers.get(name) ?? []), callback]);
	}

	trigger(name: string, properties: Record<string, unknown> = {}): void {
		const event = {
			target: this,
			currentTarget: this,
			preventDefault() {},
			...properties,
		} as unknown as Event;
		for (const handler of this.handlers.get(name) ?? []) handler(event);
	}

	find(predicate: (element: TestElement) => boolean): TestElement[] {
		const found: TestElement[] = predicate(this) ? [this] : [];
		for (const child of this.children) found.push(...child.find(predicate));
		return found;
	}

	querySelectorAll<T extends Element = Element>(selector: string): NodeListOf<T> {
		const elements = this.find((element) => {
			if (selector === '[role="tab"]') return element.getAttribute("role") === "tab";
			if (selector === '[role="tabpanel"]')
				return element.getAttribute("role") === "tabpanel";
			return false;
		});
		return elements as unknown as NodeListOf<T>;
	}

	focus(): void {
		this.focused = true;
	}

	private applyOptions(options: Record<string, unknown>): void {
		if (typeof options.text === "string") this.textContent = options.text;
		if (typeof options.value === "string") this.value = options.value;
		if (typeof options.placeholder === "string") this.placeholder = options.placeholder;
		if (typeof options.title === "string") this.title = options.title;
		if (typeof options.cls === "string") this.className = options.cls;
		for (const [key, value] of Object.entries(options)) {
			if (["text", "value", "placeholder", "title", "cls", "type"].includes(key)) continue;
			if (typeof value === "string" || typeof value === "boolean")
				this.setAttribute(key, String(value));
		}
	}
}

export class Plugin {
	app: unknown;
	manifest: unknown;
	testLoadedData: unknown = null;
	readonly testSavedData: unknown[] = [];
	readonly registeredViews = new Map<string, (leaf: unknown) => unknown>();
	readonly settingTabs: unknown[] = [];
	readonly commands: { id: string; callback: () => void }[] = [];
	readonly ribbons: (() => void)[] = [];

	constructor(app: unknown, manifest: unknown) {
		this.app = app;
		this.manifest = manifest;
	}

	loadData(): Promise<unknown> {
		return Promise.resolve(this.testLoadedData);
	}

	saveData(data: unknown): Promise<void> {
		this.testSavedData.push(JSON.parse(JSON.stringify(data)));
		return Promise.resolve();
	}

	registerView(type: string, creator: (leaf: unknown) => unknown): void {
		this.registeredViews.set(type, creator);
	}

	addSettingTab(tab: unknown): void {
		this.settingTabs.push(tab);
	}

	addCommand(command: { id: string; callback: () => void }): void {
		this.commands.push(command);
	}

	addRibbonIcon(_icon: string, _title: string, callback: () => void): void {
		this.ribbons.push(callback);
	}
}

export class WorkspaceLeaf {
	view?: unknown;
	app?: unknown;
}

export class ItemView {
	leaf: WorkspaceLeaf;
	app: unknown;
	containerEl: TestElement;
	contentEl: TestElement;

	constructor(leaf: WorkspaceLeaf) {
		this.leaf = leaf;
		this.app = leaf.app;
		this.containerEl = new TestElement("div");
		this.contentEl = this.containerEl.createDiv();
	}
}

export class PluginSettingTab {
	app: unknown;
	plugin: unknown;
	containerEl: TestElement;

	constructor(app: unknown, plugin: unknown) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = new TestElement("div");
	}
}

class DropdownComponent {
	readonly selectEl: TestElement;
	constructor(container: TestElement) {
		this.selectEl = container.createEl("select");
	}
	addOption(value: string, label: string): this {
		const option = this.selectEl.createEl("option", { text: label, value });
		if (!this.selectEl.value) this.selectEl.value = option.value;
		return this;
	}
	addOptions(options: Record<string, string>): this {
		for (const [value, label] of Object.entries(options)) this.addOption(value, label);
		return this;
	}
	setValue(value: string): this {
		this.selectEl.value = value;
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.selectEl.disabled = disabled;
		return this;
	}
	onChange(callback: (value: string) => void): this {
		this.selectEl.addEventListener("change", () => callback(this.selectEl.value));
		return this;
	}
}

class TextComponent {
	readonly inputEl: TestElement;
	constructor(container: TestElement) {
		this.inputEl = container.createEl("input");
	}
	setPlaceholder(value: string): this {
		this.inputEl.placeholder = value;
		return this;
	}
	setValue(value: string): this {
		this.inputEl.value = value;
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.inputEl.disabled = disabled;
		return this;
	}
	onChange(callback: (value: string) => void): this {
		this.inputEl.addEventListener("change", () => callback(this.inputEl.value));
		return this;
	}
}

export class Setting {
	readonly settingEl: TestElement;
	private readonly nameEl: TestElement;
	private readonly descEl: TestElement;
	private readonly controlEl: TestElement;

	constructor(container: HTMLElement) {
		this.settingEl = (container as unknown as TestElement).createDiv({ cls: "setting-item" });
		this.nameEl = this.settingEl.createDiv({ cls: "setting-item-name" });
		this.descEl = this.settingEl.createDiv({ cls: "setting-item-description" });
		this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
	}
	setName(name: string): this {
		this.nameEl.setText(name);
		return this;
	}
	setDesc(desc: string): this {
		this.descEl.setText(desc);
		return this;
	}
	addDropdown(callback: (component: DropdownComponent) => unknown): this {
		callback(new DropdownComponent(this.controlEl));
		return this;
	}
	addText(callback: (component: TextComponent) => unknown): this {
		callback(new TextComponent(this.controlEl));
		return this;
	}
}

export class App {}

export class Notice {
	static readonly messages: string[] = [];
	constructor(message: string) {
		Notice.messages.push(message);
	}
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}
