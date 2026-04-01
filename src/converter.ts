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
	assetsSubfolder: string,
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
	assertNoParseerror(containerDoc, "container.xml");

	const rootfileEl = containerDoc.querySelector("rootfile");
	const opfPath = rootfileEl?.getAttribute("full-path")?.trim();
	if (!opfPath) throw new Error("Invalid EPUB: no rootfile path found");

	// 2. Parse OPF
	const opfXml = await readZipText(zip, opfPath);
	if (!opfXml) throw new Error("Invalid EPUB: missing OPF file");

	const opfDoc = parser.parseFromString(opfXml, "text/xml");
	assertNoParseerror(opfDoc, "OPF");

	const opfDir = opfPath.includes("/")
		? opfPath.substring(0, opfPath.lastIndexOf("/") + 1)
		: "";

	// 3. Extract metadata
	const metadata = extractMetadata(opfDoc);
	report(`Converting: ${metadata.title || "Untitled"}`);

	// 4. Build manifest map (id -> {href, mediaType})
	// Decode URL-encoded hrefs so they match JSZip entry paths
	const manifest = new Map<string, { href: string; mediaType: string }>();
	const manifestEls = opfDoc.querySelectorAll("manifest > item");
	for (const el of Array.from(manifestEls)) {
		const id = el.getAttribute("id");
		const rawHref = el.getAttribute("href");
		const mediaType = el.getAttribute("media-type") || "";
		if (id && rawHref) {
			const href = decodeURIComponent(rawHref);
			manifest.set(id, { href, mediaType });
		}
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
	turndown.remove(["style", "script"]);

	// 8. Convert each spine item, deduplicating chapter filenames
	const chapters: EpubChapter[] = [];
	const usedChapterNames = new Set<string>();

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
			const resolvedPath = resolvePath(chapterDir, decodeURIComponent(src));
			const imageInfo = imageMap.get(resolvedPath);
			if (imageInfo) {
				img.setAttribute("src", `${assetsSubfolder}/${imageInfo.outputName}`);
			}
		}

		// Also handle SVG image elements
		const svgImages = body.querySelectorAll("image");
		for (const img of Array.from(svgImages)) {
			const href =
				img.getAttribute("xlink:href") || img.getAttribute("href");
			if (!href) continue;
			const resolvedPath = resolvePath(chapterDir, decodeURIComponent(href));
			const imageInfo = imageMap.get(resolvedPath);
			if (imageInfo) {
				const replacement = doc.createElement("img");
				replacement.setAttribute(
					"src",
					`${assetsSubfolder}/${imageInfo.outputName}`
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

		// Deduplicate chapter filenames
		let chapterName = sanitizeFilename(title);
		if (usedChapterNames.has(chapterName.toLowerCase())) {
			let suffix = 2;
			while (usedChapterNames.has(`${chapterName} (${suffix})`.toLowerCase())) suffix++;
			chapterName = `${chapterName} (${suffix})`;
		}
		usedChapterNames.add(chapterName.toLowerCase());

		chapters.push({ title, filename: chapterName, markdown });
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

function assertNoParseerror(doc: Document, label: string): void {
	const err = doc.querySelector("parsererror");
	if (err) {
		throw new Error(`Invalid EPUB: malformed XML in ${label}`);
	}
}

function resolvePath(base: string, relative: string): string {
	// Always normalize the combined path to handle .. segments
	let parts: string[];
	if (relative.startsWith("/")) {
		parts = relative.substring(1).split("/");
	} else {
		parts = (base + relative).split("/");
	}

	const resolved: string[] = [];
	for (const part of parts) {
		if (part === ".." && resolved.length > 0) {
			resolved.pop();
		} else if (part !== "." && part !== "") {
			resolved.push(part);
		}
	}

	return resolved.join("/");
}

function sanitizeFilename(name: string): string {
	let clean = name
		.replace(/[\\/:*?"<>|]/g, "")
		.replace(/^\.*/, "") // strip leading dots
		.replace(/\s+/g, " ")
		.trim()
		.substring(0, 100);
	return clean || "Untitled";
}

async function readZipText(
	zip: JSZip,
	path: string
): Promise<string | null> {
	// Try exact path, then URL-decoded version
	let file = zip.file(path);
	if (!file) file = zip.file(decodeURIComponent(path));
	if (!file) return null;
	return file.async("string");
}
