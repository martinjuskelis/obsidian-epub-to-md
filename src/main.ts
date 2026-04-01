import { Notice, Plugin, TFile, TFolder } from "obsidian";
import {
	DEFAULT_SETTINGS,
	EpubToMdSettingTab,
	type EpubToMdSettings,
} from "./settings";
import { convertEpub, type EpubConversionResult } from "./converter";

export default class EpubToMdPlugin extends Plugin {
	settings: EpubToMdSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "convert-epub-to-md",
			name: "Convert EPUB to Markdown",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "epub") return false;
				if (!checking) this.convertEpub(file);
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, abstractFile) => {
				if (!(abstractFile instanceof TFile)) return;
				if (abstractFile.extension !== "epub") return;
				menu.addItem((item) => {
					item.setTitle("Convert to Markdown")
						.setIcon("book-open")
						.onClick(() => this.convertEpub(abstractFile));
				});
			})
		);

		this.addSettingTab(new EpubToMdSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private converting = false;

	private async convertEpub(file: TFile) {
		if (this.converting) {
			new Notice("A conversion is already in progress.");
			return;
		}
		this.converting = true;

		const progressNotice = new Notice("Starting EPUB conversion...", 0);

		try {
			const data = await this.app.vault.readBinary(file);

			const result = await convertEpub(
				data,
				this.settings.assetsSubfolder,
				(msg) => progressNotice.setMessage(msg)
			);

			progressNotice.setMessage("Saving files...");
			await this.saveResult(file, result);

			progressNotice.hide();
			new Notice(
				`Converted "${result.metadata.title || file.basename}" — ${result.chapters.length} chapters.`,
				5000
			);
		} catch (err) {
			progressNotice.hide();
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`EPUB conversion failed: ${msg}`, 8000);
			console.error("epub-to-md: conversion error", err);
		} finally {
			this.converting = false;
		}
	}

	private async saveResult(epubFile: TFile, result: EpubConversionResult) {
		const { metadata, chapters, images } = result;
		const bookName = sanitizeFolderName(
			metadata.title || epubFile.basename
		);

		// Determine output folder
		let baseDir: string;
		if (this.settings.outputFolder) {
			baseDir = joinPath(this.settings.outputFolder, bookName);
		} else {
			const parentPath = epubFile.parent?.path ?? "";
			baseDir = joinPath(parentPath, bookName);
		}

		await this.ensureFolderRecursive(baseDir);

		// Save images
		const assetsDir = joinPath(baseDir, this.settings.assetsSubfolder);
		if (images.size > 0) {
			await this.ensureFolderRecursive(assetsDir);
			for (const [name, data] of images) {
				const imgPath = joinPath(assetsDir, name);
				await this.writeBinary(imgPath, data);
			}
		}

		// Save chapters
		const padWidth = String(chapters.length).length < 2 ? 2 : String(chapters.length).length;
		const chapterLinks: string[] = [];
		for (let i = 0; i < chapters.length; i++) {
			const chapter = chapters[i];
			const prefix = this.settings.numberChapters
				? `${String(i + 1).padStart(padWidth, "0")} `
				: "";
			const chapterFilename = `${prefix}${chapter.filename}.md`;
			const chapterPath = joinPath(baseDir, chapterFilename);

			await this.writeText(chapterPath, chapter.markdown);
			const displayName = sanitizeWikilink(chapter.title);
			chapterLinks.push(`${i + 1}. [[${chapterFilename.replace(".md", "")}|${displayName}]]`);
		}

		// Save index note
		const indexLines: string[] = [];

		if (this.settings.includeFrontmatter) {
			indexLines.push("---");
			if (metadata.title) indexLines.push(`title: "${escapeFrontmatter(metadata.title)}"`);
			if (metadata.author) indexLines.push(`author: "${escapeFrontmatter(metadata.author)}"`);
			if (metadata.language) indexLines.push(`language: ${metadata.language}`);
			indexLines.push("---");
			indexLines.push("");
		}

		indexLines.push(`# ${metadata.title || epubFile.basename}`);
		indexLines.push("");
		if (metadata.author) {
			indexLines.push(`**Author:** ${metadata.author}`);
			indexLines.push("");
		}
		if (metadata.description) {
			// Prefix every line with > for proper blockquote
			const descLines = metadata.description.split(/\r?\n/);
			indexLines.push(...descLines.map((l) => `> ${l}`));
			indexLines.push("");
		}
		indexLines.push("## Chapters");
		indexLines.push("");
		indexLines.push(...chapterLinks);
		indexLines.push("");

		const indexPath = joinPath(baseDir, `${bookName}.md`);
		await this.writeText(indexPath, indexLines.join("\n"));
	}

	private async ensureFolderRecursive(path: string) {
		if (this.app.vault.getAbstractFileByPath(path) instanceof TFolder) {
			return;
		}
		// Create parent folders first
		const parts = path.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (existing instanceof TFolder) continue;
			if (existing) continue; // a file occupies this path; skip
			await this.app.vault.createFolder(current);
		}
	}

	private async writeText(path: string, content: string) {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(path, content);
		}
	}

	private async writeBinary(path: string, data: ArrayBuffer) {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modifyBinary(existing, data);
		} else {
			await this.app.vault.createBinary(path, data);
		}
	}
}

function joinPath(dir: string, name: string): string {
	return dir ? `${dir}/${name}` : name;
}

function sanitizeFolderName(name: string): string {
	let clean = name
		.replace(/[\\/:*?"<>|]/g, "")
		.replace(/^\.*/, "")
		.replace(/\s+/g, " ")
		.trim()
		.substring(0, 100);
	return clean || "Untitled";
}

function sanitizeWikilink(text: string): string {
	return text.replace(/[|\[\]]/g, "");
}

function escapeFrontmatter(s: string): string {
	return s
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "");
}
