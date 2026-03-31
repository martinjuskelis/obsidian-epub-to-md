import JSZip from "jszip";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export interface EpubMetadata {
	title: string;
	author: string;
	language: string;
	description: string;
}

export interface EpubChapter {
	title: string;
	filename: string;
	markdown: string;
}

export interface EpubConversionResult {
	metadata: EpubMetadata;
	chapters: EpubChapter[];
	images: Map<string, ArrayBuffer>;
}

export async function convertEpub(
	data: ArrayBuffer,
	onProgress?: (msg: string) => void
): Promise<EpubConversionResult> {
	const report = onProgress ?? (() => {});

	report("Extracting EPUB archive...");
	const zip = await JSZip.loadAsync(data);

	// 1. Find OPF via container.xml
	report("Reading EPUB structure...");
	const containerXml = await readZipText(zip, "META-INF/container.xml");
	if (!containerXml) throw new Error("Invalid EPUB: missing container.xml");

	const parser = new DOMParser();
	const containerDoc = parser.parseFromString(containerXml, "text/xml");
	const rootfileEl = containerDoc.querySelector("rootfile");
	const opfPath = rootfileEl?.getAttribute("full-path");
	if (!opfPath) throw new Error("Invalid EPUB: no rootfile path found");

	// 2. Parse OPF
	const opfXml = await readZipText(zip, opfPath);
	if (!opfXml) throw new Error("Invalid EPUB: missing OPF file");

	const opfDoc = parser.parseFromString(opfXml, "text/xml");
	const opfDir = opfPath.includes("/")
		? opfPath.substring(0, opfPath.lastIndexOf("/") + 1)
		: "";

	// 3. Extract metadata
	const metadata = extractMetadata(opfDoc);
	report(`Converting: ${metadata.title || "Untitled"}`);

	// 4. Build manifest map (id -> {href, mediaType})
	const manifest = new Map<string, { href: string; mediaType: string }>();
	const manifestEls = opfDoc.querySelectorAll("manifest > item");
	for (const el of Array.from(manifestEls)) {
		const id = el.getAttribute("id");
		const href = el.getAttribute("href");
		const mediaType = el.getAttribute("media-type") || "";
		if (id && href) manifest.set(id, { href, mediaType });
	}

	// 5. Get spine order
	const spine: string[] = [];
	const spineEls = opfDoc.querySelectorAll("spine > itemref");
	for (const el of Array.from(spineEls)) {
		const idref = el.getAttribute("idref");
		if (idref) spine.push(idref);
	}

	// 6. Collect image files (full zip path -> output filename)
	const imageMap = new Map<string, { zipPath: string; outputName: string }>();
	const usedImageNames = new Set<string>();
	for (const [, item] of manifest) {
		if (item.mediaType.startsWith("image/")) {
			const zipPath = opfDir + item.href;
			let outputName = item.href.includes("/")
				? item.href.substring(item.href.lastIndexOf("/") + 1)
				: item.href;
			// Deduplicate names
			if (usedImageNames.has(outputName)) {
				const ext = outputName.includes(".")
					? outputName.substring(outputName.lastIndexOf("."))
					: "";
				const base = outputName.includes(".")
					? outputName.substring(0, outputName.lastIndexOf("."))
					: outputName;
				let i = 2;
				while (usedImageNames.has(`${base}_${i}${ext}`)) i++;
				outputName = `${base}_${i}${ext}`;
			}
			usedImageNames.add(outputName);
			imageMap.set(zipPath, { zipPath, outputName });
		}
	}

	// 7. Set up Turndown
	const turndown = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		emDelimiter: "*",
	});
	turndown.use(gfm);

	// Remove <style> and <script> tags
	turndown.remove(["style", "script"]);

	// 8. Convert each spine item
	const chapters: EpubChapter[] = [];
	for (let i = 0; i < spine.length; i++) {
		const itemRef = spine[i];
		const item = manifest.get(itemRef);
		if (!item) continue;

		report(`Converting chapter ${i + 1} of ${spine.length}...`);

		const filePath = opfDir + item.href;
		const chapterDir = filePath.includes("/")
			? filePath.substring(0, filePath.lastIndexOf("/") + 1)
			: "";

		const content = await readZipText(zip, filePath);
		if (!content) continue;

		const doc = parser.parseFromString(content, "application/xhtml+xml");
		const body = doc.querySelector("body");
		if (!body) continue;

		// Rewrite image src attributes before turndown conversion
		const imgs = body.querySelectorAll("img");
		for (const img of Array.from(imgs)) {
			const src = img.getAttribute("src");
			if (!src) continue;
			const resolvedPath = resolvePath(chapterDir, src);
			const imageInfo = imageMap.get(resolvedPath);
			if (imageInfo) {
				img.setAttribute("src", `assets/${imageInfo.outputName}`);
			}
		}

		// Also handle SVG image elements
		const svgImages = body.querySelectorAll("image");
		for (const img of Array.from(svgImages)) {
			const href =
				img.getAttribute("xlink:href") || img.getAttribute("href");
			if (!href) continue;
			const resolvedPath = resolvePath(chapterDir, href);
			const imageInfo = imageMap.get(resolvedPath);
			if (imageInfo) {
				// Replace SVG image with a regular img for turndown
				const replacement = doc.createElement("img");
				replacement.setAttribute(
					"src",
					`assets/${imageInfo.outputName}`
				);
				replacement.setAttribute("alt", "");
				img.parentNode?.replaceChild(replacement, img);
			}
		}

		// Extract chapter title from first heading
		const titleEl = body.querySelector("h1, h2, h3");
		const title =
			titleEl?.textContent?.trim() ||
			item.href.replace(/\.x?html?$/i, "").replace(/[_-]/g, " ");

		const markdown = turndown.turndown(body.innerHTML);

		// Skip empty chapters (e.g., blank pages)
		if (markdown.trim().length === 0) continue;

		chapters.push({ title, filename: sanitizeFilename(title), markdown });
	}

	// 9. Extract image data
	report("Extracting images...");
	const images = new Map<string, ArrayBuffer>();
	for (const [, info] of imageMap) {
		const imgData = await zip.file(info.zipPath)?.async("arraybuffer");
		if (imgData) {
			images.set(info.outputName, imgData);
		}
	}

	return { metadata, chapters, images };
}

