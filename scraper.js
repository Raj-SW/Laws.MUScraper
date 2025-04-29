const { chromium } = require("playwright");
const fs = require("fs").promises;
const path = require("path");
const pdfParse = require("pdf-parse"); // Add this dependency

/**
 * Supreme Court Judgment Scraper
 *
 * This script scrapes judgment files from the Supreme Court website by:
 * 1. Navigating through all pagination pages
 * 2. Downloading judgment files from each page
 * 3. Extracting content from downloaded PDF files
 * 4. Storing extracted data in a JSON file
 * 5. Cleaning up downloaded files
 */

async function scrapeCourt() {
  // Configuration
  const DOWNLOAD_DIR = path.join(__dirname, "downloads");
  const OUTPUT_FILE = path.join(__dirname, "judgments.json");
  const MAX_RETRIES = 3;
  const TEXT_EXTRACT_LIMIT = 10000; // Characters to extract from each PDF
  const judgmentData = [];

  console.log("🚀 Starting Supreme Court judgment scraper");

  // Ensure download directory exists
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
  console.log(`📁 Created download directory: ${DOWNLOAD_DIR}`);

  const browser = await chromium.launch({
    headless: true,
    slowMo: 50, // Reduced slowMo for better performance
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      acceptDownloads: true,
      downloadsPath: DOWNLOAD_DIR,
    });

    // Enable request/response logging for debugging
    context.on("request", (request) =>
      console.debug(`>> ${request.method()} ${request.url().slice(0, 100)}...`)
    );

    const page = await context.newPage();
    console.log("Navigating to judgment search page...");

    await page.goto("https://supremecourt.govmu.org/judgment-search", {
      waitUntil: "networkidle",
    });

    const visited = new Set();
    const queue = [];
    let currentPage = 1;
    let totalFilesProcessed = 0;
    const startTime = Date.now();

    while (true) {
      console.log(`\n📄 Processing page ${currentPage}`);

      try {
        // Extract all pagination links using locators
        const pagerLocator = page.locator(
          "ul.pager__items.js-pager__items li.pager__item a"
        );
        const count = await pagerLocator.count();

        for (let i = 0; i < count; i++) {
          const anchor = pagerLocator.nth(i);
          const href = await anchor.getAttribute("href");
          const raw = await anchor.textContent();
          const parts = raw.trim().split(/\s+/);
          const pageNum = parseInt(parts[parts.length - 1], 10);

          if (pageNum > currentPage && !visited.has(pageNum)) {
            visited.add(pageNum);
            queue.push({ page: pageNum, href });
            console.log(`  Discovered page ${pageNum}`);
          }
        }

        // If no more pages to visit, break the loop
        if (queue.length === 0) {
          console.log("No more pages to visit.");
          break;
        }

        // Wait for the table to render
        await page.waitForSelector("tbody tr", { state: "visible" });

        // Get all download links using locators
        const downloadLocator = page.locator("div.nothingCell a.faDownload");
        const downloadCount = await downloadLocator.count();
        console.log(`  Found ${downloadCount} files to download on this page.`);

        // Process each download
        for (let i = 0; i < downloadCount; i++) {
          const link = downloadLocator.nth(i);

          // Get metadata about the judgment from the row
          const row = link.locator("xpath=ancestor::tr");
          const caseNumber = await row
            .locator("td")
            .nth(0)
            .textContent()
            .catch(() => "Unknown");
          const caseTitle = await row
            .locator("td")
            .nth(1)
            .textContent()
            .catch(() => "Unknown");
          const judgmentDate = await row
            .locator("td")
            .nth(2)
            .textContent()
            .catch(() => "Unknown");

          console.log(
            `  🔍 Processing: ${caseNumber} - ${truncateString(caseTitle, 40)}`
          );

          let downloadSuccess = false;
          let retries = 0;
          let filePath = null;

          // Retry logic for downloads
          while (!downloadSuccess && retries < MAX_RETRIES) {
            try {
              // Start listening for the download
              const downloadPromise = page.waitForEvent("download", {
                timeout: 30000,
              });

              // Click the download link
              await link.click();

              // Wait for the download to start
              const download = await downloadPromise;
              const fileName = download.suggestedFilename();

              console.log(
                `  ⬇️ (${i + 1}/${downloadCount}) Downloading: ${fileName}`
              );

              // Wait for download to complete
              filePath = await download.path();

              console.log(`  ✅ Saved: ${fileName}`);
              downloadSuccess = true;

              // Process the downloaded file
              try {
                // Extract content from PDF
                const pdfContent = await extractPdfContent(
                  filePath,
                  TEXT_EXTRACT_LIMIT
                );

                // Store judgment data
                const judgmentRecord = {
                  caseNumber: caseNumber.trim(),
                  caseTitle: caseTitle.trim(),
                  judgmentDate: judgmentDate.trim(),
                  fileName,
                  content: pdfContent.text,
                  pageCount: pdfContent.pageCount,
                  metadata: pdfContent.metadata,
                  pageNumber: currentPage,
                  extractedAt: new Date().toISOString(),
                  downloadUrl: await link.getAttribute("href"),
                };

                judgmentData.push(judgmentRecord);
                totalFilesProcessed++;

                // Save data after each successful extraction to prevent data loss
                await fs.writeFile(
                  OUTPUT_FILE,
                  JSON.stringify(judgmentData, null, 2)
                );
                console.log(
                  `  💾 Updated JSON with ${judgmentData.length} records`
                );

                // Clean up the downloaded file
                await fs.unlink(filePath);
                console.log(`  🗑️ Deleted temporary file: ${fileName}`);
              } catch (fileError) {
                console.error(
                  `  ❌ Error processing file: ${fileError.message}`
                );
              }
            } catch (downloadError) {
              retries++;
              console.error(
                `  ⚠️ Download attempt ${retries}/${MAX_RETRIES} failed: ${downloadError.message}`
              );

              // Wait before retrying
              await page.waitForTimeout(2000 * retries);
            }
          }

          if (!downloadSuccess) {
            console.error(
              `  ❌ Failed to download file after ${MAX_RETRIES} attempts`
            );
          }

          // Small pause between downloads to avoid overwhelming the server
          await page.waitForTimeout(500);
        }

        // Navigate to the next page
        const { page: nextPage, href } = queue.shift();
        currentPage = nextPage;
        console.log(`→ Navigating to page ${nextPage}`);

        // Use Promise.all to wait for navigation
        try {
          await Promise.all([
            page.waitForNavigation({ waitUntil: "networkidle" }),
            page
              .locator(
                `ul.pager__items.js-pager__items li.pager__item a[href*="page=${nextPage}"]`
              )
              .click(),
          ]);
        } catch (navError) {
          console.error(`❌ Navigation error: ${navError.message}`);
          console.log(`Attempting direct navigation to page ${nextPage}...`);

          // Fallback: direct URL navigation
          await page.goto(
            `https://supremecourt.govmu.org/judgment-search?page=${nextPage}`,
            { waitUntil: "networkidle" }
          );
        }

        // Wait for page to be fully loaded
        await page.waitForLoadState("domcontentloaded");
        await page.waitForLoadState("networkidle");
      } catch (pageError) {
        console.error(
          `❌ Error processing page ${currentPage}: ${pageError.message}`
        );

        // If there are more pages in the queue, try the next one
        if (queue.length > 0) {
          const { page: nextPage } = queue.shift();
          currentPage = nextPage;

          // Try to navigate to the next page
          try {
            await page.goto(
              `https://supremecourt.govmu.org/judgment-search?page=${currentPage}`,
              {
                waitUntil: "networkidle",
              }
            );
          } catch (navError) {
            console.error(
              `❌ Failed to navigate to page ${currentPage}: ${navError.message}`
            );
            break;
          }
        } else {
          break;
        }
      }
    }

    // Final save of all judgment data to a JSON file
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(judgmentData, null, 2));
    console.log(
      `\n✅ Scraping complete! Processed ${totalFilesProcessed} files.`
    );
    console.log(`✅ Data saved to ${OUTPUT_FILE}`);
    console.log(
      `✅ All discovered pages: ${Array.from(visited)
        .sort((a, b) => a - b)
        .join(", ")}`
    );
  } catch (error) {
    console.error(`❌ Fatal error: ${error.message}`);
    console.error(error.stack);
  } finally {
    await browser.close();
    console.log("Browser closed.");
  }
}

