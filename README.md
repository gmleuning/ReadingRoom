# Library Reader

An Obsidian plugin that turns a vault full of PDFs into a reading room. You find a book from the keyboard, read it in Obsidian's PDF viewer, and write notes beside it that open again with the book next time. You can also search the text of one book or the whole library, and the plugin keeps a front page of what's new, what you've been reading, and which books need fixing.

It is built for large personal libraries: thousands of PDFs (plus EPUBs, documents, images and audio) in folders, usually one folder per author.

Desktop only, because it reads and writes files directly. It is plain JavaScript with no build step and no dependencies.

## Getting started

1. **Open your library folder as an Obsidian vault**, so the folder that holds your books is the vault root.
2. **Install the plugin.** Copy this folder (`main.js`, `styles.css`, `manifest.json`) to `<vault>/.obsidian/plugins/library-reader/`.
3. **Enable it** in **Settings → Community plugins**.
4. **Pick a notes folder** in **Settings → Library Reader**. By default, notes go in a folder called `Notes` beside the vault, e.g. `D:\Books\Notes` for a vault at `D:\Books\Library`. The `LIBRARY_NOTES` environment variable also sets it.
5. **Leave out folders that aren't books**, such as a folder of templates, under **Folders left out of the library**.

On first start, the plugin opens:
- the **Library** panel in the left sidebar
- **Book notes** in the right sidebar
- the **Reference desk** as a tab

## The Reference desk

A front page for the library, opened as a tab with **Alt+D** or the ribbon button. The layout is modelled on the old AAAARG website: a dark top bar, a column of books, and a side column of short lists.

- **Top bar:** links to the Library, Text search and Noted views, and a catalogue search box. Press Enter in the box to run the search in the Library panel.
- **Newest:** the six most recently added books, grouped by day (*today*, *yesterday*, *thursday*…). Each shows its title, author and year, then a description if one is available, otherwise the folder and size. The description comes from a `description:` key in the book's notes, or from the PDF's own Subject metadata. Only small parts of each PDF are read, so even very large files are quick.
- **Recently opened:** the last six books you opened.
- **New requests:** a running list of books you want to get, kept as a Markdown checklist (default `New requests.md`). Type a title in the box and press Enter to add it. Tick items off in the file when they arrive. The desk shows the open ones.
- **Recent annotations:** the first lines of the three newest dated entries across all your notes. Click one to open the book with its notes.
- **Needs fixing:** books that need attention, in four lists:

  | List | What it means |
  |---|---|
  | **Needs OCR** | PDFs with no text layer (scans), found by the text index |
  | **Too large** | Files bigger than a size you choose (100 MB by default) |
  | **Missing author** | No author could be read from the file name |
  | **Won't open** | PDFs the text reader couldn't read |

  **Export** writes every flagged book to one Markdown file (default `Library fixes.md`). It contains a checklist per list, plus a block of full file paths, one per line, ready to paste into an OCR or compression script. Until the text index is built, the desk tells you how many PDFs haven't been checked for a text layer yet.

The requests and fixes files are left out of the catalogue. You can move them anywhere in the vault from settings.

## The Library panel

- **Catalogue.** Built from Obsidian's own file list, so even ~10,000 files load in well under a second. It skips system and temporary files (`desktop.ini`, `thumbs.db`, `.partial`, `.crdownload`, `.tmp`, `~$` lock files, Google Docs stubs), dot-folders, and any folders you leave out.
- **File names.** Authors and titles are read from file names. The main convention is `Author, First. Title (Edition)`, for example:
  ```
  Arendt, Hannah. The Human Condition.pdf
  ```
  These are understood too:
  - `Author - Title`
  - surname-first names followed by a code or year (`Heidegger, Martin GA34 …`)
  - a leading year (`1807 Phenomenology of Spirit`)

  Abbreviations such as *Vol.*, *Ed.* and *Trans.* aren't mistaken for the end of an author's name.
