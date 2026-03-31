import { App, PluginSettingTab, Setting } from "obsidian";
import type EpubToMdPlugin from "./main";

export interface EpubToMdSettings {
	outputFolder: string;
	numberChapters: boolean;
	assetsSubfolder: string;
	includeFrontmatter: boolean;
}

export const DEFAULT_SETTINGS: EpubToMdSettings = {
	outputFolder: "",
	numberChapters: true,
	assetsSubfolder: "assets",
	includeFrontmatter: true,
};

export class EpubToMdSettingTab extends PluginSettingTab {
	plugin: EpubToMdPlugin;

	constructor(app: App, plugin: EpubToMdPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Output folder")
			.setDesc(
				"Folder where converted books are saved. Leave empty to place next to the EPUB file."
			)
			.addText((text) =>
				text
					.setPlaceholder("e.g. Books")
					.setValue(this.plugin.settings.outputFolder)
					.onChange(async (value) => {
						this.plugin.settings.outputFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Number chapters")
			.setDesc("Prefix chapter filenames with sequential numbers (01, 02, ...).")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.numberChapters)
					.onChange(async (value) => {
						this.plugin.settings.numberChapters = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Assets subfolder")
			.setDesc("Subfolder name for extracted images within each book folder.")
			.addText((text) =>
				text
					.setPlaceholder("assets")
					.setValue(this.plugin.settings.assetsSubfolder)
					.onChange(async (value) => {
						this.plugin.settings.assetsSubfolder =
							value.trim() || "assets";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Include frontmatter")
			.setDesc("Add YAML frontmatter with book metadata to the index note.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeFrontmatter)
					.onChange(async (value) => {
						this.plugin.settings.includeFrontmatter = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
