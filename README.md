# EPUB to Markdown

An Obsidian plugin that converts EPUB files into a folder of Markdown notes with extracted images. Works on both desktop and mobile.

## Features

- Convert any `.epub` file in your vault to Markdown
- Each chapter becomes its own `.md` file
- Images are extracted to an `assets/` subfolder
- An index note is created with book metadata and a linked table of contents
- YAML frontmatter with title, author, and language
- Works on **mobile** (Android/iOS) — pure JavaScript, no external dependencies

## Usage

1. Add an `.epub` file to your vault
2. Right-click the file and select **Convert to Markdown**, or open it and use the command palette
3. A new folder is created with the book's chapters as Markdown files:

```
Book Title/
├── Book Title.md          ← index with metadata + TOC
├── 01 Chapter One.md
├── 02 Chapter Two.md
└── assets/
    ├── cover.jpg
    └── figure1.png
```

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Output folder | Where converted books are saved (empty = next to EPUB) | _(empty)_ |
| Number chapters | Prefix filenames with 01, 02, ... | On |
| Assets subfolder | Name of the image subfolder | `assets` |
| Include frontmatter | Add YAML metadata to the index note | On |

## Installation (BRAT)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
2. Add this repo: `martinjuskelis/obsidian-epub-to-md`
3. Enable the plugin in Settings → Community Plugins
