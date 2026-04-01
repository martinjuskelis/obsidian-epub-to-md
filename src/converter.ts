import JSZip from "jszip";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

// ─── Types ──────────────────────────────────────────────────────────

export interface EpubMetadata {
	title: string;
	author: string;
	language: string;
	description: string;
}

export interface TocEntry {
	title: string;
	href: string; // file path relative to OPF dir (no fragment)
	fragment: string; // anchor ID (empty string if none)
	depth: number; // nesting level (0 = top)
	children: TocEntry[];
}

export interface EpubChapter {
	title: string;
	filename: string;
	markdown: string;
	depth: number;
	contentType: "frontmatter" | "bodymatter" | "backmatter" | "chapter";
}

export interface EpubConversionResult {
	metadata: EpubMetadata;
	chapters: EpubChapter[];
	images: Map<string, ArrayBuffer>;
	coverImage?: string;
	tocTree: TocEntry[];
}

// ─── Content-type classification ────────────────────────────────────

const FRONTMATTER_TYPES = new Set([
	"titlepage",
	"halftitlepage",
	"copyright-page",
	"dedication",
	"foreword",
	"preface",
	"prologue",
	"acknowledgments",
	"epigraph",
	"frontmatter",
	"cover",
]);
const BACKMATTER_TYPES = new Set([
	"appendix",
	"glossary",
	"bibliography",
	"index",
	"colophon",
	"afterword",
	"epilogue",
	"backmatter",
	"endnotes",
]);
const BODYMATTER_TYPES = new Set([
	"chapter",
	"part",
	"division",
	"volume",
	"bodymatter",
]);

function classifyContent(epubTypes: string[]): EpubChapter["contentType"] {
	for (const t of epubTypes) {
		if (FRONTMATTER_TYPES.has(t)) return "frontmatter";
		if (BACKMATTER_TYPES.has(t)) return "backmatter";
		if (BODYMATTER_TYPES.has(t)) return "bodymatter";
	}
	return "chapter";
}

// ─── Main conversion ────────────────────────────────────────────────

