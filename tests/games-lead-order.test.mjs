import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { prerenderToNodeStream } from "react-dom/static";
import { createServer } from "vite";
import { generate } from "../scripts/generate-scroll-posts.mjs";
import { games, gameStatusText, pickGames } from "../src/data/games.ts";

const ROOT = process.cwd();
const APP_ENTRY = "virtual:site-render-test-app";
const FRONTIER_LABEL = "Season 0 live 3 November 2026";
const TAKEN_DOWN_SLUG = "eternum-agent-first-design";

function read(relPath) {
  return readFileSync(join(ROOT, relPath), "utf8");
}

let vite;
let cacheDir;
const pages = {};
let takenDownRoute;

// Renders a route through the app's real router, loaders and components.
async function loadRoute(path, app) {
  const router = app.createRouter({
    routeTree: app.routeTree,
    context: { queryClient: app.queryClient },
    history: app.createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return router;
}

async function renderRoute(path, app) {
  const router = await loadRoute(path, app);

  const errors = [];
  const { prelude } = await prerenderToNodeStream(
    createElement(
      app.QueryClientProvider,
      { client: app.queryClient },
      createElement(app.RouterProvider, { router })
    ),
    {
      // Without this, React moves large sections to the end of the document.
      progressiveChunkSize: Infinity,
      onError: (error) => {
        errors.push(error);
      },
    }
  );
  let html = "";
  for await (const chunk of prelude) html += chunk;

  assert.deepEqual(errors, [], `Expected ${path} to render without errors`);
  assert.doesNotMatch(html, /<template id="B:/, `Expected no unfinished section on ${path}`);
  return html;
}

before(async () => {
  cacheDir = mkdtempSync(join(tmpdir(), "site-render-test-"));
  vite = await createServer({
    root: ROOT,
    configFile: false,
    cacheDir,
    mode: "production",
    appType: "custom",
    logLevel: "error",
    css: { postcss: { plugins: [] } },
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { "@": join(ROOT, "src") } },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    // Resolving these from inside the app gives the same router instance the routes use.
    plugins: [
      {
        name: "site-render-test-app",
        resolveId: (id) => (id === APP_ENTRY ? `\0${APP_ENTRY}` : null),
        load: (id) =>
          id === `\0${APP_ENTRY}`
            ? `export { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
               export { QueryClientProvider } from "@tanstack/react-query";
               export { queryClient } from "/src/lib/queryClient.ts";
               export { routeTree } from "/src/routeTree.gen.ts";`
            : null,
      },
    ],
  });

  // The staking hook logs on every render, which would bury the test report.
  const log = console.log;
  console.log = () => {};
  try {
    const app = await vite.ssrLoadModule(APP_ENTRY);
    pages.home = await renderRoute("/", app);
    pages.games = await renderRoute("/games", app);
    pages.frontier = await renderRoute("/games/frontier", app);
    pages.scroll = await renderRoute("/scroll", app);
    takenDownRoute = (await loadRoute(`/scroll/${TAKEN_DOWN_SLUG}`, app)).state;

    // The same route when a newer post, with no art of its own, takes the slot.
    const { scrollPosts } = await vite.ssrLoadModule("/src/generated/scroll-posts.ts");
    const { featureImage: _image, featureImageAlt: _alt, ...plain } = scrollPosts[0];
    scrollPosts.unshift({ ...plain, slug: "newer-dispatch", title: "A Newer Dispatch" });
    pages.scrollPlain = await renderRoute("/scroll", app);
    scrollPosts.shift();
  } finally {
    console.log = log;
  }
});

after(async () => {
  await vite?.close();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

function decode(html) {
  return html
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function between(html, start, end) {
  const from = html.indexOf(start);
  assert.notEqual(from, -1, `Expected "${start}" on the page`);
  const to = html.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `Expected "${end}" after "${start}"`);
  return html.slice(from + start.length, to);
}

// The page's group labels and card titles, in the order a visitor reads them.
function listing(html) {
  return [
    ...html.matchAll(/<(h2|h3|p)\b([^>]*)>([^<]*)<\/\1>/g),
  ]
    .filter(([, tag, attrs]) => tag !== "p" || attrs.includes("realm-banner"))
    .map(([, , , text]) => decode(text).trim());
}

function homeGames() {
  return between(pages.home, 'id="games"', 'id="economics"');
}

function gamesDirectory() {
  return pages.games.slice(pages.games.indexOf("</header>"));
}

// One card's markup: from its opening tag to the next card of the same kind.
function card(html, tag, title) {
  const found = html
    .split(`<${tag} `)
    .slice(1)
    .filter((part) => part.includes(`>${title}</h3>`));
  assert.equal(found.length, 1, `Expected one <${tag}> card titled ${title}`);
  return found[0];
}

function shownText(html) {
  return [...html.matchAll(/>([^<]+)</g)].map(([, text]) => decode(text).trim());
}

function imageClass(cardHtml) {
  const img = cardHtml.match(/<img\b[^>]*>/)[0];
  return img.match(/class="([^"]*)"/)[1].split(/\s+/);
}

test("/games lists Blitz, Frontier and Eternum above other studios' games", () => {
  assert.deepEqual(listing(gamesDirectory()), [
    "Realms Games",
    "Featured Game",
    "Realms: Blitz",
    "Realms: Frontier",
    "Realms: Eternum",
    "Games from Other Studios",
    "Loot Survivor",
    "zKube",
    "Pistols at Dawn",
  ]);
});

test("The home page lists Blitz, Frontier and Eternum above other studios' games", () => {
  assert.deepEqual(listing(homeGames()), [
    "REALMS GAMES",
    "Realms: Blitz",
    "Realms: Frontier",
    "Realms: Eternum",
    "GAMES FROM OTHER STUDIOS",
    "Loot Survivor",
    "zKube",
  ]);
});

test("Frontier's date shows on its home card and /games card, with no Live or Play Now", () => {
  for (const frontier of [
    card(homeGames(), "article", "Realms: Frontier"),
    card(gamesDirectory(), "button", "Realms: Frontier"),
  ]) {
    const shown = shownText(frontier);

    assert.ok(shown.includes(FRONTIER_LABEL), `Expected the label among ${shown}`);
    assert.ok(!shown.includes("Live"), "Expected no Live badge");
    assert.doesNotMatch(frontier, /Play Now/);
  }
});

test("Frontier's date shows on its page chip and Game Status card, with no Play Now", () => {
  const chip = between(pages.frontier, "</h1>", "How to Play");
  const statusCard = between(pages.frontier, "Game Status", 'id="frontier-day"');

  assert.ok(shownText(chip).includes(FRONTIER_LABEL), "Expected the label in the page chip");
  assert.ok(shownText(statusCard).includes(FRONTIER_LABEL), "Expected the label in the Game Status card");
  assert.doesNotMatch(pages.frontier, /Play Now/);
});

test("Other games keep their own status on the same surfaces", () => {
  assert.ok(shownText(card(homeGames(), "article", "Realms: Eternum")).includes("development"));
  assert.ok(shownText(card(gamesDirectory(), "button", "Realms: Eternum")).includes("development"));
  assert.ok(shownText(card(homeGames(), "article", "zKube")).includes("Live"));
});

test("Frontier's /games image sits below the chip, whole, on its own ground", () => {
  const frontier = imageClass(card(gamesDirectory(), "button", "Realms: Frontier"));
  const eternum = imageClass(card(gamesDirectory(), "button", "Realms: Eternum"));

  for (const name of ["object-contain", "pt-9", "bg-[#14101D]"]) {
    assert.ok(frontier.includes(name), `Expected ${name} among ${frontier}`);
  }
  assert.ok(!frontier.includes("object-cover"));
  assert.ok(eternum.includes("object-cover"));
  assert.ok(!eternum.includes("pt-9"));
});

test("Other studios' games stay in the data", () => {
  const slugs = games.map((game) => game.slug);

  for (const slug of [
    "loot-survivor",
    "zkube",
    "pistols-at-dawn",
    "dark-shuffle",
    "blob-arena",
    "rising-revenant",
  ]) {
    assert.ok(slugs.includes(slug), `Expected ${slug} to stay in games.ts`);
  }
});

test("Product pages do not present AI agents as live", () => {
  for (const path of [
    "src/routes/index.tsx",
    "src/routes/games/index.tsx",
    "src/data/games.ts",
    "src/components/layout/TopBar.tsx",
    "src/components/sections/IntroSection.tsx",
    "src/components/sections/EcosystemAtlasSection.tsx",
  ]) {
    assert.doesNotMatch(
      read(path),
      /\bAI agents?\b|humans and (their )?agents|Agent-Permissive|Agent Game|"agent-native"/i,
      `Expected no live agent claim in ${path}`
    );
  }
});

test("Home game cards never dim a game", () => {
  const atlas = read("src/components/sections/EcosystemAtlasSection.tsx");

  assert.doesNotMatch(homeGames(), /Coming Soon/);
  for (const title of ["Realms: Frontier", "Realms: Eternum", "Loot Survivor", "zKube"]) {
    const articleClass = card(homeGames(), "article", title).match(/class="([^"]*)"/)[1];
    assert.doesNotMatch(articleClass, /opacity-\d/);
  }
  assert.match(atlas.match(/<motion\.article[\s\S]*?>/)[0], /animate=\{\{ opacity: 1, y: 0 \}\}/);
});

test("Home game card links keep a touch-sized target", () => {
  const links = [...homeGames().matchAll(/<a\b[^>]*class="([^"]*)"[^>]*>(Play Now|Details)/g)];

  // Every card has Details, and live games add Play Now.
  assert.ok(links.length >= 4, `Expected a link on every card, found ${links.length}`);
  for (const [, className] of links) {
    assert.match(className, /(^|\s)min-h-11(\s|$)/);
  }
});

test("The hero has two actions and a still gold title", () => {
  const hero = between(pages.home, 'id="hero"', 'id="games"');
  const actions = [...hero.matchAll(/<a\b[^>]*>([^<]+)<\/a>/g)].map(([, text]) => text.trim());
  const title = hero.match(/<h1\b[^>]*class="([^"]*)"[^>]*>([^<]*)<\/h1>/);

  assert.deepEqual(actions, ["Explore Games", "Stake veLORDS"]);
  assert.equal(title[2], "THE NEW FRONTIER OF GAMING");
  assert.ok(title[1].split(/\s+/).includes("text-[#F3D08A]"));
  assert.doesNotMatch(read("src/index.css"), /hero-shimmer|hero-title-shimmer/);
});

test("The hero counts the Realms games", () => {
  const hero = between(pages.home, 'id="hero"', 'id="games"');

  assert.match(hero, />Realms Games<\/[a-z0-9]+>\s*<[a-z0-9]+\b[^>]*>3</);
});

test("Frontier's list cards reach the mist and the price", () => {
  const summary =
    "Explore a new map each day. At the day's end the mist takes the map and every army. Your realm keeps all it earned. Free to play.";

  for (const frontier of [
    card(homeGames(), "article", "Realms: Frontier"),
    card(gamesDirectory(), "button", "Realms: Frontier"),
  ]) {
    assert.ok(decode(frontier).includes(`>${summary}</p>`), "Expected the summary, not the description");
  }
});

test("The footer does not call the ecosystem autonomous", () => {
  assert.doesNotMatch(read("src/components/sections/FooterSection.tsx"), /autonomous/i);
});

test("Frontier has its season label and is not live yet", () => {
  const [frontier] = pickGames(["frontier"]);

  assert.equal(frontier.statusLabel, FRONTIER_LABEL);
  assert.equal(frontier.status, undefined);
  assert.equal(frontier.isLive, false);
});

test("Only Frontier has a status label, and other games keep their status", () => {
  for (const game of games.filter((entry) => entry.slug !== "frontier")) {
    assert.equal(game.statusLabel, undefined);
    assert.equal(gameStatusText(game), game.status);
  }
});

test("The hero states the approved position, and no page names a year after 2026", () => {
  const hero = between(pages.home, 'id="hero"', 'id="games"');
  const laterYear = /\b20(2[7-9]|[3-9]\d)\b/;

  assert.ok(
    decode(hero).includes(
      ">The Realms gaming ecosystem is focused on the development of fun, strategic and engaging AI-native onchain games. We develop games to accept the use of AI and encourage all users to maximise their gaming capabilities, bounded by the rules enforced by blockchain.</p>"
    ),
    "Expected the approved paragraph in the hero"
  );
  for (const [name, html] of Object.entries(pages)) {
    assert.doesNotMatch(html, laterYear, `Expected no later year on ${name}`);
  }
  for (const path of ["src/data/games.ts", "src/components/game/FrontierGuide.tsx"]) {
    assert.doesNotMatch(read(path), laterYear, `Expected no later year in ${path}`);
  }
});

test("The home page has no hex section", () => {
  assert.doesNotMatch(pages.home, /id="hex-explorer"|Interactive hex grid explorer|Skip interactive section|<canvas/);
  assert.equal(existsSync(join(ROOT, "src/components/hex-explorer")), false);
  assert.match(pages.home, /id="hero"[\s\S]*id="games"/);
});

function scrollFeature(html) {
  return between(html, "scroll-codex-feature", "scroll-codex-feed");
}

test("/scroll shows the newest lore entry as a feature with its art, alt text and link", () => {
  const feature = scrollFeature(pages.scroll);
  const images = feature.match(/<img\b[^>]*>/g);
  assert.equal(images.length, 1);
  assert.match(images[0], /src="\/lore\/history-of-lost-worlds\/lost-worlds-feature\.webp"/);
  assert.match(
    decode(images[0]),
    /alt="A cloaked figure on a ridge of black basalt reaches toward a dark orb wrapped in blue and orange lightning, beneath falling shards of rock\."/
  );
  const link = pages.scroll.slice(pages.scroll.lastIndexOf("<a ", pages.scroll.indexOf("scroll-codex-feature")));
  assert.match(link.match(/^<a\b[^>]*>/)[0], /href="\/scroll\/history-of-lost-worlds"/);
  assert.ok(shownText(feature).includes("A History of Lost Worlds"));
  assert.ok(existsSync(join(ROOT, "public/lore/history-of-lost-worlds/lost-worlds-feature.webp")));
});

test("/scroll's feature art keeps the post's title first and stays out of the feed", () => {
  const feature = scrollFeature(pages.scroll);
  assert.ok(feature.indexOf("<h2") < feature.indexOf("<img"), "Expected the link to read its title before the alt text");
  assert.doesNotMatch(pages.scroll.slice(pages.scroll.indexOf("scroll-codex-feed")), /lost-worlds-feature\.webp/);
});

test("A newer post with no feature art takes the slot with no image", () => {
  const feature = scrollFeature(pages.scrollPlain);
  assert.ok(shownText(feature).includes("A Newer Dispatch"));
  assert.doesNotMatch(feature, /<img\b/);
  assert.doesNotMatch(pages.scrollPlain, /lost-worlds-feature\.webp/);
});

test("A post cannot set feature art without alt text", async () => {
  const root = mkdtempSync(join(tmpdir(), "scroll-feature-"));
  try {
    mkdirSync(join(root, "content/scroll"), { recursive: true });
    const post = (extra) => `---\ntitle: "T"\nexcerpt: "E"\ndate: "2026-01-01"\ntype: "lore"\nauthor: "A"\ntags: []\npublished: true\n${extra}---\nBody\n`;
    writeFileSync(join(root, "content/scroll/2026-01-01-a.md"), post('featureImage: "/a.webp"\n'));
    await assert.rejects(generate(root), /featureImage needs featureImageAlt/);
    writeFileSync(join(root, "content/scroll/2026-01-01-a.md"), post('featureImage: "/a.webp"\nfeatureImageAlt: "An a"\n'));
    await generate(root);
    assert.match(readFileSync(join(root, "src/generated/scroll-posts.ts"), "utf8"), /"featureImageAlt": "An a"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/scroll does not list the taken-down post", () => {
  assert.ok(shownText(pages.scroll).includes("The Infrastructure Stack Powering Autonomous Worlds"));
  assert.doesNotMatch(pages.scroll, /eternum-agent-first-design|Agents First|built for them/);
});

test("The taken-down post's old address redirects to /scroll", () => {
  assert.equal(takenDownRoute.redirect?.options.href, "/scroll");
  assert.equal(takenDownRoute.statusCode, 301);
  assert.deepEqual(
    JSON.parse(read("vercel.json")).redirects.find((entry) => entry.source === `/scroll/${TAKEN_DOWN_SLUG}`),
    { source: `/scroll/${TAKEN_DOWN_SLUG}`, destination: "/scroll", permanent: true }
  );
});

test("The taken-down post is not in what the site ships", () => {
  assert.equal(existsSync(join(ROOT, `content/scroll/2026-02-12-${TAKEN_DOWN_SLUG}.md`)), false);
  assert.doesNotMatch(read("src/generated/scroll-posts.ts"), /eternum-agent-first-design|Agents First|built for them/);
  assert.doesNotMatch(read("public/sitemap.xml"), /eternum-agent-first-design/);
});
