// scraper.js
require("dotenv").config();
const { chromium } = require("playwright");
const fs = require("fs").promises;
const path = require("path");
const pdfParse = require("pdf-parse");
const { createClient } = require("@supabase/supabase-js");

// initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function scrapeCourt() {
  const DOWNLOAD_DIR = path.join(__dirname, "downloads");
  const MAX_RETRIES = 3;
  const TEXT_EXTRACT_LIMIT = 10000;

  console.log("🚀 Starting Supreme Court judgment scraper");
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
    ],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      acceptDownloads: true,
      downloadsPath: DOWNLOAD_DIR,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    });

    // block images/fonts/styles to speed up loading
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "stylesheet", "font"].includes(type)) return route.abort();
      return route.continue();
    });

    console.log("Navigating to judgment search page...");
    const page = await context.newPage();

    context.on("request", (req) =>
      console.debug(`>> ${req.method()} ${req.url().slice(0, 100)}...`)
    );
    context.on("requestfailed", (req) =>
      console.error(
        `❌ Failed request: ${req.url().slice(0, 100)} - ${
          req.failure()?.errorText
        }`
      )
    );

    // initial navigation: wait for DOMContentLoaded
    await page.goto("https://supremecourt.govmu.org/judgment-search", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    const visited = new Set();
    const queue = [];
    let currentPage = 1;
    let totalFiles = 0;

    while (true) {
      console.log(`\n📄 Processing page ${currentPage}`);

      // discover new pages
      const pager = page.locator(
        "ul.pager__items.js-pager__items li.pager__item a"
      );
      const count = await pager.count();
      for (let i = 0; i < count; i++) {
        const anchor = pager.nth(i);
        const raw = await anchor.textContent();
        const pageNum = parseInt(raw.trim().split(/\s+/).pop(), 10);
        if (pageNum > currentPage && !visited.has(pageNum)) {
          visited.add(pageNum);
          queue.push(pageNum);
        }
      }

      // wait only for table rows
      await page.waitForSelector("tbody tr", {
        state: "visible",
        timeout: 30000,
      });

      const downloads = page.locator("div.nothingCell a.faDownload");
      const dcount = await downloads.count();
      console.log(`  Found ${dcount} files`);

      for (let i = 0; i < dcount; i++) {
        const link = downloads.nth(i);
        const row = link.locator("xpath=ancestor::tr");
        const caseNumber = (
          await row.locator("td").nth(0).textContent()
        ).trim();
        const caseTitle = (await row.locator("td").nth(1).textContent()).trim();
        let judgmentDate = await row
          .locator("td.views-field-field-delivered-on a")
          .textContent();
        judgmentDate = judgmentDate?.trim();

        let formattedDate = null;
        if (judgmentDate?.includes("/")) {
          const [day, month, year] = judgmentDate.split("/");
          formattedDate = `${year}-${month.padStart(2, "0")}-${day.padStart(
            2,
            "0"
          )}`;
        }
        if (!formattedDate) {
          console.warn(
            `⚠️ Skipping ${caseNumber} - bad date: "${judgmentDate}"`
          );
          continue;
        }

        console.log(`  🔍 ${caseNumber} - ${caseTitle}`);
        let success = false,
          retries = 0,
          filePath;

        while (!success && retries < MAX_RETRIES) {
          try {
            const dlPromise = page.waitForEvent("download", { timeout: 30000 });
            await link.click();
            const download = await dlPromise;
            filePath = await download.path();
            console.log(`  ⬇️ saved ${download.suggestedFilename()}`);
            success = true;

            const pdf = await extractPdfContent(filePath, TEXT_EXTRACT_LIMIT);
            const { data, error } = await supabase.from("judgments").insert([
              {
                case_number: caseNumber,
                case_title: caseTitle,
                judgment_date: formattedDate,
                file_name: download.suggestedFilename(),
                content: pdf.text,
                page_count: pdf.pageCount,
                metadata: pdf.metadata,
                page_number: currentPage,
                extracted_at: new Date().toISOString(),
                download_url: await link.getAttribute("href"),
              },
            ]);
            if (error) console.error("Supabase error:", error);
            else console.log(`  ✅ inserted id ${data[0].id}`);

            await fs.unlink(filePath);
          } catch (e) {
            retries++;
            console.error(`  ⚠️ retry ${retries}: ${e.message}`);
            await page.waitForTimeout(2000 * retries);
          }
        }
      }

      if (!queue.length) break;
      currentPage = queue.shift();

      // navigate with domcontentloaded
      await Promise.all([
        page.waitForNavigation({
          waitUntil: "domcontentloaded",
          timeout: 60000,
        }),
        page.click(
          `ul.pager__items.js-pager__items li.pager__item a[href*="page=${currentPage}"]`
        ),
      ]).catch(async () => {
        await page.goto(
          `https://supremecourt.govmu.org/judgment-search?page=${currentPage}`,
          { waitUntil: "domcontentloaded", timeout: 60000 }
        );
      });
    }

    console.log(`\n✅ Done. Processed ${totalFiles}`);
  } finally {
    await browser.close();
  }
}

async function extractPdfContent(filePath, limit) {
  const buf = await fs.readFile(filePath);
  const data = await pdfParse(buf);
  return {
    text: data.text.slice(0, limit),
    pageCount: data.numpages,
    metadata: {
      info: data.info,
      version: data.version,
      encrypted: data.encrypted,
    },
  };
}

scrapeCourt().catch((e) => {
  console.error(e);
  process.exit(1);
});