export async function convertEpub(
	data: ArrayBuffer,
	assetsSubfolder: string,
	onProgress?: (msg: string) => void
): Promise<EpubConversionResult> {
	const report = onProgress ?? (() => {});
	const parser = new DOMParser();

	// 1. Extract ZIP
	report("Extracting EPUB archive...");
	const zip = await JSZip.loadAsync(data);

	// 2. Find OPF via container.xml
	report("Reading EPUB structure...");
	const containerXml = await readZipText(zip, "META-INF/container.xml");
	if (!containerXml) throw new Error("Invalid EPUB: missing container.xml");
	const containerDoc = parser.parseFromString(containerXml, "text/xml");
	assertNoParseError(containerDoc, "container.xml");
	const opfPath = containerDoc
		.querySelector("rootfile")
		?.getAttribute("full-path")
		?.trim();
	if (!opfPath) throw new Error("Invalid EPUB: no rootfile path found");

	// 3. Parse OPF
	const opfXml = await readZipText(zip, opfPath);
	if (!opfXml) throw new Error("Invalid EPUB: missing OPF file");
	const opfDoc = parser.parseFromString(opfXml, "text/xml");
	assertNoParseError(opfDoc, "OPF");
	const opfDir = opfPath.includes("/")
		? opfPath.substring(0, opfPath.lastIndexOf("/") + 1)
		: "";

	// 4. Metadata
	const metadata = extractMetadata(opfDoc);
	report(`Converting: ${metadata.title || "Untitled"}`);

	// 5. Build manifest & spine
	const manifest = buildManifest(opfDoc);
	const spine = buildSpine(opfDoc);

	// 6. Cover image
	const coverHref = findCoverImage(opfDoc, manifest);

	// 7. Parse TOC (prefer EPUB 3 nav, fall back to NCX)
	report("Parsing table of contents...");
	const tocTree = await parseToc(zip, opfDir, opfDoc, manifest, parser);
	const tocByHref = buildTocIndex(tocTree);

	// 8. Identify documents to skip in spine (nav, TOC pages, cover pages)
	const skipIds = new Set<string>();
	for (const [id, item] of manifest) {
		if (item.properties.split(/\s+/).includes("nav")) skipIds.add(id);
	}
	// EPUB 2 guide: skip TOC and cover references
	const guideSkipHrefs = new Set<string>();
	for (const ref of Array.from(opfDoc.querySelectorAll("guide > reference"))) {
		const type = (ref.getAttribute("type") || "").toLowerCase();
		if (type === "toc" || type === "cover") {
			const rawHref = ref.getAttribute("href");
			if (rawHref) {
				const { file } = splitHref(decodeURIComponent(rawHref));
				guideSkipHrefs.add(file);
			}
		}
	}
	// Map guide hrefs to manifest IDs for skipping
	for (const [id, item] of manifest) {
		if (guideSkipHrefs.has(item.href)) skipIds.add(id);
	}

	// 9. Collect images
	const imageMap = collectImages(manifest, opfDir);

	// 10. Turndown with footnote rules
	const turndown = createTurndownService();

	// 11. Convert spine items
	const chapters: EpubChapter[] = [];
	const usedNames = new Set<string>();

	for (let i = 0; i < spine.length; i++) {
		const idref = spine[i];
		if (skipIds.has(idref)) continue;
		const item = manifest.get(idref);
		if (!item) continue;

		report(`Converting ${i + 1} of ${spine.length}...`);

		const filePath = opfDir + item.href;
		const chapterDir = filePath.includes("/")
			? filePath.substring(0, filePath.lastIndexOf("/") + 1)
			: "";
		const content = await readZipText(zip, filePath);
		if (!content) continue;

		const doc = parser.parseFromString(content, "application/xhtml+xml");
		const body = doc.querySelector("body");
		if (!body) continue;

		const bodyTypes = getEpubTypes(body);

		// Skip pages that are TOC or cover by epub:type
		if (bodyTypes.includes("toc") || bodyTypes.includes("cover")) continue;

		rewriteImages(body, chapterDir, imageMap, assetsSubfolder);

		const tocEntries = tocByHref.get(item.href) || [];
		const fragmentEntries = tocEntries.filter((e) => e.fragment);

		if (fragmentEntries.length > 0) {
			// Fragment splitting: multiple TOC entries within one XHTML file
			const segments = splitAtFragments(body, fragmentEntries);

			if (segments.preamble) {
				const noFrag = tocEntries.find((e) => !e.fragment);
				const md = turndown.turndown(segments.preamble);
				if (md.trim()) {
					const title =
						noFrag?.title ||
						extractTitleFromHtml(segments.preamble, item.href);
					pushChapter(
						chapters,
						usedNames,
						title,
						md,
						noFrag?.depth ?? 0,
						classifyContent(bodyTypes)
					);
				}
			}

			for (const seg of segments.sections) {
				const md = turndown.turndown(seg.html);
				if (md.trim()) {
					pushChapter(
						chapters,
						usedNames,
						seg.tocEntry.title,
						md,
						seg.tocEntry.depth,
						classifyContent(bodyTypes)
					);
				}
			}
		} else if (tocEntries.length > 0) {
			// Single TOC entry for this file — use its title
			const entry = tocEntries[0];
			const md = turndown.turndown(body.innerHTML);
			if (md.trim()) {
				pushChapter(
					chapters,
					usedNames,
					entry.title,
					md,
					entry.depth,
					classifyContent(bodyTypes)
				);
			}
		} else {
			// No TOC entry — fallback to heading extraction
			const titleEl = body.querySelector("h1, h2, h3");
			const title =
				titleEl?.textContent?.trim() ||
				item.href
					.replace(/\.x?html?$/i, "")
					.replace(/[_-]/g, " ");
			const md = turndown.turndown(body.innerHTML);
			if (md.trim()) {
				pushChapter(
					chapters,
					usedNames,
					title,
					md,
					0,
					classifyContent(bodyTypes)
				);
			}
		}
	}

	// 12. Extract image data
	report("Extracting images...");
	const images = new Map<string, ArrayBuffer>();
	for (const [, info] of imageMap) {
		const imgData = await zip.file(info.zipPath)?.async("arraybuffer");
		if (imgData) images.set(info.outputName, imgData);
	}

	// Resolve cover output name
	let coverImage: string | undefined;
	if (coverHref) {
		const coverInfo = imageMap.get(opfDir + coverHref);
		if (coverInfo) coverImage = coverInfo.outputName;
	}

	return { metadata, chapters, images, coverImage, tocTree };
}

// ─── Manifest & Spine ───────────────────────────────────────────────

interface ManifestItem {
	href: string;
	mediaType: string;
	properties: string;
}

