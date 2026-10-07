import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Core } from "../src/cores/base.js";
import { EpubBook, EpubHtml, writeEpub } from "../src/cores/epub.js";
import { createApp } from "../src/server.js";

test("http api lists sources, runs a build, and serves the file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "repub-"));
  process.env.REPUB_LIBRARY = dir;
  const stub = new Core();
  stub.id = "stub";
  stub.name = "Stub";
  stub.linkRe = "stub\\.test";
  stub.search = async () => [{ slug: "1--a", title: "A" }];
  stub.info = async () => ({ title: "A", slug: "1--a", volumes: [], branches: [], chapters: 0 });
  stub.build = async (job) => {
    job.total = 1;
    job.done = 1;
    const book = new EpubBook();
    book.setIdentifier("stub");
    book.setTitle("A");
    book.setLanguage("ru");
    const page = new EpubHtml({ title: "A", fileName: "a.xhtml", lang: "ru" });
    page.content = "<p>A</p>";
    book.addItem(page);
    book.spine = [page, "nav"];
    book.toc = [page];
    return { filename: "A.epub", bytes: writeEpub(book) };
  };

  const app = await createApp({ extra: [stub] });
  try {
    const page = await (await fetch(`${app.url}/`)).text();
    assert.match(page, /RanobeLib/);
    assert.match(page, /value="stub"/);

    const cores = await (await fetch(`${app.url}/api/cores`)).json();
    assert.ok(cores.some((core) => core.id === "mangalib"));

    const matched = await (await fetch(`${app.url}/api/match?q=stub.test`)).json();
    assert.equal(matched.core, "stub");

    const found = await (await fetch(`${app.url}/api/search?core=stub&q=a`)).json();
    assert.equal(found[0].title, "A");
    assert.equal(found[0].source, "Stub");

    const missing = await fetch(`${app.url}/api/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ core: "nope" }),
    });
    assert.equal(missing.status, 404);

    const started = await fetch(`${app.url}/api/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ core: "stub", slug: "1--a", title: "A", volumes: ["1"], team: "T" }),
    });
    const { id } = await started.json();
    let progress;
    for (let i = 0; i < 20; i++) {
      progress = await (await fetch(`${app.url}/api/progress/${id}`)).json();
      if (progress.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(progress.state, "done");
    assert.equal(progress.file, "A.epub");

    const library = await (await fetch(`${app.url}/api/library`)).json();
    assert.equal(library[0].name, "A.epub");
    const file = await fetch(`${app.url}/api/file/${encodeURIComponent("A.epub")}`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get("content-type"), /epub/);
    assert.ok((await file.arrayBuffer()).byteLength > 20);

    const unknown = await (await fetch(`${app.url}/api/progress/missing`)).json();
    assert.equal(unknown.msg, "Unknown job");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
    delete process.env.REPUB_LIBRARY;
  }
});
