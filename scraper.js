require("dotenv").config();
const axios = require("axios");
const { chromium } = require("playwright");
const fs = require("fs").promises;
const path = require("path");
const pdfParse = require("pdf-parse");
const { createClient } = require("@supabase/supabase-js");

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Fetch proxy list from Geonode
async function getProxiesFromGeoNode() {
  const url =
    process.env.GEONODE_URL ||
    "https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc";
  try {
    const res = await axios.get(url);
    return res.data.data
      .filter((p) => p.protocols.includes("http"))
      .map((p) => `http://${p.ip}:${p.port}`);
  } catch (err) {
    console.error("❌ Failed to fetch proxies from GeoNode:", err.message);
    return [];
  }
}

// Extract text from PDF
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

// Main scraper function per proxy
async function CourtScraper(proxy) {
  const DOWNLOAD_DIR = path.join(__dirname, "downloads");
  const MAX_RETRIES = 3;
  const TEXT_EXTRACT_LIMIT = 10000;
  let browser = null;

  try {
    console.log(`🚀 Trying proxy: ${proxy}`);
    await fs.mkdir(DOWNLOAD_DIR, { recursive: true });

    browser = await chromium.launch({
      headless: true,
      proxy: { server: proxy },
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      acceptDownloads: true,
      downloadsPath: DOWNLOAD_DIR,
    });

    const page = await context.newPage();
    await page.goto("https://supremecourt.govmu.org/judgment-search", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    console.log(`✅ Successfully opened page with proxy: ${proxy}`);

    const visited = new Set();
    const queue = [];
    let currentPage = 1;
    let totalFiles = 0;

    while (true) {
      console.log(`\n📄 Processing page ${currentPage}`);

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

        let caseNumber = (await row.locator("td").nth(0).textContent()).trim();
        let caseTitle = (await row.locator("td").nth(1).textContent()).trim();
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

            if (error) {
              console.error("Supabase error:", error);
            } else {
              console.log(`  ✅ inserted id ${data[0].id}`);
            }

            await fs
              .unlink(filePath)
              .catch((e) => console.error("⚠️ Failed to delete temp file:", e));
          } catch (e) {
            retries++;
            console.error(`  ⚠️ Retry ${retries}:`, e.message);
            await page.waitForTimeout(2000 * retries);
          }
        }
      }

      if (!queue.length) break;
      currentPage = queue.shift();

      console.log(`🔄 Navigating to page ${currentPage}...`);
      await Promise.all([
        page.waitForNavigation({
          waitUntil: "domcontentloaded",
          timeout: 60000,
        }),
        page.click(
          `ul.pager__items.js-pager__items li.pager__item a[href*="page=${currentPage}"]`
        ),
      ]).catch(async () => {
        console.log("⚠️ Navigation failed, trying direct URL...");
        await page.goto(
          `https://supremecourt.govmu.org/judgment-search?page=${currentPage}`,
          {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          }
        );
      });
    }

    console.log(`\n✅ Done.`);
    await browser.close();
    return true;
  } catch (e) {
    console.error(`❌ Proxy ${proxy} failed → ${e.message}`);
    if (browser) await browser.close();
    return false;
  }
}

(async () => {
  const proxies = await getProxiesFromGeoNode();
  if (!proxies.length) {
    console.error("💥 No proxies available. Exiting.");
    process.exit(1);
  }

  for (const proxy of proxies) {
    const success = await CourtScraper(proxy);
    if (success) {
      console.log("🎉 Scraper finished successfully.");
      process.exit(0);
    }
  }

  console.error("💥 All proxies failed. Exiting with error.");
  process.exit(1);
})();