function buildManifest(opfDoc: Document): Map<string, ManifestItem> {
	const manifest = new Map<string, ManifestItem>();
	for (const el of Array.from(
		opfDoc.querySelectorAll("manifest > item")
	)) {
		const id = el.getAttribute("id");
		const rawHref = el.getAttribute("href");
		const mediaType = el.getAttribute("media-type") || "";
		const properties = el.getAttribute("properties") || "";
		if (id && rawHref) {
			manifest.set(id, {
				href: decodeURIComponent(rawHref),
				mediaType,
				properties,
			});
		}
	}
	return manifest;
}

function buildSpine(opfDoc: Document): string[] {
	const spine: string[] = [];
	for (const el of Array.from(
		opfDoc.querySelectorAll("spine > itemref")
	)) {
		const idref = el.getAttribute("idref");
		if (idref) spine.push(idref);
	}
	return spine;
}

// ─── Metadata ───────────────────────────────────────────────────────

function extractMetadata(opfDoc: Document): EpubMetadata {
	const get = (tag: string): string => {
		const el =
			opfDoc.querySelector(`metadata > ${tag}`) ||
			opfDoc.querySelector(`metadata > *|${tag}`) ||
			opfDoc.querySelector(tag);
		return el?.textContent?.trim() || "";
	};
	return {
		title: get("title") || get("dc\\:title"),
		author: get("creator") || get("dc\\:creator"),
		language: get("language") || get("dc\\:language"),
		description: get("description") || get("dc\\:description"),
	};
}

// ─── Cover image ────────────────────────────────────────────────────

function findCoverImage(
	opfDoc: Document,
	manifest: Map<string, ManifestItem>
): string | null {
	// EPUB 3: properties="cover-image"
	for (const [, item] of manifest) {
		if (item.properties.split(/\s+/).includes("cover-image"))
			return item.href;
	}
	// EPUB 2: <meta name="cover" content="image-id"/>
	for (const meta of Array.from(
		opfDoc.querySelectorAll("metadata > meta")
	)) {
		if (meta.getAttribute("name") === "cover") {
			const id = meta.getAttribute("content");
			if (id) {
				const item = manifest.get(id);
				if (item?.mediaType.startsWith("image/")) return item.href;
			}
		}
	}
	return null;
}

// ─── Image collection & rewriting ───────────────────────────────────

interface ImageInfo {
	zipPath: string;
	outputName: string;
}

function collectImages(
	manifest: Map<string, ManifestItem>,
	opfDir: string
): Map<string, ImageInfo> {
	const imageMap = new Map<string, ImageInfo>();
	const usedNames = new Set<string>();
	for (const [, item] of manifest) {
		if (!item.mediaType.startsWith("image/")) continue;
		const zipPath = opfDir + item.href;
		let name = item.href.includes("/")
			? item.href.substring(item.href.lastIndexOf("/") + 1)
			: item.href;
		if (usedNames.has(name)) {
			const ext = name.includes(".")
				? name.substring(name.lastIndexOf("."))
				: "";
			const base = name.includes(".")
				? name.substring(0, name.lastIndexOf("."))
				: name;
			let n = 2;
			while (usedNames.has(`${base}_${n}${ext}`)) n++;
			name = `${base}_${n}${ext}`;
		}
		usedNames.add(name);
		imageMap.set(zipPath, { zipPath, outputName: name });
	}
	return imageMap;
}

function rewriteImages(
	body: Element,
	chapterDir: string,
	imageMap: Map<string, ImageInfo>,
	assetsSubfolder: string
): void {
	for (const img of Array.from(body.querySelectorAll("img"))) {
		const src = img.getAttribute("src");
		if (!src) continue;
		const resolved = resolvePath(chapterDir, decodeURIComponent(src));
		const info = imageMap.get(resolved);
		if (info)
			img.setAttribute("src", `${assetsSubfolder}/${info.outputName}`);
	}
	// SVG <image> elements
	for (const img of Array.from(body.querySelectorAll("image"))) {
		const href =
			img.getAttribute("xlink:href") || img.getAttribute("href");
		if (!href) continue;
		const resolved = resolvePath(chapterDir, decodeURIComponent(href));
		const info = imageMap.get(resolved);
		if (info) {
			const replacement = img.ownerDocument.createElement("img");
			replacement.setAttribute(
				"src",
				`${assetsSubfolder}/${info.outputName}`
			);
			replacement.setAttribute("alt", "");
			img.parentNode?.replaceChild(replacement, img);
		}
	}
}

