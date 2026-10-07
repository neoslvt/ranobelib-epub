import assert from "node:assert/strict";
import test from "node:test";
import { unzipSync, strFromU8 } from "fflate";
import { CoreError } from "../src/cores/base.js";
import { MangaHub } from "../src/cores/mangahub.js";
import { MangaLib } from "../src/cores/mangalib.js";
import { RanobeLib } from "../src/cores/ranobelib.js";
import { allCores, matchCore } from "../src/cores/index.js";

function jsonResponse(data) {
  return {
    status: 200,
    bytes: new TextEncoder().encode(JSON.stringify(data)),
    headers: { get: () => "application/json" },
    json: () => data,
    text: () => JSON.stringify(data),
  };
}

function imageResponse(bytes, type) {
  return {
    status: 200,
    bytes,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? type : null) },
    json: () => {
      throw new Error("not json");
    },
    text: () => "",
  };
}

test("ambiguous slugs prefer the longer ranobelib pattern", () => {
  assert.deepEqual(
    allCores().map((core) => core.id),
    ["ranobelib", "mangalib", "mangahub"],
  );
  assert.equal(matchCore("https://ranobelib.me/ru/1--demo").id, "ranobelib");
  assert.equal(matchCore("https://mangalib.me/catalog").id, "mangalib");
  assert.equal(matchCore("15--some-title").id, "ranobelib");
  assert.equal(matchCore("https://mangahub.ru/title/made_in_abyss").id, "mangahub");
  assert.equal(matchCore("https://mangahub.ru/read/764191").id, "mangahub");
  assert.equal(matchCore("not a link"), null);
});

test("ranobelib builds an epub from prose and one illustration", async () => {
  const core = new RanobeLib();
  core.chapterPause = 0;
  const image = new Uint8Array([9, 8, 7]);
  core.http.get = async (url) => {
    if (url.includes("/chapters")) {
      return jsonResponse({
        data: [{ volume: 1, number: 1, name: "Start", branches: [{ branch_id: 5, teams: [{ name: "Team" }] }] }],
      });
    }
    if (url.includes("/chapter")) {
      return jsonResponse({
        data: {
          content: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
              { type: "image", attrs: { images: [{ image: "pic" }] } },
            ],
          },
          attachments: [{ id: "pic", url: "/uploads/pic.jpg" }],
        },
      });
    }
    if (url.includes("/uploads/pic.jpg")) return imageResponse(image, "image/jpeg");
    if (url.includes("cover.jpg")) return imageResponse(new Uint8Array([1]), "image/jpeg");
    return jsonResponse({
      data: { rus_name: "Название", eng_name: "Name", cover: { default: "https://cdn.example/cover.jpg" } },
    });
  };

  const info = await core.info("https://ranobelib.me/ru/9--demo");
  assert.equal(info.slug, "9--demo");
  assert.equal(info.title, "Название");
  assert.equal(info.branches[0].id, 5);

  const job = { done: 0, total: 0, msg: "" };
  const result = await core.build(job, {
    slug: info.slug,
    title: info.title,
    cover: info.cover,
    branch: "5",
    team: "Team",
    volumes: ["1"],
  });
  assert.equal(job.done, 1);
  assert.equal(result.filename, "Название · Том 1.epub");
  const files = unzipSync(result.bytes);
  const chapter = strFromU8(files["OEBPS/v1_c1.xhtml"]);
  assert.match(chapter, /Hello/);
  assert.match(strFromU8(files["OEBPS/v1_c1_p1.xhtml"]), /images\/img_1\.jpg/);
  assert.equal(files["OEBPS/images/img_1.jpg"].length, 3);
  assert.match(strFromU8(files["OEBPS/content.opf"]), /Название/);
});