function extractMetadata(opfDoc: Document): EpubMetadata {
	const getText = (tag: string): string => {
		// Try with namespace prefix and without
		const el =
			opfDoc.querySelector(`metadata > ${tag}`) ||
			opfDoc.querySelector(`metadata > *|${tag}`) ||
			opfDoc.querySelector(tag);
		return el?.textContent?.trim() || "";
	};

	return {
		title: getText("title") || getText("dc\\:title"),
		author: getText("creator") || getText("dc\\:creator"),
		language: getText("language") || getText("dc\\:language"),
		description: getText("description") || getText("dc\\:description"),
	};
}

function resolvePath(base: string, relative: string): string {
	if (!relative.startsWith(".")) {
		// Absolute path within the EPUB
		if (relative.startsWith("/")) return relative.substring(1);
		return base + relative;
	}

	const baseParts = base.split("/").filter(Boolean);
	const relParts = relative.split("/");

	for (const part of relParts) {
		if (part === "..") {
			baseParts.pop();
		} else if (part !== ".") {
			baseParts.push(part);
		}
	}

	return baseParts.join("/");
}

function sanitizeFilename(name: string): string {
	return name
		.replace(/[\\/:*?"<>|]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.substring(0, 100);
}

async function readZipText(
	zip: JSZip,
	path: string
): Promise<string | null> {
	const file = zip.file(path);
	if (!file) return null;
	return file.async("string");
}