// ─── TOC parsing ────────────────────────────────────────────────────

async function parseToc(
	zip: JSZip,
	opfDir: string,
	opfDoc: Document,
	manifest: Map<string, ManifestItem>,
	parser: DOMParser
): Promise<TocEntry[]> {
	// EPUB 3 nav first
	const nav = await parseNavDocument(zip, opfDir, manifest, parser);
	if (nav.length > 0) return nav;
	// EPUB 2 NCX fallback
	return parseNcx(zip, opfDir, opfDoc, manifest, parser);
}

async function parseNavDocument(
	zip: JSZip,
	opfDir: string,
	manifest: Map<string, ManifestItem>,
	parser: DOMParser
): Promise<TocEntry[]> {
	let navHref: string | null = null;
	for (const [, item] of manifest) {
		if (item.properties.split(/\s+/).includes("nav")) {
			navHref = item.href;
			break;
		}
	}
	if (!navHref) return [];

	const navXml = await readZipText(zip, opfDir + navHref);
	if (!navXml) return [];

	const navDir = navHref.includes("/")
		? navHref.substring(0, navHref.lastIndexOf("/") + 1)
		: "";
	const doc = parser.parseFromString(navXml, "application/xhtml+xml");

	// Find TOC nav element (epub:type="toc")
	let tocNav: Element | null = null;
	for (const nav of Array.from(doc.querySelectorAll("nav"))) {
		const et =
			nav.getAttribute("epub:type") ||
			nav.getAttributeNS(
				"http://www.idpf.org/2007/ops",
				"type"
			) ||
			"";
		if (et.includes("toc")) {
			tocNav = nav;
			break;
		}
	}
	if (!tocNav) tocNav = doc.querySelector("nav");
	if (!tocNav) return [];

	const topOl = tocNav.querySelector("ol");
	if (!topOl) return [];

	return parseNavOl(topOl, 0, navDir);
}

function parseNavOl(
	ol: Element,
	depth: number,
	navDir: string
): TocEntry[] {
	const entries: TocEntry[] = [];
	for (const li of Array.from(ol.children)) {
		if (li.localName !== "li") continue;

		const a = directChild(li, "a");
		const nestedOl = directChild(li, "ol");
		const children = nestedOl
			? parseNavOl(nestedOl, depth + 1, navDir)
			: [];

		if (a) {
			const title = (a.textContent || "").trim();
			const rawHref = decodeURIComponent(
				a.getAttribute("href") || ""
			);
			const { file, fragment } = splitHref(rawHref);
			const href = file ? resolvePath(navDir, file) : "";
			if (title) {
				entries.push({ title, href, fragment, depth, children });
			}
		} else {
			// Span-only label (e.g., "Part I") — keep as grouping node
			const span = directChild(li, "span");
			if (span && children.length > 0) {
				const title = (span.textContent || "").trim();
				if (title) {
					entries.push({
						title,
						href: "",
						fragment: "",
						depth,
						children,
					});
				}
			} else {
				// Hoist children
				entries.push(...children);
			}
		}
	}
	return entries;
}

async function parseNcx(
	zip: JSZip,
	opfDir: string,
	opfDoc: Document,
	manifest: Map<string, ManifestItem>,
	parser: DOMParser
): Promise<TocEntry[]> {
	let ncxHref: string | null = null;
	// From spine toc attribute
	const tocId = opfDoc.querySelector("spine")?.getAttribute("toc");
	if (tocId) {
		const item = manifest.get(tocId);
		if (item) ncxHref = item.href;
	}
	// Or by media type
	if (!ncxHref) {
		for (const [, item] of manifest) {
			if (item.mediaType === "application/x-dtbncx+xml") {
				ncxHref = item.href;
				break;
			}
		}
	}
	if (!ncxHref) return [];

	const ncxXml = await readZipText(zip, opfDir + ncxHref);
	if (!ncxXml) return [];

	const ncxDir = ncxHref.includes("/")
		? ncxHref.substring(0, ncxHref.lastIndexOf("/") + 1)
		: "";
	const doc = parser.parseFromString(ncxXml, "text/xml");
	const navMap = doc.querySelector("navMap");
	if (!navMap) return [];

	return parseNavPoints(navMap, 0, ncxDir);
}