test("mangalib builds an epub from page images", async () => {
  const core = new MangaLib();
  core.chapterPause = 0;
  core.http.get = async (url) => {
    if (url.includes("/constants")) {
      return jsonResponse({
        data: { imageServers: [{ id: "download", site_ids: [1], url: "https://img.example/" }] },
      });
    }
    if (url.includes("/chapters")) {
      return jsonResponse({
        data: [{ volume: 3, number: 2, name: "Page", branches: [{ branch_id: 1, teams: [{ name: "Scan" }] }] }],
      });
    }
    if (url.includes("/chapter")) {
      return jsonResponse({ data: { pages: [{ slug: 2, url: "/manga/b.jpg" }, { slug: 1, url: "/manga/a.jpg" }] } });
    }
    if (url.includes("https://img.example/manga/")) return imageResponse(new Uint8Array([4, 5]), "image/jpeg");
    if (url.includes("cover")) return imageResponse(new Uint8Array([6]), "image/jpeg");
    return jsonResponse({ data: { rus_name: "Манга", cover: { default: "https://cdn.example/cover.jpg" } } });
  };

  const job = { done: 0, total: 0, msg: "" };
  const result = await core.build(job, {
    slug: "4--manga",
    title: "Манга",
    cover: "https://cdn.example/cover.jpg",
    branch: 1,
    team: "Scan",
    volumes: [3],
  });
  assert.equal(job.total, 1);
  const files = unzipSync(result.bytes);
  assert.match(strFromU8(files["OEBPS/v3_c2.xhtml"]), /Глава 2: Page/);
  assert.match(strFromU8(files["OEBPS/v3_c2_p1.xhtml"]), /Страница|pic/);
  assert.equal(files["OEBPS/images/img_1.jpg"].length, 2);
  assert.equal(files["OEBPS/images/img_2.jpg"].length, 2);
  assert.match(strFromU8(files["OEBPS/content.opf"]), /manga-4--manga-3/);
});

test("mangalib explains when a volume is paid and has no pages", async () => {
  const core = new MangaLib();
  core.chapterPause = 0;
  core.http.get = async (url) => {
    if (url.includes("/constants")) {
      return jsonResponse({
        data: { imageServers: [{ id: "download", site_ids: [1], url: "https://img.example/" }] },
      });
    }
    if (url.includes("/chapters")) {
      return jsonResponse({
        data: [{ volume: "1", number: "1", name: "", branches: [{ branch_id: null, teams: [{ name: "AST" }] }] }],
      });
    }
    if (url.includes("/chapter")) {
      return jsonResponse({
        data: { bundle: { id: 191, name: "Том 1", price: 349, is_open: false } },
      });
    }
    return jsonResponse({ data: { rus_name: "Созданный в Бездне" } });
  };

  const job = { done: 0, total: 0, msg: "" };
  await assert.rejects(
    () =>
      core.build(job, {
        slug: "267369--made-in-abyss-sozdannyi-v-bezdne",
        title: "Созданный в Бездне",
        branch: "",
        team: "AST",
        volumes: ["1"],
      }),
    (err) => err instanceof CoreError && /paid volume/.test(err.message),
  );
});

function htmlResponse(html) {
  return {
    status: 200,
    bytes: new TextEncoder().encode(html),
    headers: { get: () => "text/html" },
    json: () => {
      throw new Error("not json");
    },
    text: () => html,
  };
}

const HUB_SEARCH = `
<ul>
  <li class="header-search-item">
    <a href="/title/made_in_abyss">
      <img src="https://img.example/cover.png" alt="Созданный в бездне" />
      <div class="text-line-clamp fw-bold">Созданный в бездне / Made in Abyss</div>
      <div class="text-muted me-2">2012</div>
      <div class="text-muted">Манга</div>
    </a>
  </li>
</ul>`;

