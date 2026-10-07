import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { beginBuild, bookFile, bookInfo, ensureLibrary, libraryDir, listBooks, listCores, readProgress, searchBooks } from "./actions.js";

const require = createRequire(import.meta.url);
const SETTINGS = path.join(os.homedir(), ".repuber.json");
const CHEVRON = path.join(path.dirname(fileURLToPath(import.meta.url)), "chevron.svg");

const STYLE = `
QMainWindow, QWidget { background: #ffffff; color: #1a1d23; font-size: 14px; }
QWidget#header { border-bottom: 1px solid #e8eaee; }
QWidget#hit { border-bottom: 1px solid #e8eaee; background: transparent; }
QWidget#hit:hover { background: #f6f7f9; }
QLabel#title { font-size: 20px; font-weight: 600; }
QLabel#heading { font-size: 16px; font-weight: 600; }
QLabel#section { font-size: 15px; font-weight: 600; }
QLabel#mute, QLabel#lead { color: #6b7280; }
QLabel#error { color: #b42318; }
QLabel#toast { background: #1a1d23; color: #ffffff; padding: 8px 16px; }
QLabel#cover { background: #f6f7f9; }
QLineEdit {
  background: #f6f7f9;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 4px 10px;
  min-height: 28px;
}
QLineEdit:focus { background: #ffffff; border: 1px solid #2554d9; }
QComboBox {
  background: #f6f7f9;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 4px 8px 4px 12px;
  min-height: 28px;
  combobox-popup: 0;
}
QComboBox:hover { background: #eef0f3; }
QComboBox:focus, QComboBox:on { background: #ffffff; border: 1px solid #2554d9; }
QComboBox::drop-down {
  subcontrol-origin: padding;
  subcontrol-position: center right;
  width: 22px;
  border: none;
  background: transparent;
}
QComboBox::down-arrow {
  image: url(${CHEVRON});
  width: 12px;
  height: 12px;
}
QComboBox QAbstractItemView {
  background: #ffffff;
  color: #1a1d23;
  border: 1px solid #e8eaee;
  border-radius: 8px;
  padding: 4px;
  outline: 0;
  selection-background-color: #e8eefc;
  selection-color: #1a1d23;
}
QComboBox QAbstractItemView::item {
  min-height: 28px;
  padding: 4px 10px;
  border-radius: 6px;
}
QComboBox QAbstractItemView::item:hover { background: #f6f7f9; }
QComboBox QAbstractItemView::item:selected { background: #e8eefc; }
QPushButton#brand { background: transparent; border: none; font-size: 15px; font-weight: 700; }
QPushButton#primary { background: #2554d9; color: white; border: none; border-radius: 8px; padding: 8px 16px; min-height: 28px; }
QPushButton#primary:disabled { background: #b8c3e6; color: white; }
QPushButton#link { background: transparent; border: none; color: #2554d9; }
QPushButton#tile {
  background: #ffffff;
  border: 1px solid #d5d9df;
  border-radius: 8px;
  padding: 8px 10px;
  text-align: left;
  min-height: 52px;
}
QPushButton#tile:checked { border: 2px solid #2554d9; background: #f0f4ff; }
QProgressBar { border: none; background: #f6f7f9; border-radius: 3px; max-height: 8px; min-height: 8px; }
QProgressBar::chunk { background: #2554d9; border-radius: 3px; }
QScrollArea { border: none; background: transparent; }
QAbstractScrollArea::corner { background: transparent; border: none; }
QScrollBar:vertical {
  background: transparent;
  width: 10px;
  margin: 4px 2px 4px 0;
  border: none;
}
QScrollBar::handle:vertical {
  background: #c5cad3;
  min-height: 32px;
  border-radius: 4px;
}
QScrollBar::handle:vertical:hover { background: #8b93a1; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
  height: 0;
  width: 0;
  background: none;
  border: none;
}
QScrollBar::up-arrow:vertical, QScrollBar::down-arrow:vertical {
  width: 0;
  height: 0;
  background: none;
}
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical { background: none; }
QScrollBar:horizontal {
  background: transparent;
  height: 10px;
  margin: 0 4px 2px 4px;
  border: none;
}
QScrollBar::handle:horizontal {
  background: #c5cad3;
  min-width: 32px;
  border-radius: 4px;
}
QScrollBar::handle:horizontal:hover { background: #8b93a1; }
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal,
QScrollBar::left-arrow:horizontal, QScrollBar::right-arrow:horizontal {
  width: 0;
  height: 0;
  background: none;
  border: none;
}
QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal { background: none; }
`;

function qt(value) {
  return String(value ?? "").replace(/&/g, "&&");
}

