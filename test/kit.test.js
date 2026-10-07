import assert from "node:assert/strict";
import test from "node:test";
import { EpubBook } from "../src/cores/epub.js";
import {
  buildInfo,
  chapterFile,
  epubName,
  fnum,
  mapHit,
  pmHtml,
  sameBranch,
  splitMarkers,
  tidy,
} from "../src/cores/kit.js";
import { pool, sleep, withParams } from "../src/cores/http.js";

test("sameBranch treats empty, null, and numeric strings as the same id", () => {
  assert.equal(sameBranch(null, ""), true);
  assert.equal(sameBranch("null", null), true);
  assert.equal(sameBranch("12", 12), true);
  assert.equal(sameBranch("012", 12), true);
  assert.equal(sameBranch("-3", -3), true);
  assert.equal(sameBranch("1.5", 1), false);
  assert.equal(sameBranch("1.5", 1.5), true);
  assert.equal(sameBranch("team", "other"), false);
  assert.equal(sameBranch(true, false), false);
});

test("pmHtml renders marks, images, and unknown wrappers", () => {
  const html = pmHtml(
    {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello & <bye>", marks: [{ type: "bold" }, { type: "italic" }] }],
        },
        { type: "image", attrs: { images: [{ image: "pic" }, { image: "missing" }] } },
        { type: "hardBreak" },
      ],
    },
    { pic: "https://cdn.example/pic.jpg" },
  );
  assert.equal(
    html,
    '<p><em><strong>Hello &amp; &lt;bye&gt;</strong></em></p><img src="https://cdn.example/pic.jpg"/><br/>',
  );
});

test("catalog helpers match the site payload shape", () => {
  assert.deepEqual(
    mapHit({
      slug_url: "1--name",
      rus_name: "Имя",
      eng_name: "Name",
      cover: { thumbnail: "https://cdn.example/t.jpg" },
      type: { label: "Japan" },
      releaseDateString: "2020" ,
      rating: { averageFormated: "8.5" },
      status: { label: "Ongoing" },
    }),
    {
      slug: "1--name",
      title: "Имя",
      alt: "Name",
      cover: "https://cdn.example/t.jpg",
      type: "Japan",
      year: "2020",
      rating: "8.5",
      status: "Ongoing",
    },
  );
  const info = buildInfo(
    {
      rus_name: "Имя",
      eng_name: "Name",
      rating: { averageFormated: "9", votesFormated: "10" },
      genres: [{ rus_name: "Фэнтези" }],
      authors: [{ name: "Author" }],
    },
    "10--some-title",
    [
      { volume: 2, branches: [{ branch_id: null, teams: [] }] },
      { volume: 1, branches: [{ branch_id: 4, teams: [{ name: "Team A" }] }] },
    ],
  );
  assert.equal(info.title, "Имя");
  assert.deepEqual(info.volumes, [
    { v: "1", n: 1 },
    { v: "2", n: 1 },
  ]);
  assert.equal(info.branches[0].id, "");
  assert.equal(info.branches[0].name, "Default");
  assert.equal(info.branches[1].name, "Team A");
  assert.equal(info.facts.find(([key]) => key === "Rating")[1], "9 (10 votes)");
});

test("pool keeps result order while work overlaps", async () => {
  const out = await pool(3, [1, 2, 3, 4], async (n) => {
    await sleep(n === 1 ? 20 : 0);
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8]);
});

test("file names and query strings stay portable", () => {
  assert.equal(fnum("1.5"), 1.5);
  assert.equal(fnum("nope"), 0);
  assert.equal(chapterFile(1, "2.5", 0), "v1_c2-5.xhtml");
  assert.equal(chapterFile(1, 2, 3), "v1_c2_p3.xhtml");
  assert.equal(epubName('A/B: "C"'), "AB C.epub");
  assert.equal(
    withParams("https://api.cdnlibs.org/api/manga", {
      q: "solo",
      "site_id[]": 3,
      "fields[]": ["rate_avg", "releaseDate"],
      skip: null,
    }),
    "https://api.cdnlibs.org/api/manga?q=solo&site_id%5B%5D=3&fields%5B%5D=rate_avg&fields%5B%5D=releaseDate",
  );
});

test("tidy pulls images onto markers and marks scene breaks", async () => {
  const book = new EpubBook();
  const out = await tidy(
    "<p>Hello</p><p><img src=\"//cdn.example/a.png\"></p><p>* * *</p><p>   </p>",
    book,
    { n: 0 },
    async () => ({ bytes: new Uint8Array([1, 2, 3]) }),
  );
  assert.match(out, /<!--IMG:images\/img_1\.png-->/);
  assert.match(out, /class="scene"/);
  assert.match(out, /\* \* \*/);
  assert.equal(out.includes("<img"), false);
  assert.equal(book.items.length, 1);
  assert.equal(book.items[0].fileName, "images/img_1.png");
  assert.deepEqual(splitMarkers(out).filter((_, i) => i % 2), ["images/img_1.png"]);
});

test("cores stay free of Node built-ins", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = new URL("../src/cores/", import.meta.url);
  const names = await readdir(dir);
  const allowed = new Set(["fflate", "node-html-parser"]);
  for (const name of names) {
    const text = await readFile(new URL(name, dir), "utf8");
    assert.equal(text.includes("node:"), false, name);
    assert.equal(text.includes("import.meta"), false, name);
    assert.equal(/\bBuffer\b/.test(text), false, name);
    assert.equal(/\bprocess\./.test(text), false, name);
    assert.equal(/\brequire\(/.test(text), false, name);
    for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) {
      const spec = match[1];
      assert.equal(spec.startsWith(".") || allowed.has(spec), true, `${name} imports ${spec}`);
    }
  }
  assert.equal(typeof join, "function");
});