function parseNavPoints(
	parent: Element,
	depth: number,
	ncxDir: string
): TocEntry[] {
	const entries: TocEntry[] = [];
	for (const child of Array.from(parent.children)) {
		if (child.localName !== "navPoint") continue;

		const label = child.querySelector("navLabel > text");
		const contentEl = child.querySelector("content");
		const title = (label?.textContent || "").trim();
		const rawSrc = decodeURIComponent(
			contentEl?.getAttribute("src") || ""
		);
		const { file, fragment } = splitHref(rawSrc);
		const href = file ? resolvePath(ncxDir, file) : "";
		const children = parseNavPoints(child, depth + 1, ncxDir);

		if (title && href) {
			entries.push({ title, href, fragment, depth, children });
		}
	}
	return entries;
}

// ─── TOC index (href → entries) ─────────────────────────────────────

function buildTocIndex(tree: TocEntry[]): Map<string, TocEntry[]> {
	const map = new Map<string, TocEntry[]>();
	function walk(entries: TocEntry[]) {
		for (const e of entries) {
			if (e.href) {
				if (!map.has(e.href)) map.set(e.href, []);
				map.get(e.href)!.push(e);
			}
			walk(e.children);
		}
	}
	walk(tree);
	return map;
}

// ─── Fragment splitting ─────────────────────────────────────────────

interface FragmentSplit {
	preamble: string | null;
	sections: { tocEntry: TocEntry; html: string }[];
}

function splitAtFragments(
	body: Element,
	entries: TocEntry[]
): FragmentSplit {
	// Map each fragment ID to its nearest top-level body child
	const topLevelBreaks = new Map<Node, TocEntry>();

	for (const entry of entries) {
		if (!entry.fragment) continue;
		const el = findById(body, entry.fragment);
		if (!el) continue;

		// Walk up to find the direct child of body
		let node: Node = el;
		while (node.parentNode && node.parentNode !== body)
			node = node.parentNode;
		if (node.parentNode !== body) continue;

		// First fragment to claim a top-level node wins
		if (!topLevelBreaks.has(node)) topLevelBreaks.set(node, entry);
	}

	if (topLevelBreaks.size === 0) {
		return { preamble: body.innerHTML, sections: [] };
	}

	const result: FragmentSplit = { preamble: null, sections: [] };
	let htmlParts: string[] = [];
	let current: TocEntry | null = null;

	for (const child of Array.from(body.childNodes)) {
		const entry = topLevelBreaks.get(child);
		if (entry) {
			// Save previous segment
			const html = htmlParts.join("").trim();
			if (html) {
				if (current) {
					result.sections.push({ tocEntry: current, html });
				} else {
					result.preamble = html;
				}
			}
			current = entry;
			htmlParts = [serializeNode(child)];
		} else {
			htmlParts.push(serializeNode(child));
		}
	}

	// Save last segment
	const last = htmlParts.join("").trim();
	if (last) {
		if (current) {
			result.sections.push({ tocEntry: current, html: last });
		} else {
			result.preamble = last;
		}
	}

	return result;
}

// ─── Turndown service ───────────────────────────────────────────────