- **Search.** Instant, with every word required to match the author, title or path. Accents and case are ignored, so `hegel phanomenologie` finds *Phänomenologie*. Matches in the author and title rank above matches only in the path, and more words in the author rank higher.
- **Views.** Search, Folders (with breadcrumbs), Pinned, Recent and Noted (newest notes first). A ✎ marks books that have notes, and a ★ marks pinned books.
- **Opening.** Enter opens the book in the main area and keeps the keyboard in the list. Shift+Enter opens it in a new tab with its notes beside it. Files Obsidian can't display open in their default program. Right-click a row for more options.

## Book notes

There is one Markdown file per book, in the notes folder, mirroring the library's folders:

```
<notes folder>/Arendt, Hannah/Arendt, Hannah. The Human Condition.pdf.notes.md
```

```markdown
---
pdf: "Arendt, Hannah/Arendt, Hannah. The Human Condition.pdf"
size: 2834112
hash: 3b1f0c…
created: 2026-10-29
---

## 2026-10-29 19:12
p. 7 labour, work, action

## 2026-11-02 08:40
p. 136 the durability of the world
```

- **Frontmatter.** The plugin maintains `pdf`, `size`, `hash` (SHA-1 of the first 1 MiB of the book) and `created`. Any other keys, such as tags or a `description`, are left alone.
- **No empty files.** Opening a book creates no file. A file appears only when you type something.
- **Date headers.** The first writing of a day at the end of the notes adds `## YYYY-MM-DD HH:MM`. Editing older text adds no header.
- **Autosave.** Notes save shortly after you stop typing (1 s by default), when the box loses focus, and when Obsidian closes. Each write goes to a temporary file first and is then swapped in, so a crash never leaves half a file.
- **Conflict guard.** If the file changed elsewhere since it was loaded (another editor, another device), saving is refused and you choose **Use the file's version** or **Keep what's here**.
- **Never lose text.** If the file can't be written, a draft is kept and the save retried every 5 s. A draft left over from an earlier session is offered back the next time the book opens.
- **Renames.** If you rename a book inside Obsidian, its notes move with it. If a book was renamed elsewhere, opening it finds the old notes by size and hash and offers to move them.
- **Alt+G** inserts a page reference with the viewer's current page, e.g. `p. 112 ` (the format is configurable).
- **Alt+M** switches the notes between serif and monospace.

**Why outside the vault?** Keeping notes out of the vault keeps them out of the catalogue, and out of any sync service the library uses. To search your notes in Obsidian, open the notes folder as a second vault.

## Text search

- Finds a phrase in **This book** or the **Whole library**. Accents and case are ignored, with options for whole word and regular expression.
- Each hit shows its page number and 20 words on each side (configurable). Library results are grouped by book, with a count per book.
- **Enter** or a click jumps to the page in the viewer and highlights the term. **Up** and **Down** move between hits, and **Esc** returns to the book.
- Text is read per page with pdf.js. Line-end hyphenation is rejoined (`phenom-` + `enology`), and loose accents from TeX-made PDFs are recombined (`F¨ur` → `Für`).
- Scans with no text layer are flagged rather than silently returning nothing.
- **The library index.** Whole-library search uses an index built in the background: press **Build index** in the panel or run the command.
  - It saves each book as it finishes, so it can be paused and resumed, and it resumes on the next start if it was running when Obsidian closed.
  - Pinned, recent and noted books are read first.
  - A book is read again only if its size or modification time changes.
  - Allow a few hours and a few GB of local storage for a library of ~10,000 books.

## Keyboard

Global hotkeys (defaults; rebind them in **Settings → Hotkeys**):

