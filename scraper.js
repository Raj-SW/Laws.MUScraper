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
  let browser = null;

  try {
    console.log("🚀 Starting Supreme Court judgment scraper");
    await fs.mkdir(DOWNLOAD_DIR, { recursive: true }).catch((e) => {
      console.error("❌ Failed to create downloads directory:", e.message);
      throw e;
    });

    console.log("📊 Launching browser...");
    browser = await chromium
      .launch({
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
      })
      .catch((e) => {
        console.error("❌ Failed to launch browser:", e.message);
        throw e;
      });

    console.log("🌐 Creating browser context...");
    const context = await browser
      .newContext({
        viewport: { width: 1920, height: 1080 },
        acceptDownloads: true,
        downloadsPath: DOWNLOAD_DIR,
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      })
      .catch((e) => {
        console.error("❌ Failed to create browser context:", e.message);
        throw e;
      });

    // block images/fonts/styles to speed up loading
    try {
      await context.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (["image", "stylesheet", "font"].includes(type))
          return route.abort();
        return route.continue();
      });
    } catch (e) {
      console.error("⚠️ Failed to set up resource blocking:", e.message);
      // Don't throw - this is non-critical
    }

    console.log("📝 Creating new page...");
    const page = await context.newPage().catch((e) => {
      console.error("❌ Failed to create new page:", e.message);
      throw e;
    });

    context.on("request", (req) => {
      try {
        console.debug(`>> ${req.method()} ${req.url().slice(0, 100)}...`);
      } catch (e) {
        console.error("⚠️ Error logging request:", e.message);
      }
    });

    context.on("requestfailed", (req) => {
      try {
        console.error(
          `❌ Failed request: ${req.url().slice(0, 100)} - ${
            req.failure()?.errorText
          }`
        );
      } catch (e) {
        console.error("⚠️ Error logging failed request:", e.message);
      }
    });

    console.log("🌐 Navigating to initial page...");
    await page
      .goto("https://supremecourt.govmu.org/judgment-search", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      })
      .catch((e) => {
        console.error("❌ Failed to navigate to initial page:", e.message);
        throw e;
      });

    const visited = new Set();
    const queue = [];
    let currentPage = 1;
    let totalFiles = 0;

    while (true) {
      try {
        console.log(`\n📄 Processing page ${currentPage}`);

        // discover new pages
        try {
          const pager = page.locator(
            "ul.pager__items.js-pager__items li.pager__item a"
          );
          const count = await pager.count();
          for (let i = 0; i < count; i++) {
            try {
              const anchor = pager.nth(i);
              const raw = await anchor.textContent();
              const pageNum = parseInt(raw.trim().split(/\s+/).pop(), 10);
              if (pageNum > currentPage && !visited.has(pageNum)) {
                visited.add(pageNum);
                queue.push(pageNum);
              }
            } catch (e) {
              console.error(
                `⚠️ Error processing pagination anchor ${i}:`,
                e.message
              );
            }
          }
        } catch (e) {
          console.error("❌ Error discovering pagination:", e.message);
          throw e;
        }

        // wait for table rows
        try {
          await page.waitForSelector("tbody tr", {
            state: "visible",
            timeout: 30000,
          });
        } catch (e) {
          console.error("❌ Table rows not found:", e.message);
          throw e;
        }

        try {
          const downloads = page.locator("div.nothingCell a.faDownload");
          const dcount = await downloads.count();
          console.log(`  Found ${dcount} files`);

          for (let i = 0; i < dcount; i++) {
            try {
              const link = downloads.nth(i);
              const row = link.locator("xpath=ancestor::tr");

              let caseNumber, caseTitle, judgmentDate;
              try {
                caseNumber = (
                  await row.locator("td").nth(0).textContent()
                ).trim();
                caseTitle = (
                  await row.locator("td").nth(1).textContent()
                ).trim();
                judgmentDate = await row
                  .locator("td.views-field-field-delivered-on a")
                  .textContent();
                judgmentDate = judgmentDate?.trim();
              } catch (e) {
                console.error(
                  `⚠️ Error extracting case details for row ${i}:`,
                  e.message
                );
                continue;
              }

              let formattedDate = null;
              try {
                if (judgmentDate?.includes("/")) {
                  const [day, month, year] = judgmentDate.split("/");
                  formattedDate = `${year}-${month.padStart(
                    2,
                    "0"
                  )}-${day.padStart(2, "0")}`;
                }
              } catch (e) {
                console.error(
                  `⚠️ Error formatting date "${judgmentDate}":`,
                  e.message
                );
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
                  console.log("  ⏳ Setting up download handler...");
                  const dlPromise = page.waitForEvent("download", {
                    timeout: 30000,
                  });

                  console.log("  🖱️ Clicking download link...");
                  await link.click();

                  console.log("  ⌛ Waiting for download...");
                  const download = await dlPromise;

                  console.log("  📥 Getting download path...");
                  filePath = await download.path();

                  console.log(`  ⬇️ saved ${download.suggestedFilename()}`);
                  success = true;

                  console.log("  📄 Extracting PDF content...");
                  const pdf = await extractPdfContent(
                    filePath,
                    TEXT_EXTRACT_LIMIT
                  );

                  console.log("  💾 Inserting into Supabase...");
                  const { data, error } = await supabase
                    .from("judgments")
                    .insert([
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

                  await fs.unlink(filePath).catch((e) => {
                    console.error(
                      "⚠️ Failed to delete temporary file:",
                      e.message
                    );
                  });
                } catch (e) {
                  retries++;
                  console.error(`  ⚠️ retry ${retries}:`, e.message);
                  if (e.stack) console.error("Stack trace:", e.stack);
                  await page.waitForTimeout(2000 * retries);
                }
              }
            } catch (e) {
              console.error(
                `❌ Fatal error processing download ${i}:`,
                e.message
              );
              if (e.stack) console.error("Stack trace:", e.stack);
            }
          }
        } catch (e) {
          console.error("❌ Error processing downloads on page:", e.message);
          if (e.stack) console.error("Stack trace:", e.stack);
          throw e;
        }

        if (!queue.length) break;
        currentPage = queue.shift();

        console.log(`🔄 Navigating to page ${currentPage}...`);
        try {
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
              { waitUntil: "domcontentloaded", timeout: 60000 }
            );
          });
        } catch (e) {
          console.error(
            `❌ Failed to navigate to page ${currentPage}:`,
            e.message
          );
          if (e.stack) console.error("Stack trace:", e.stack);
          throw e;
        }
      } catch (e) {
        console.error("❌ Fatal error in main loop:", e.message);
        if (e.stack) console.error("Stack trace:", e.stack);
        throw e;
      }
    }

    console.log(`\n✅ Done. Processed ${totalFiles}`);
  } catch (e) {
    console.error("❌ Fatal error in scrapeCourt:", e.message);
    if (e.stack) console.error("Stack trace:", e.stack);
    throw e;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error("⚠️ Error closing browser:", e.message);
      }
    }
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