/**
 * Extract content from a PDF file
 * @param {string} filePath - Path to the PDF file
 * @param {number} charLimit - Maximum number of characters to extract
 * @returns {Object} - Object containing extracted text and metadata
 */
async function extractPdfContent(filePath, charLimit = 10000) {
  try {
    // Read the PDF file
    const dataBuffer = await fs.readFile(filePath);

    // Parse the PDF
    const data = await pdfParse(dataBuffer);

    // Extract text (limited to charLimit)
    const text = data.text.slice(0, charLimit);

    console.log(
      `  📄 Extracted ${text.length} characters from ${data.numpages} pages`
    );

    // Return text and metadata
    return {
      text,
      pageCount: data.numpages,
      metadata: {
        info: data.info,
        version: data.version,
        encrypted: data.encrypted,
      },
    };
  } catch (error) {
    console.error(`Error parsing PDF: ${error.message}`);
    return {
      text: `Error extracting PDF content: ${error.message}`,
      pageCount: 0,
      metadata: {},
    };
  }
}

/**
 * Truncate a string to a maximum length and add ellipsis if needed
 * @param {string} str - String to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated string
 */
function truncateString(str, maxLength) {
  return str.length > maxLength ? str.substring(0, maxLength) + "..." : str;
}

// Run the scraper
scrapeCourt().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
