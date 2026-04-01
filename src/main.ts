import { Notice, Plugin, TFile, TFolder } from "obsidian";
import {
	DEFAULT_SETTINGS,
	EpubToMdSettingTab,
	type EpubToMdSettings,
} from "./settings";
import {
	convertEpub,
	type EpubChapter,
	type EpubConversionResult,
	type TocEntry,
} from "./converter";

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
		const { metadata, chapters, images, coverImage, tocTree } = result;
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
				await this.writeBinary(joinPath(assetsDir, name), data);
			}
		}

		// Compute all chapter filenames first (needed for prev/next links)
		const padWidth = Math.max(2, String(chapters.length).length);
		const indexFilename = this.settings.numberChapters
			? `${"0".repeat(padWidth)} - ${bookName}`
			: bookName;
		const chapterFiles: ChapterFileInfo[] = [];

		for (let i = 0; i < chapters.length; i++) {
			const ch = chapters[i];
			const prefix = this.settings.numberChapters
				? `${String(i + 1).padStart(padWidth, "0")} - `
				: "";
			const filename = `${prefix}${ch.filename}`;
			const displayName = sanitizeWikilink(ch.title);
			chapterFiles.push({ filename, displayName, chapter: ch });
		}

		// Save chapter files with frontmatter and navigation
		for (let i = 0; i < chapterFiles.length; i++) {
			const { filename, chapter } = chapterFiles[i];
			const lines: string[] = [];

			// Chapter frontmatter
			if (this.settings.includeFrontmatter) {
				lines.push("---");
				lines.push(
					`title: "${escapeFrontmatter(chapter.title)}"`
				);
				lines.push(`parent: "[[${indexFilename}]]"`);
				if (chapter.contentType !== "chapter") {
					lines.push(`type: ${chapter.contentType}`);
				}
				lines.push("---");
				lines.push("");
			}

			lines.push(chapter.markdown);

			// Navigation footer
			const prev = i > 0 ? chapterFiles[i - 1] : null;
			const next =
				i < chapterFiles.length - 1 ? chapterFiles[i + 1] : null;
			if (prev || next) {
				lines.push("");
				lines.push("---");
				const parts: string[] = [];
				if (prev)
					parts.push(
						`prev: [[${prev.filename}|${prev.displayName}]]`
					);
				if (next)
					parts.push(
						`next: [[${next.filename}|${next.displayName}]]`
					);
				lines.push(parts.join(" | "));
			}

			await this.writeText(
				joinPath(baseDir, `${filename}.md`),
				lines.join("\n")
			);
		}

		// Build index note
		const indexLines: string[] = [];

		if (this.settings.includeFrontmatter) {
			indexLines.push("---");
			if (metadata.title)
				indexLines.push(
					`title: "${escapeFrontmatter(metadata.title)}"`
				);
			if (metadata.author)
				indexLines.push(
					`author: "${escapeFrontmatter(metadata.author)}"`
				);
			if (metadata.language)
				indexLines.push(`language: ${metadata.language}`);
			indexLines.push("type: book");
			indexLines.push("---");
			indexLines.push("");
		}

		indexLines.push(`# ${metadata.title || epubFile.basename}`);
		indexLines.push("");

		if (metadata.author) {
			indexLines.push(`**Author:** ${metadata.author}`);
			indexLines.push("");
		}

		// Cover image embed
		if (coverImage) {
			indexLines.push(
				`![[${this.settings.assetsSubfolder}/${coverImage}]]`
			);
			indexLines.push("");
		}

		if (metadata.description) {
			const descLines = metadata.description.split(/\r?\n/);
			indexLines.push(...descLines.map((l) => `> ${l}`));
			indexLines.push("");
		}

		// Hierarchical table of contents
		indexLines.push("## Table of Contents");
		indexLines.push("");

		if (tocTree.length > 0) {
			const titleLookup = new Map<string, ChapterFileInfo[]>();
			for (const cf of chapterFiles) {
				const key = cf.chapter.title.toLowerCase().trim();
				if (!titleLookup.has(key)) titleLookup.set(key, []);
				titleLookup.get(key)!.push(cf);
			}

			indexLines.push(
				...renderTocTree(tocTree, titleLookup, 0)
			);

			// Append any chapters not matched by the TOC tree
			for (const [, remaining] of titleLookup) {
				for (const cf of remaining) {
					indexLines.push(
						`- [[${cf.filename}|${cf.displayName}]]`
					);
				}
			}
		} else {
			// No TOC tree — flat list
			for (const cf of chapterFiles) {
				indexLines.push(
					`- [[${cf.filename}|${cf.displayName}]]`
				);
			}
		}

		indexLines.push("");

		await this.writeText(
			joinPath(baseDir, `${indexFilename}.md`),
			indexLines.join("\n")
		);
	}

	private async ensureFolderRecursive(path: string) {
		if (
			this.app.vault.getAbstractFileByPath(path) instanceof TFolder
		) {
			return;
		}
		const parts = path.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing =
				this.app.vault.getAbstractFileByPath(current);
			if (existing instanceof TFolder) continue;
			if (existing) continue;
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

// ─── Hierarchical TOC rendering ─────────────────────────────────────

interface ChapterFileInfo {
	filename: string;
	displayName: string;
	chapter: EpubChapter;
}

function renderTocTree(
	entries: TocEntry[],
	lookup: Map<string, ChapterFileInfo[]>,
	depth: number
): string[] {
	const lines: string[] = [];
	for (const entry of entries) {
		const indent = "  ".repeat(depth);
		const key = entry.title.toLowerCase().trim();
		const matches = lookup.get(key);

		let rendered = false;
		if (matches && matches.length > 0) {
			// Consume first match for this title
			const cf = matches.shift()!;
			if (matches.length === 0) lookup.delete(key);
			lines.push(
				`${indent}- [[${cf.filename}|${cf.displayName}]]`
			);
			rendered = true;
		} else if (!entry.href) {
			// Label-only entry (e.g., "Part I")
			lines.push(
				`${indent}- **${sanitizeWikilink(entry.title)}**`
			);
			rendered = true;
		}

		if (entry.children.length > 0) {
			// Only indent children if this entry was actually rendered;
			// otherwise keep same depth so children don't become orphaned
			lines.push(
				...renderTocTree(
					entry.children,
					lookup,
					rendered ? depth + 1 : depth
				)
			);
		}
	}
	return lines;
}

// ─── Helpers ────────────────────────────────────────────────────────

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