| Key | Action |
|---|---|
| Alt+L | Focus the library search |
| Alt+D | Open the Reference desk |
| Alt+N | Switch between the book and its notes |
| Alt+F | Text search (Ctrl+Shift+F belongs to Obsidian's own search) |
| Alt+R | Show Rogetta (or your own web reference page); press again to go back to the book |

In the Library panel:

| Key | Action |
|---|---|
| `/` | Focus search |
| Up, Down, PageUp, PageDown | Move in the list |
| Enter / Shift+Enter | Open here / open in a new tab with notes |
| Esc | Clear the search box |
| Alt+1 … Alt+5 | Search, Folders, Pinned, Recent, Noted |
| Alt+P | Pin or unpin |
| Right or Enter / Left or Backspace | In Folders with an empty box: enter a folder / go up |

In Book notes: **Alt+G** inserts a page reference, and **Alt+M** switches serif or monospace.

These commands have no default key but can be given one:
- pin or unpin the current book
- open it in the default program
- rescan the library
- build or pause the text index
- export the fixes list
- open the requests list

## Web reference

**Alt+R** keeps one web page you consult often in the right sidebar. By default it opens [Rogetta](https://gmleuning.github.io/Rogetta/), but any dictionary, thesaurus or translation page works: change the address in settings. It uses Obsidian's Web viewer core plugin, which must be enabled. If a web tab at that address is already open, it is reused.

## Settings

**Settings → Library Reader**:

- **Library:** notes folder, folders left out, rows shown (400), books kept in Recent (200), recent books under an empty search (50), open the panels on start.
- **Notes:** autosave delay, the Alt+G text (`p. {page} `), monospace.
- **Text search:** result cap (500), words of context (20), largest PDF to index (400 MB), index status with Build/Pause and Clear.
- **Reference desk:** open on start, requests file, fixes file, the size above which books count as too large (100 MB).
- **Web reference:** the address Alt+R opens (Rogetta by default).
- **Appearance:** fonts for book titles, interface, notes and monospace notes; sizes; notes line height; row spacing; colours for the accent, pin, search highlight and notes background.
  - Colours left unset follow your Obsidian theme, including light and dark mode.
  - Every setting has a reset button.

## Where things are stored

| What | Where |
|---|---|
| Notes | `<notes folder>/…/<book>.notes.md` |
| Requests and fixes lists | Markdown files in the vault (paths set in settings) |
| Pins, recents, settings, cached descriptions | `data.json` in the plugin folder |
| Text index | Obsidian's local IndexedDB (gzip-compressed page text) |
| Unsaved drafts | Obsidian's local storage |

## Limits

- Notes are edited in a plain text box, not Obsidian's Markdown editor, because they live outside the vault.
- The first library index build is long, and the index is large.
- Whole-library search reads every indexed book on each query, so results stream in rather than arriving instantly. A Stop button ends a search early.
- "Newest" uses each file's creation date, which is when it was copied into the library.
- PDF highlights are not saved by the plugin.
- Two features use undocumented Obsidian internals and fall back quietly if those change:
  - **Current page number.** Without it, Alt+G inserts the reference without the number.
  - **Highlighting the term after a jump.** Without it, the jump still lands on the right page.

## For developers

All the code is in `main.js`, in this order:

- **Filename parsing:** `parseName`.
- **Notes format:** `splitNote`, `fmGet`, `fmSet` and `writeAtomic`, plus `NotesStore` for file locations, hashing, the conflict guard and relinking.
- **Text search:** `pageText`, `buildMatcher`, `findInPage` and `windowAround`, plus `TextIndex` for extraction and IndexedDB.
- **Views:** `LibraryView`, `NotesView`, `TextSearchView` and `ReferenceDeskView`.
- **Settings:** `LibrarySettingTab`.
- **The plugin class:** catalogue, commands, desk data (`describe`, `recentAnnotations`, `problems`, `exportFixes`, requests), appearance, and opening books.

`styles.css` uses only Obsidian theme variables and `--lr-*` variables, which the plugin sets on `<body>` from the Appearance settings.

The pure functions are exported as `module.exports.__test`, so they can be tested under plain Node with a stub `obsidian` module.

After editing, reload the plugin with the Obsidian CLI (from PowerShell on Windows):

```powershell
obsidian vault=<your vault> plugin:reload id=library-reader
obsidian vault=<your vault> dev:errors
```