function html(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function readSettings() {
  try {
    return JSON.parse(require("node:fs").readFileSync(SETTINGS, "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(data) {
  require("node:fs").writeFileSync(SETTINGS, JSON.stringify(data));
}

function loadNodeGui() {
  try {
    return require("@nodegui/nodegui");
  } catch (err) {
    const error = new Error("Could not load NodeGui. Run the app with npm start so it uses the bundled qode runtime.");
    error.cause = err;
    throw error;
  }
}

export async function openGui() {
  const app = new Repuber(loadNodeGui());
  globalThis.__repuber = app;
  app.win.show();
  app.query.setFocus();
  app.relayout();
  await ensureLibrary();
  console.log(`Books are saved to ${libraryDir()}`);
  await app.loadCores();
  await app.refreshLibrary();
  return app.win;
}

class Repuber {
  constructor(ng) {
    this.ng = ng;
    this.refs = [];
    this.state = {
      cores: [],
      book: null,
      selected: new Set(),
      hits: [],
      searchCore: "",
      filling: false,
      timer: null,
      toastTimer: null,
      volumeCols: 4,
      wide: true,
    };
    this.pools = { hits: [], books: [], volumes: [] };
    this.pixmaps = [];
    this.build();
  }

  keep(widget) {
    this.refs.push(widget);
    return widget;
  }

  build() {
    const {
      QMainWindow, QWidget, QLabel, QPushButton, QLineEdit, QComboBox, QStackedWidget,
      QScrollArea, QProgressBar, QBoxLayout, QGridLayout, Direction, QSizePolicyPolicy,
      WidgetEventTypes, ScrollBarPolicy, QApplication, QStyleFactory,
    } = this.ng;
    const fusion = QStyleFactory.create("Fusion");
    if (fusion) QApplication.setStyle(fusion);
    const win = new QMainWindow();
    win.setWindowTitle("REPUBer");
    win.resize(920, 860);
    win.setMinimumSize(420, 560);
    win.setStyleSheet(STYLE, false);

    const central = new QWidget();
    const root = new QBoxLayout(Direction.TopToBottom);
    root.setContentsMargins(0, 0, 0, 0);
    root.setSpacing(0);
    central.setLayout(root);
    win.setCentralWidget(central);
    this.keep(central);
    this.keep(root);

    const header = new QWidget();
    header.setObjectName("header");
    const headerLayout = new QBoxLayout(Direction.LeftToRight);
    headerLayout.setContentsMargins(16, 10, 16, 10);
    headerLayout.setSpacing(10);
    header.setLayout(headerLayout);
    this.brand = this.button(QPushButton, "REPUBer", "brand");
    this.core = new QComboBox();
    this.core.setMinimumWidth(120);
    this.core.setMaximumWidth(190);
    this.query = new QLineEdit();
    this.query.setPlaceholderText("Search by title or paste a link");
    this.query.setSizePolicy(QSizePolicyPolicy.Expanding, QSizePolicyPolicy.Fixed);
    this.query.setMinimumWidth(40);
    this.find = this.button(QPushButton, "Search", "primary");
    this.find.setMinimumWidth(96);
    headerLayout.addWidget(this.brand);
    headerLayout.addWidget(this.core);
    headerLayout.addWidget(this.query, 1);
    headerLayout.addWidget(this.find);
    this.keep(header);
    this.keep(headerLayout);

    this.stack = new QStackedWidget();
    this.stack.setSizePolicy(QSizePolicyPolicy.Expanding, QSizePolicyPolicy.Expanding);
    this.home = this.page(QScrollArea, QWidget, QBoxLayout, Direction, QSizePolicyPolicy, ScrollBarPolicy);
    this.bookPage = this.page(QScrollArea, QWidget, QBoxLayout, Direction, QSizePolicyPolicy, ScrollBarPolicy);
    this.progress = this.page(QScrollArea, QWidget, QBoxLayout, Direction, QSizePolicyPolicy, ScrollBarPolicy);
    this.stack.addWidget(this.home.scroll);
    this.stack.addWidget(this.bookPage.scroll);
    this.stack.addWidget(this.progress.scroll);

    this.toast = this.text(QLabel, "", "toast");
    this.toast.setHidden(true);

    root.addWidget(header);
    root.addWidget(this.stack, 1);
    root.addWidget(this.toast);

    this.buildHome(QLabel, QPushButton, QWidget, QBoxLayout, Direction);
    this.buildBookPage(QLabel, QPushButton, QComboBox, QWidget, QBoxLayout, QGridLayout, Direction);
    this.buildProgress(QLabel, QPushButton, QProgressBar, QWidget, QBoxLayout, Direction);

    this.brand.addEventListener("clicked", () => this.show("home"));
    this.find.addEventListener("clicked", () => this.submit());
    this.query.addEventListener("returnPressed", () => this.submit());
    this.core.addEventListener("currentIndexChanged", () => {
      if (this.state.filling) return;
      this.applyCore();
      this.clearResults();
    });
    win.addEventListener(WidgetEventTypes.Resize, () => this.relayout());
    win.addEventListener(WidgetEventTypes.Close, () => {
      if (this.state.timer) clearInterval(this.state.timer);
    });
    this.win = win;
  }

  page(QScrollArea, QWidget, QBoxLayout, Direction, QSizePolicyPolicy, ScrollBarPolicy) {
    const scroll = new QScrollArea();
    scroll.setWidgetResizable(true);
    scroll.setHorizontalScrollBarPolicy(ScrollBarPolicy.ScrollBarAlwaysOff);
    scroll.setSizePolicy(QSizePolicyPolicy.Expanding, QSizePolicyPolicy.Expanding);
    const inner = new QWidget();
    inner.setMinimumWidth(0);
    inner.setSizePolicy(QSizePolicyPolicy.Ignored, QSizePolicyPolicy.Preferred);
    const row = new QBoxLayout(Direction.LeftToRight);
    row.setContentsMargins(16, 20, 16, 32);
    row.setSpacing(0);
    inner.setLayout(row);
    const column = new QWidget();
    column.setMinimumWidth(0);
    column.setMaximumWidth(860);
    const layout = new QBoxLayout(Direction.TopToBottom);
    layout.setSpacing(8);
    column.setLayout(layout);
    column.setSizePolicy(QSizePolicyPolicy.Expanding, QSizePolicyPolicy.Preferred);
    row.addStretch(1);
    row.addWidget(column, 100);
    row.addStretch(1);
    scroll.setWidget(inner);
    this.keep(scroll);
    this.keep(inner);
    this.keep(row);
    this.keep(column);
    this.keep(layout);
    return { scroll, layout };
  }

  button(QPushButton, text, name) {
    const button = new QPushButton();
    button.setText(qt(text));
    button.setObjectName(name);
    button.setCursor(this.ng.CursorShape.PointingHandCursor);
    return this.keep(button);
  }

  text(QLabel, value, name) {
    const { QSizePolicyPolicy } = this.ng;
    const label = new QLabel();
    label.setText(qt(value));
    label.setWordWrap(true);
    label.setMinimumWidth(0);
    label.setSizePolicy(QSizePolicyPolicy.Preferred, QSizePolicyPolicy.Minimum);
    if (name) label.setObjectName(name);
    return this.keep(label);
  }

  buildHome(QLabel, QPushButton, QWidget, QBoxLayout, Direction) {
    const layout = this.home.layout;
    layout.addWidget(this.text(QLabel, "Save a book for offline reading", "title"));
    layout.addWidget(this.text(
      QLabel,
      "Choose a source, search for a title or paste a link, then pick a translation and volumes. The book is saved as an EPUB.",
      "lead",
    ));
    this.homeError = this.text(QLabel, "", "error");
    this.homeError.setHidden(true);
    layout.addWidget(this.homeError);

    this.results = new QWidget();
    const resultsLayout = new QBoxLayout(Direction.TopToBottom);
    resultsLayout.setContentsMargins(0, 12, 0, 0);
    resultsLayout.setSpacing(4);
    this.results.setLayout(resultsLayout);
    const head = new QWidget();
    const headLayout = new QBoxLayout(Direction.LeftToRight);
    headLayout.setContentsMargins(0, 0, 0, 0);
    head.setLayout(headLayout);
    this.resultsTitle = this.text(QLabel, "", "section");
    this.clearResultsButton = this.button(QPushButton, "Clear", "link");
    headLayout.addWidget(this.resultsTitle, 1);
    headLayout.addWidget(this.clearResultsButton);
    this.resultsEmpty = this.text(QLabel, "Try another title, or paste a link.", "mute");
    this.resultsEmpty.setHidden(true);
    this.resultsList = new QWidget();
    const listLayout = new QBoxLayout(Direction.TopToBottom);
    listLayout.setContentsMargins(0, 0, 0, 0);
    listLayout.setSpacing(0);
    this.resultsList.setLayout(listLayout);
    this.resultsList._layout = listLayout;
    resultsLayout.addWidget(head);
    resultsLayout.addWidget(this.resultsEmpty);
    resultsLayout.addWidget(this.resultsList);
    this.results.setHidden(true);
    layout.addWidget(this.results);
    this.clearResultsButton.addEventListener("clicked", () => this.clearResults());
    this.keep(this.results);
    this.keep(resultsLayout);
    this.keep(head);
    this.keep(headLayout);
    this.keep(this.resultsList);
    this.keep(listLayout);

    const libHead = new QWidget();
    const libLayout = new QBoxLayout(Direction.LeftToRight);
    libLayout.setContentsMargins(0, 16, 0, 0);
    libLayout.setSpacing(12);
    libHead.setLayout(libLayout);
    libLayout.addWidget(this.text(QLabel, "Your books", "section"));
    const saved = this.text(QLabel, "Saved on this computer", "mute");
    saved.setToolTip(libraryDir());
    libLayout.addWidget(saved, 1);
    layout.addWidget(libHead);
    this.libraryList = new QWidget();
    const libraryLayout = new QBoxLayout(Direction.TopToBottom);
    libraryLayout.setContentsMargins(0, 0, 0, 0);
    libraryLayout.setSpacing(0);
    this.libraryList.setLayout(libraryLayout);
    this.libraryList._layout = libraryLayout;
    layout.addWidget(this.libraryList);
    this.libraryEmpty = this.text(QLabel, "Books you build will appear here.", "mute");
    layout.addWidget(this.libraryEmpty);
    layout.addStretch(1);
    this.keep(libHead);
    this.keep(libLayout);
    this.keep(this.libraryList);
    this.keep(libraryLayout);
  }

  buildBookPage(QLabel, QPushButton, QComboBox, QWidget, QBoxLayout, QGridLayout, Direction) {
    const { AlignmentFlag, QSizePolicyPolicy } = this.ng;
    const layout = this.bookPage.layout;
    const back = this.button(QPushButton, "← Back to search", "link");
    back.addEventListener("clicked", () => this.show("home"));
    layout.addWidget(back, 0, AlignmentFlag.AlignLeft);

    const top = new QWidget();
    const topLayout = new QBoxLayout(Direction.LeftToRight);
    topLayout.setContentsMargins(0, 8, 0, 0);
    topLayout.setSpacing(16);
    top.setLayout(topLayout);
    this.bookTop = topLayout;
    this.cover = this.text(QLabel, "", "cover");
    this.cover.setFixedSize(120, 180);
    this.cover.setAlignment(AlignmentFlag.AlignCenter);
    this.cover.setSizePolicy(QSizePolicyPolicy.Fixed, QSizePolicyPolicy.Fixed);
    const info = new QWidget();
    const infoLayout = new QBoxLayout(Direction.TopToBottom);
    infoLayout.setContentsMargins(0, 0, 0, 0);
    infoLayout.setSpacing(4);
    info.setLayout(infoLayout);
    info.setSizePolicy(QSizePolicyPolicy.Expanding, QSizePolicyPolicy.Preferred);
    this.bookTitle = this.text(QLabel, "", "heading");
    this.bookAlt = this.text(QLabel, "", "mute");
    this.bookBy = new QLabel();
    this.bookBy.setWordWrap(true);
    this.bookBy.setMinimumWidth(0);
    this.bookBy.setTextFormat(this.ng.TextFormat.RichText);
    this.bookBy.setSizePolicy(QSizePolicyPolicy.Preferred, QSizePolicyPolicy.Minimum);
    this.genres = this.text(QLabel, "", "mute");
    this.facts = this.text(QLabel, "", "");
    infoLayout.addWidget(this.bookTitle);
    infoLayout.addWidget(this.bookAlt);
    infoLayout.addWidget(this.bookBy);
    infoLayout.addWidget(this.genres);
    infoLayout.addWidget(this.facts);
    topLayout.addWidget(this.cover, 0, AlignmentFlag.AlignLeft | AlignmentFlag.AlignTop);
    topLayout.addWidget(info, 1);
    layout.addWidget(top);
    this.keep(top);
    this.keep(topLayout);
    this.keep(info);
    this.keep(infoLayout);
    this.keep(this.bookBy);

    layout.addSpacing(10);
    layout.addWidget(this.text(QLabel, "About", "section"));
    this.summary = new QLabel();
    this.summary.setWordWrap(true);
    this.summary.setMinimumWidth(0);
    this.summary.setTextFormat(this.ng.TextFormat.RichText);
    this.summary.setSizePolicy(QSizePolicyPolicy.Preferred, QSizePolicyPolicy.Minimum);
    layout.addWidget(this.summary);
    this.tags = this.text(QLabel, "", "mute");
    this.notes = this.text(QLabel, "", "mute");
    layout.addWidget(this.tags);
    layout.addWidget(this.notes);
    this.keep(this.summary);

    layout.addSpacing(10);
    layout.addWidget(this.text(QLabel, "Download", "section"));
    layout.addWidget(this.text(QLabel, "Translation", "heading"));
    this.branch = new QComboBox();
    this.branch.setMaximumWidth(420);
    this.branch.setMinimumWidth(0);
    this.branch.setSizePolicy(QSizePolicyPolicy.Expanding, QSizePolicyPolicy.Fixed);
    layout.addWidget(this.branch);
    this.keep(this.branch);

    const volHead = new QWidget();
    const volLayout = new QBoxLayout(Direction.LeftToRight);
    volLayout.setContentsMargins(0, 8, 0, 0);
    volLayout.setSpacing(12);
    volHead.setLayout(volLayout);
    volLayout.addWidget(this.text(QLabel, "Volumes", "heading"));
    const all = this.button(QPushButton, "Select all", "link");
    const none = this.button(QPushButton, "Clear", "link");
    all.addEventListener("clicked", () => {
      this.state.selected = new Set((this.state.book?.volumes || []).map((volume) => volume.v));
      this.paintVolumes();
    });
    none.addEventListener("clicked", () => {
      this.state.selected = new Set();
      this.paintVolumes();
    });
    volLayout.addWidget(all);
    volLayout.addWidget(none);
    volLayout.addStretch(1);
    layout.addWidget(volHead);
    this.volumeList = new QWidget();
    const grid = new QGridLayout();
    grid.setContentsMargins(0, 0, 0, 0);
    grid.setSpacing(8);
    this.volumeList.setLayout(grid);
    this.volumeList._layout = grid;
    layout.addWidget(this.volumeList);
    this.keep(volHead);
    this.keep(volLayout);
    this.keep(this.volumeList);
    this.keep(grid);

    const act = new QWidget();
    const actLayout = new QBoxLayout(Direction.LeftToRight);
    actLayout.setContentsMargins(0, 8, 0, 0);
    actLayout.setSpacing(12);
    act.setLayout(actLayout);
    this.download = this.button(QPushButton, "Build EPUB", "primary");
    this.summaryCount = this.text(QLabel, "", "mute");
    this.download.addEventListener("clicked", () => this.buildBook());
    actLayout.addWidget(this.download);
    actLayout.addWidget(this.summaryCount, 1);
    layout.addWidget(act);
    this.bookError = this.text(QLabel, "", "error");
    this.bookError.setHidden(true);
    layout.addWidget(this.bookError);
    layout.addStretch(1);
    this.keep(act);
    this.keep(actLayout);
  }

  buildProgress(QLabel, QPushButton, QProgressBar, QWidget, QBoxLayout, Direction) {
    const { QSizePolicyPolicy } = this.ng;
    const layout = this.progress.layout;
    const holder = new QWidget();
    const holderLayout = new QBoxLayout(Direction.LeftToRight);
    holderLayout.setContentsMargins(0, 12, 0, 0);
    holder.setLayout(holderLayout);
    const wrap = new QWidget();
    wrap.setMaximumWidth(480);
    wrap.setMinimumWidth(0);
    wrap.setSizePolicy(QSizePolicyPolicy.Expanding, QSizePolicyPolicy.Preferred);
    const wrapLayout = new QBoxLayout(Direction.TopToBottom);
    wrapLayout.setContentsMargins(0, 0, 0, 0);
    wrapLayout.setSpacing(8);
    wrap.setLayout(wrapLayout);
    this.progressTitle = this.text(QLabel, "", "heading");
    wrapLayout.addWidget(this.progressTitle);
    wrapLayout.addWidget(this.text(QLabel, "Downloading chapters and packing them into an EPUB. Keep this window open.", "mute"));
    this.bar = new QProgressBar();
    this.bar.setRange(0, 100);
    this.bar.setTextVisible(false);
    this.bar.setValue(0);
    this.bar.setFixedHeight(8);
    wrapLayout.addWidget(this.bar);
    const stat = new QWidget();
    const statLayout = new QBoxLayout(Direction.LeftToRight);
    statLayout.setContentsMargins(0, 0, 0, 0);
    stat.setLayout(statLayout);
    this.progressMsg = this.text(QLabel, "Starting…", "");
    this.progressPct = this.text(QLabel, "0%", "heading");
    statLayout.addWidget(this.progressMsg, 1);
    statLayout.addWidget(this.progressPct);
    wrapLayout.addWidget(stat);
    this.progressCount = this.text(QLabel, "", "mute");
    wrapLayout.addWidget(this.progressCount);
    this.progressError = this.text(QLabel, "", "error");
    this.progressError.setHidden(true);
    wrapLayout.addWidget(this.progressError);
    this.progressBack = this.button(QPushButton, "Back to start", "primary");
    this.progressBack.addEventListener("clicked", () => this.show("home"));
    this.progressBack.setHidden(true);
    wrapLayout.addWidget(this.progressBack);
    holderLayout.addStretch(1);
    holderLayout.addWidget(wrap, 100);
    holderLayout.addStretch(1);
    layout.addWidget(holder);
    layout.addStretch(1);
    this.keep(this.bar);
    this.keep(holder);
    this.keep(holderLayout);
    this.keep(wrap);
    this.keep(wrapLayout);
    this.keep(stat);
    this.keep(statLayout);
  }

  relayout() {
    if (this.state.layingOut || !this.win?.native || !this.bookTop) return;
    this.state.layingOut = true;
    try {
      this.applyLayout();
    } finally {
      this.state.layingOut = false;
    }
  }

  applyLayout() {
    const width = this.win.width();
    const wide = width >= 640;
    const direction = wide ? this.ng.Direction.LeftToRight : this.ng.Direction.TopToBottom;
    if (this.state.wide !== wide) {
      this.state.wide = wide;
      this.bookTop.setDirection(direction);
    }
    const view = this.bookPage.scroll.viewport();
    const viewWidth = Math.max(280, (view?.width?.() || width) - 32);
    const cols = Math.max(2, Math.min(6, Math.floor(viewWidth / 150)));
    if (cols !== this.state.volumeCols) {
      this.state.volumeCols = cols;
      if (this.state.book) this.paintVolumes();
    }
  }

  currentCore() {
    const index = this.core.currentIndex();
    return this.state.cores[index] || null;
  }

  async loadCores() {
    const saved = readSettings().core || "";
    try {
      this.state.cores = await listCores();
    } catch (err) {
      this.setError(this.homeError, err.message);
      this.state.cores = [];
    }
    this.state.filling = true;
    this.core.clear();
    this.state.cores.forEach((core) => this.core.addItem(undefined, core.name || core.id));
    const index = Math.max(0, this.state.cores.findIndex((core) => core.id === saved));
    if (this.state.cores.length) this.core.setCurrentIndex(index === -1 ? 0 : index);
    this.state.filling = false;
    if (!this.state.cores.length) this.setError(this.homeError, "No sources found. Add a core in the cores folder.");
    this.applyCore();
    const names = this.state.cores.map((core) => core.name).join(", ");
    console.log(`Sources: ${names || "none"}`);
  }

  applyCore() {
    const core = this.currentCore();
    if (core) writeSettings({ ...readSettings(), core: core.id });
    this.query.setPlaceholderText(core?.placeholder || "Search by title or paste a link");
    this.core.setToolTip(core?.description || "");
  }

  setError(label, message) {
    if (!label?.native) return;
    label.setText(qt(message || ""));
    label.setHidden(!message);
  }

  show(view) {
    const index = { home: 0, book: 1, progress: 2 }[view];
    this.stack.setCurrentIndex(index);
    const locked = view === "progress";
    this.query.setEnabled(!locked);
    this.find.setEnabled(!locked);
    this.core.setEnabled(!locked);
    this.setError(this.homeError, "");
    if (view === "home") this.refreshLibrary();
    this.relayout();
  }

  showToast(message) {
    this.toast.setText(qt(message));
    this.toast.setHidden(false);
    if (this.state.toastTimer) clearTimeout(this.state.toastTimer);
    this.state.toastTimer = setTimeout(() => {
      if (this.toast?.native) this.toast.setHidden(true);
    }, 4500);
  }

  isDirect(query) {
    const pattern = this.currentCore()?.linkRe || "";
    if (!pattern) return /^https?:\/\//.test(query);
    try {
      return new RegExp(pattern).test(query);
    } catch {
      return /^https?:\/\//.test(query);
    }
  }

  submit() {
    const query = this.query.text().trim();
    if (!query) return;
    if (this.isDirect(query)) {
      this.openBook(query, this.currentCore()?.id);
      return;
    }
    if (this.stack.currentIndex() !== 0) this.show("home");
    this.search(query);
  }

  async search(query) {
    this.setError(this.homeError, "");
    this.find.setEnabled(false);
    this.find.setText("Searching…");
    const coreId = this.currentCore()?.id || "";
    this.state.searchCore = coreId;
    try {
      const hits = await searchBooks(coreId, query);
      if ((this.currentCore()?.id || "") !== coreId) return;
      this.state.hits = hits;
      this.resultsTitle.setText(qt(`${hits.length ? "Results for" : "Nothing found for"} “${query}”`));
      this.resultsEmpty.setHidden(hits.length > 0);
      this.syncList(this.resultsList._layout, this.pools.hits, hits.length, () => this.makeHit(), (row, index) => {
        const hit = hits[index];
        const meta = [hit.type, hit.year, hit.rating && `★ ${hit.rating}`, hit.status].filter(Boolean).join(" · ");
        const alt = hit.alt && hit.alt !== hit.title ? hit.alt : "";
        row._title.setText(qt(hit.title));
        row._alt.setText(qt(alt));
        row._alt.setHidden(!alt);
        row._meta.setText(qt(meta));
        row._meta.setHidden(!meta);
        row._hit = hit;
        this.loadPixmap(hit.cover, row._cover, 40, 60);
      });
      this.results.setHidden(false);
    } catch (err) {
      this.setError(this.homeError, err.message || "Something went wrong. Try again.");
    } finally {
      if (this.find?.native) {
        this.find.setEnabled(this.stack.currentIndex() !== 2);
        this.find.setText("Search");
      }
    }
  }

  clearResults() {
    this.state.hits = [];
    this.results.setHidden(true);
  }

  makeHit() {
    const { QWidget, QBoxLayout, QLabel, Direction, WidgetAttribute, WidgetEventTypes, QSizePolicyPolicy } = this.ng;
    const row = new QWidget();
    row.setObjectName("hit");
    row.setCursor(this.ng.CursorShape.PointingHandCursor);
    row.setAttribute(WidgetAttribute.WA_Hover, true);
    row.setMinimumWidth(0);
    const layout = new QBoxLayout(Direction.LeftToRight);
    layout.setContentsMargins(0, 8, 0, 8);
    layout.setSpacing(10);
    row.setLayout(layout);
    const cover = new QLabel();
    cover.setObjectName("cover");
    cover.setFixedSize(40, 60);
    cover.setAttribute(WidgetAttribute.WA_TransparentForMouseEvents, true);
    const text = new QWidget();
    text.setAttribute(WidgetAttribute.WA_TransparentForMouseEvents, true);
    text.setSizePolicy(QSizePolicyPolicy.Expanding, QSizePolicyPolicy.Preferred);
    text.setMinimumWidth(0);
    const textLayout = new QBoxLayout(Direction.TopToBottom);
    textLayout.setContentsMargins(0, 0, 0, 0);
    textLayout.setSpacing(0);
    text.setLayout(textLayout);
    const title = this.text(QLabel, "", "heading");
    const alt = this.text(QLabel, "", "mute");
    const meta = this.text(QLabel, "", "mute");
    for (const label of [title, alt, meta, cover]) {
      label.setAttribute(WidgetAttribute.WA_TransparentForMouseEvents, true);
    }
    textLayout.addWidget(title);
    textLayout.addWidget(alt);
    textLayout.addWidget(meta);
    layout.addWidget(cover, 0, this.ng.AlignmentFlag.AlignTop);
    layout.addWidget(text, 1);
    row.addEventListener(WidgetEventTypes.MouseButtonRelease, () => {
      if (row._hit) this.openBook(row._hit.slug, row._hit.core);
    });
    row._cover = cover;
    row._title = title;
    row._alt = alt;
    row._meta = meta;
    this.keep(row);
    this.keep(layout);
    this.keep(cover);
    this.keep(text);
    this.keep(textLayout);
    return row;
  }

  async openBook(query, coreId) {
    this.setError(this.homeError, "");
    this.find.setEnabled(false);
    this.find.setText("Searching…");
    try {
      const book = await bookInfo(coreId || this.currentCore()?.id || "", query);
      book.authors = book.authors || [];
      book.artists = book.artists || [];
      book.genres = book.genres || [];
      book.tags = book.tags || [];
      book.notes = book.notes || [];
      book.facts = book.facts || [];
      book.other = book.other || [];
      book.volumes = book.volumes || [];
      book.branches = book.branches || [];
      book.core = book.core || coreId || "";
      this.state.book = book;
      this.state.selected = new Set(book.volumes.map((volume) => volume.v));
      this.bookTitle.setText(qt(book.title));
      this.bookAlt.setText(qt([book.alt, ...book.other].filter((name) => name && name !== book.title).join(" · ")));
      this.bookAlt.setHidden(!this.bookAlt.text());
      const by = [
        book.authors.length ? `<b>${html(book.authors.join(", "))}</b>` : "",
        book.artists.length ? `<span style="color:#6b7280">Art: ${html(book.artists.join(", "))}</span>` : "",
      ].filter(Boolean);
      this.bookBy.setText(by.join(" · "));
      this.bookBy.setHidden(!by.length);
      this.genres.setText(qt(book.genres.join(" · ")));
      this.genres.setHidden(!book.genres.length);
      const facts = [
        ...book.facts,
        ["Chapters", `${book.chapters} in ${book.volumes.length} volume${book.volumes.length > 1 ? "s" : ""}`],
      ];
      this.facts.setText(qt(facts.map(([key, value]) => `${key}: ${value}`).join("\n")));
      this.summary.setText(book.summary || '<span style="color:#6b7280">No description available.</span>');
      this.tags.setText(book.tags.length ? qt(`Tags (${book.tags.length}): ${book.tags.join(", ")}`) : "");
      this.tags.setHidden(!book.tags.length);
      this.notes.setText(book.notes.length ? qt(`Content notes: ${book.notes.join("; ")}`) : "");
      this.notes.setHidden(!book.notes.length);
      this.state.filling = true;
      this.branch.clear();
      book.branches.forEach((branch) => this.branch.addItem(undefined, `${branch.name} (${branch.chapters} chapters)`));
      this.state.filling = false;
      this.loadPixmap(book.cover, this.cover, 120, 180);
      this.relayout();
      this.paintVolumes();
      this.setError(this.bookError, "");
      this.show("book");
    } catch (err) {
      this.setError(this.homeError, err.message || "Something went wrong. Try again.");
    } finally {
      if (this.find?.native) {
        this.find.setEnabled(this.stack.currentIndex() !== 2);
        this.find.setText("Search");
      }
    }
  }

  paintVolumes() {
    const book = this.state.book;
    if (!book || !this.volumeList?._layout) return;
    const { QPushButton, QSizePolicyPolicy } = this.ng;
    const layout = this.volumeList._layout;
    const cols = this.state.volumeCols || 2;
    this.syncList(layout, this.pools.volumes, book.volumes.length, () => {
      const button = new QPushButton();
      button.setObjectName("tile");
      button.setCheckable(true);
      button.setCursor(this.ng.CursorShape.PointingHandCursor);
      button.setMinimumWidth(0);
      button.setMinimumHeight(56);
      button.setSizePolicy(QSizePolicyPolicy.Expanding, QSizePolicyPolicy.Fixed);
      button.addEventListener("clicked", () => {
        const current = this.state.book;
        if (!current) return;
        const all = this.state.selected.size === current.volumes.length;
        const id = button._volume;
        if (all) this.state.selected = new Set([id]);
        else if (this.state.selected.has(id)) this.state.selected.delete(id);
        else this.state.selected.add(id);
        this.paintVolumes();
      });
      this.keep(button);
      return button;
    }, (button, index) => {
      const volume = book.volumes[index];
      button._volume = volume.v;
      button.setText(qt(`Volume ${volume.v}\n${volume.n} chapters`));
      button.setChecked(this.state.selected.has(volume.v));
    }, cols);
    const count = book.volumes.filter((volume) => this.state.selected.has(volume.v)).reduce((sum, volume) => sum + volume.n, 0);
    this.summaryCount.setText(
      qt(this.state.selected.size ? `${this.state.selected.size} volume${this.state.selected.size > 1 ? "s" : ""}, ${count} chapters` : "Select at least one volume"),
    );
    this.download.setEnabled(this.state.selected.size > 0);
  }

  async buildBook() {
    const book = this.state.book;
    if (!book || !this.state.selected.size) return;
    if (this.state.timer) clearInterval(this.state.timer);
    this.progressTitle.setText(qt(book.title));
    this.bar.setValue(0);
    this.progressPct.setText("0%");
    this.progressMsg.setText("Starting…");
    this.progressCount.setText("");
    this.setError(this.progressError, "");
    this.progressBack.setHidden(true);
    this.show("progress");
    const branchLabel = this.branch.currentText() || "";
    let id;
    try {
      ({ id } = await beginBuild({
        core: book.core,
        slug: book.slug,
        title: book.title,
        cover: book.cover,
        branch: this.branch.currentIndex() < 0 || this.branchId() === "" ? null : this.branchId(),
        team: branchLabel.replace(/ \(\d+ chapters\)$/, ""),
        volumes: [...this.state.selected],
      }));
    } catch (err) {
      this.progressMsg.setText("Build stopped");
      this.setError(this.progressError, err.message || "Something went wrong.");
      this.progressBack.setHidden(false);
      return;
    }
    this.state.timer = setInterval(async () => {
      const progress = readProgress(id);
      if (!this.progressMsg?.native) {
        clearInterval(this.state.timer);
        return;
      }
      const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
      this.bar.setValue(pct);
      this.progressPct.setText(`${pct}%`);
      this.progressMsg.setText(qt(progress.state === "done" ? "Saving your book…" : progress.msg));
      this.progressCount.setText(progress.total ? qt(`${progress.done} of ${progress.total} chapters`) : "");
      if (progress.state === "running") return;
      clearInterval(this.state.timer);
      this.state.timer = null;
      if (progress.state === "error") {
        this.progressMsg.setText("Build stopped");
        this.setError(this.progressError, progress.msg);
        this.progressBack.setHidden(false);
        return;
      }
      this.bar.setValue(100);
      this.progressPct.setText("100%");
      const filename = progress.file;
      setTimeout(() => {
        this.clearResults();
        this.show("home");
        if (filename) this.saveCopy({ name: filename });
        else this.showToast(`“${book.title}” was saved to your library.`);
      }, 1800);
    }, 700);
  }

  branchId() {
    const branch = this.state.book?.branches?.[this.branch.currentIndex()];
    if (!branch || branch.id == null || branch.id === "") return "";
    return branch.id;
  }

  async refreshLibrary() {
    let books = [];
    try {
      books = await listBooks();
    } catch {
      books = [];
    }
    this.libraryEmpty.setHidden(books.length > 0);
    this.syncList(this.libraryList._layout, this.pools.books, books.length, () => this.makeLibraryRow(), (row, index) => {
      const file = books[index];
      row._file = file;
      row._title.setText(qt(file.name.replace(/\.epub$/, "")));
      row._meta.setText(qt(`${file.mb} MB · Save a copy`));
    });
  }

  makeLibraryRow() {
    const { QWidget, QLabel, QBoxLayout, Direction, WidgetAttribute, WidgetEventTypes, QSizePolicyPolicy } = this.ng;
    const row = new QWidget();
    row.setObjectName("hit");
    row.setCursor(this.ng.CursorShape.PointingHandCursor);
    row.setAttribute(WidgetAttribute.WA_Hover, true);
    row.setMinimumWidth(0);
    const layout = new QBoxLayout(Direction.LeftToRight);
    layout.setContentsMargins(0, 8, 0, 8);
    layout.setSpacing(12);
    row.setLayout(layout);
    const title = this.text(QLabel, "", "");
    title.setSizePolicy(QSizePolicyPolicy.Expanding, QSizePolicyPolicy.Preferred);
    const meta = this.text(QLabel, "", "mute");
    for (const label of [title, meta]) label.setAttribute(WidgetAttribute.WA_TransparentForMouseEvents, true);
    layout.addWidget(title, 1);
    layout.addWidget(meta);
    row.addEventListener(WidgetEventTypes.MouseButtonRelease, () => this.saveCopy(row._file));
    row._title = title;
    row._meta = meta;
    this.keep(row);
    this.keep(layout);
    return row;
  }

  saveCopy(file) {
    if (!file) return;
    const { QFileDialog, AcceptMode, FileMode, DialogCode } = this.ng;
    const source = bookFile(file.name);
    if (!source) return;
    const dialog = new QFileDialog(this.win, "Save a copy", path.join(libraryDir(), file.name), "EPUB (*.epub)");
    dialog.setAcceptMode(AcceptMode.AcceptSave);
    dialog.setFileMode(FileMode.AnyFile);
    dialog.setDefaultSuffix("epub");
    this.saveDialog = dialog;
    if (dialog.exec() !== DialogCode.Accepted) return;
    const [dest] = dialog.selectedFiles();
    if (!dest) return;
    const target = dest.toLowerCase().endsWith(".epub") ? dest : `${dest}.epub`;
    fs.copyFile(source, target)
      .then(() => this.showToast("Saved a copy."))
      .catch((err) => this.showToast(err.message));
  }

  loadPixmap(url, label, width, height) {
    const token = url || "";
    label._token = token;
    if (label.native) label.clear();
    if (!token) return;
    fetch(token, {
      headers: {
        Referer: "https://ranobelib.me/",
        "User-Agent": "Mozilla/5.0",
      },
    })
      .then((res) => (res.ok ? res.arrayBuffer() : null))
      .then((buf) => {
        if (!buf || label._token !== token || !label.native) return;
        const pix = new this.ng.QPixmap();
        if (!pix.loadFromData(Buffer.from(buf))) return;
        const ratio = this.win.devicePixelRatioF?.() || 1;
        const scaled = pix.scaled(
          Math.round(width * ratio),
          Math.round(height * ratio),
          this.ng.AspectRatioMode.KeepAspectRatio,
          this.ng.TransformationMode.SmoothTransformation,
        );
        scaled.setDevicePixelRatio(ratio);
        label._pix = scaled;
        this.pixmaps.push(pix, scaled);
        if (this.pixmaps.length > 80) this.pixmaps.splice(0, this.pixmaps.length - 80);
        if (label._token !== token || !label.native) return;
        label.setPixmap(scaled);
      })
      .catch(() => {});
  }

  syncList(layout, pool, count, create, update, columns) {
    while (pool.length < count) {
      const widget = create();
      pool.push(widget);
      if (!columns) layout.addWidget(widget);
    }
    const grid = Boolean(columns);
    if (grid) {
      for (const widget of pool) layout.removeWidget(widget);
      for (let column = 0; column < 8; column++) layout.setColumnStretch(column, column < columns ? 1 : 0);
    }
    for (let i = 0; i < pool.length; i++) {
      const widget = pool[i];
      if (!widget?.native) continue;
      if (i < count) {
        update(widget, i);
        if (grid) layout.addWidget(widget, Math.floor(i / columns), i % columns);
        widget.setHidden(false);
      } else {
        if (!grid) widget.setHidden(true);
        else widget.setHidden(true);
      }
    }
  }
}