function createTurndownService(): TurndownService {
	const td = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		emDelimiter: "*",
	});
	td.use(gfm);
	td.remove(["style", "script"]);

	// Footnote references
	td.addRule("footnoteRef", {
		filter: function (node: HTMLElement): boolean {
			if (node.nodeName !== "A") return false;
			const epubType = node.getAttribute("epub:type") || "";
			if (epubType.includes("noteref")) return true;
			const role = node.getAttribute("role") || "";
			if (role === "doc-noteref") return true;
			const cls = node.getAttribute("class") || "";
			if (/\b(footnote|noteref|note-ref)\b/i.test(cls)) return true;
			const href = node.getAttribute("href") || "";
			if (
				/^#(fn|note|footnote)\d/i.test(href) &&
				/^\d+$/.test((node.textContent || "").trim())
			)
				return true;
			return false;
		},
		replacement: function (content: string): string {
			const text = content.trim();
			return /^\d+$/.test(text)
				? `[^${text}]`
				: `[^${text.replace(/\s+/g, "-")}]`;
		},
	});

	// Footnote bodies
	td.addRule("footnoteBody", {
		filter: function (node: HTMLElement): boolean {
			const epubType = node.getAttribute("epub:type") || "";
			if (
				epubType.includes("footnote") &&
				!epubType.includes("noteref")
			)
				return true;
			const role = node.getAttribute("role") || "";
			return role === "doc-footnote" || role === "doc-endnote";
		},
		replacement: function (content: string, node: HTMLElement): string {
			const id = node.getAttribute("id") || "";
			const num =
				id.match(/(\d+)/)?.[1] || id.replace(/\D/g, "") || "?";
			// Strip common back-reference patterns
			let text = content
				.replace(/^\s*\[?\d+\]?\(#[^)]*\)\s*/m, "")
				.replace(/\s*↩︎?\s*$/g, "")
				.replace(/\s*\[↩[^\]]*\]\(#[^)]*\)\s*$/gm, "")
				.trim();
			if (!text) text = content.trim();
			return `\n[^${num}]: ${text}\n\n`;
		},
	});

	return td;
}

// ─── Chapter accumulation ───────────────────────────────────────────

function pushChapter(
	chapters: EpubChapter[],
	usedNames: Set<string>,
	title: string,
	markdown: string,
	depth: number,
	contentType: EpubChapter["contentType"]
): void {
	let filename = sanitizeFilename(title);
	if (usedNames.has(filename.toLowerCase())) {
		let n = 2;
		while (usedNames.has(`${filename} (${n})`.toLowerCase())) n++;
		filename = `${filename} (${n})`;
	}
	usedNames.add(filename.toLowerCase());
	chapters.push({ title, filename, markdown, depth, contentType });
}

// ─── Utilities ──────────────────────────────────────────────────────

function getEpubTypes(el: Element): string[] {
	const raw =
		el.getAttribute("epub:type") ||
		el.getAttributeNS("http://www.idpf.org/2007/ops", "type") ||
		"";
	const types = raw.split(/\s+/).filter(Boolean);
	// Also check direct children (sections, etc.)
	for (const child of Array.from(el.children)) {
		const cr =
			child.getAttribute("epub:type") ||
			child.getAttributeNS(
				"http://www.idpf.org/2007/ops",
				"type"
			) ||
			"";
		if (cr) types.push(...cr.split(/\s+/).filter(Boolean));
	}
	return types;
}

function findById(root: Element, id: string): Element | null {
	if (root.id === id) return root;
	try {
		const escaped = id.replace(/"/g, '\\"');
		const el = root.querySelector(`[id="${escaped}"]`);
		if (el) return el;
	} catch {
		/* selector failed — fall through */
	}
	// Fallback: manual search
	for (const el of Array.from(root.querySelectorAll("*"))) {
		if (el.getAttribute("id") === id) return el;
	}
	return null;
}

function splitHref(raw: string): { file: string; fragment: string } {
	const i = raw.indexOf("#");
	if (i === -1) return { file: raw, fragment: "" };
	return { file: raw.substring(0, i), fragment: raw.substring(i + 1) };
}

function directChild(parent: Element, localName: string): Element | null {
	for (const c of Array.from(parent.children)) {
		if (c.localName === localName) return c;
	}
	return null;
}

function serializeNode(node: Node): string {
	if (node.nodeType === 3 /* TEXT_NODE */)
		return node.textContent || "";
	if (node.nodeType === 1 /* ELEMENT_NODE */)
		return (node as Element).outerHTML;
	return "";
}

function extractTitleFromHtml(html: string, fallbackHref: string): string {
	const m = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
	if (m?.[1]) {
		const text = m[1].replace(/<[^>]+>/g, "").trim();
		if (text) return text;
	}
	return (
		fallbackHref
			.replace(/\.x?html?$/i, "")
			.replace(/[_-]/g, " ")
			.trim() || "Untitled"
	);
}

function resolvePath(base: string, relative: string): string {
	if (relative.startsWith("/")) return relative.substring(1);
	const parts = (base + relative).split("/");
	const resolved: string[] = [];
	for (const p of parts) {
		if (p === ".." && resolved.length > 0) resolved.pop();
		else if (p !== "." && p !== "") resolved.push(p);
	}
	return resolved.join("/");
}

function sanitizeFilename(name: string): string {
	let clean = name
		.replace(/[\\/:*?"<>|]/g, "")
		.replace(/^\.*/, "")
		.replace(/\s+/g, " ")
		.trim()
		.substring(0, 100);
	return clean || "Untitled";
}

function assertNoParseError(doc: Document, label: string): void {
	if (doc.querySelector("parsererror"))
		throw new Error(`Invalid EPUB: malformed XML in ${label}`);
}

async function readZipText(
	zip: JSZip,
	path: string
): Promise<string | null> {
	let file = zip.file(path);
	if (!file) file = zip.file(decodeURIComponent(path));
	if (!file) return null;
	return file.async("string");
}
