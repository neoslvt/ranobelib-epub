import assert from "node:assert/strict";
import test from "node:test";
import { unzipSync, strFromU8 } from "fflate";
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
    ["ranobelib", "mangalib"],
  );
  assert.equal(matchCore("https://ranobelib.me/ru/1--demo").id, "ranobelib");
  assert.equal(matchCore("https://mangalib.me/catalog").id, "mangalib");
  assert.equal(matchCore("15--some-title").id, "ranobelib");
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
