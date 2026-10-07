import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { EpubBook, EpubHtml, EpubItem, writeEpub } from "../src/cores/epub.js";

function firstEntry(buf) {
  const method = buf[8] | (buf[9] << 8);
  const flags = buf[6] | (buf[7] << 8);
  const nameLen = buf[26] | (buf[27] << 8);
  const extraLen = buf[28] | (buf[29] << 8);
  const name = new TextDecoder().decode(buf.subarray(30, 30 + nameLen));
  return { method, flags, name, extraLen };
}

test("writeEpub stores mimetype first and packs the book", () => {
  const book = new EpubBook();
  book.setIdentifier("ranobe-1--demo-1");
  book.setTitle("Demo & Co");
  book.setLanguage("ru");
  const css = new EpubItem({ uid: "css", fileName: "style.css", mediaType: "text/css", content: "body{}" });
  book.addItem(css);
  book.setCover("cover.jpg", new Uint8Array([1, 2, 3, 4]));
  const page = new EpubHtml({ title: "Глава 1", fileName: "v1_c1.xhtml", lang: "ru" });
  page.content = "<p>Hello</p>";
  page.addItem(css);
  book.addItem(page);
  const title = new EpubHtml({ title: "Обложка", fileName: "title.xhtml", lang: "ru" });
  title.content = "<h1>Demo</h1>";
  title.addItem(css);
  book.addItem(title);
  book.toc = [{ title: "Том 1", children: [page] }];
  book.spine = [title, "nav", page];

  const bytes = writeEpub(book);
  const entry = firstEntry(bytes);
  assert.equal(entry.name, "mimetype");
  assert.equal(entry.method, 0);
  assert.equal(entry.extraLen, 0);
  assert.equal(entry.flags & 0x8, 0);
  const stored = new TextDecoder().decode(bytes.subarray(30 + entry.name.length, 30 + entry.name.length + 20));
  assert.equal(stored, "application/epub+zip");

  const files = unzipSync(bytes);
  const opf = strFromU8(files["OEBPS/content.opf"]);
  assert.match(opf, /Demo &amp; Co/);
  assert.match(opf, /id="nav"/);
  assert.match(opf, /properties="cover-image"/);
  assert.match(strFromU8(files["OEBPS/v1_c1.xhtml"]), /<p>Hello<\/p>/);
  assert.match(strFromU8(files["OEBPS/nav.xhtml"]), /Глава 1/);
  assert.equal(files["OEBPS/cover.jpg"].length, 4);
  assert.ok(files["META-INF/container.xml"]);
});