const HUB_TITLE = `
<h1 class="mb-1">Созданный в бездне</h1>
<div class="fs-2 text-muted"><span>манга</span><span>2012</span><span>онгоинг</span><span>18+</span></div>
<meta property="og:image" content="https://img.example/cover.png" />
<div class="text-expandable-content"><p>Огромная пещера.</p></div>
<a class="tag" href="/genre/fantasy">Фэнтези</a>
<a class="tag" href="/tags/monstry">#Монстры</a>
<div class="attrs">
  <div class="attr"><div class="attr-name">Автор</div><div class="attr-value"><a href="/person/tsukusi">Цукуси Акихито</a></div></div>
  <div class="attr"><div class="attr-name">Переводчики</div><div class="attr-value"><a href="/team/animeread">Animeread</a></div></div>
  <div class="attr"><div class="attr-name">Издательство</div><div class="attr-value"><a href="/publisher/takeshobo">Takeshobo</a></div></div>
  <div class="attr"><div class="attr-name">Другие названия</div><div class="attr-value">Made in Abyss / Meido in Abisu</div></div>
  <div class="attr"><div class="attr-name">Перевод</div><div class="attr-value">Продолжается</div></div>
</div>
<span class="rating-star-rate">9.8</span><span class="rating-star-votes">77</span>`;

const HUB_CHAPTERS = `
<div data-targets="chapter-list.chapters">
  <a href="/read/20"><span class="text-truncate">Том 2. Глава 3 - Дальше<span class="d-none"> extra</span></span></a>
</div>
<div data-targets="chapter-list.chapters">
  <a href="/read/10"><span class="text-truncate">Том 1. Глава 1.5 - Старт</span></a>
</div>
<a href="/read/10">Начать читать</a>`;

const HUB_READER = `
<reader-scan class="reader-viewer-scan"><img data-src="//img.example/b.jpg" /></reader-scan>
<reader-scan class="reader-viewer-scan"><img data-src="//img.example/a.jpg" /></reader-scan>`;

test("mangahub reads a title page and builds page images", async () => {
  const core = new MangaHub();
  core.chapterPause = 0;
  core.http.get = async (url) => {
    if (url.includes("/suggestions")) return htmlResponse(HUB_SEARCH);
    if (url.includes("/chapters")) return htmlResponse(HUB_CHAPTERS);
    if (url.includes("/title/")) return htmlResponse(HUB_TITLE);
    if (url.includes("/read/")) return htmlResponse(HUB_READER);
    if (url.includes("img.example")) return imageResponse(new Uint8Array([4, 5]), "image/jpeg");
    return null;
  };

  const hits = await core.search("бездна");
  assert.equal(hits[0].slug, "made_in_abyss");
  assert.equal(hits[0].title, "Созданный в бездне");
  assert.equal(hits[0].alt, "Made in Abyss");
  assert.equal(hits[0].year, "2012");

  const info = await core.info("https://mangahub.ru/title/made_in_abyss");
  assert.equal(info.slug, "made_in_abyss");
  assert.equal(info.title, "Созданный в бездне");
  assert.equal(info.alt, "Made in Abyss");
  assert.deepEqual(info.other, ["Meido in Abisu"]);
  assert.deepEqual(info.authors, ["Цукуси Акихито"]);
  assert.deepEqual(info.genres, ["Фэнтези"]);
  assert.deepEqual(info.tags, ["Монстры"]);
  assert.equal(info.branches[0].name, "Animeread");
  assert.equal(info.facts.find(([key]) => key === "Year")[1], "2012");
  assert.equal(info.facts.find(([key]) => key === "Publisher")[1], "Takeshobo");
  assert.deepEqual(info.volumes, [
    { v: "1", n: 1 },
    { v: "2", n: 1 },
  ]);
  assert.match(info.summary, /Огромная пещера/);

  const job = { done: 0, total: 0, msg: "" };
  const result = await core.build(job, {
    slug: info.slug,
    title: info.title,
    cover: info.cover,
    branch: null,
    team: "Animeread",
    volumes: ["1"],
  });
  assert.equal(job.total, 1);
  assert.equal(result.filename, "Созданный в бездне · Том 1.epub");
  const files = unzipSync(result.bytes);
  assert.match(strFromU8(files["OEBPS/v1_c1-5.xhtml"]), /Глава 1.5: Старт/);
  assert.match(strFromU8(files["OEBPS/v1_c1-5_p1.xhtml"]), /images\/img_2\.jpg/);
  assert.equal(files["OEBPS/images/img_1.jpg"].length, 2);
});
