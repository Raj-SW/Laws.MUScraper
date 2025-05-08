// // scraper.js
// require("dotenv").config();
// const { chromium } = require("playwright");
// const fs = require("fs").promises;
// const path = require("path");
// const pdfParse = require("pdf-parse");
// const { createClient } = require("@supabase/supabase-js");

// // initialize Supabase client
// const supabase = createClient(
//   process.env.SUPABASE_URL,
//   process.env.SUPABASE_SERVICE_ROLE_KEY
// );

// async function scrapeCourt() {
//   const DOWNLOAD_DIR = path.join(__dirname, "downloads");
//   const MAX_RETRIES = 3;
//   const TEXT_EXTRACT_LIMIT = 10000;
//   let browser = null;

//   try {
//     console.log("🚀 Starting Supreme Court judgment scraper");
//     await fs.mkdir(DOWNLOAD_DIR, { recursive: true }).catch((e) => {
//       console.error("❌ Failed to create downloads directory:", e);
//       throw e;
//     });

//     console.log("📊 Launching browser...");
//     browser = await chromium
//       .launch({
//         headless: true,
//       })
//       .catch((e) => {
//         console.error("❌ Failed to launch browser:", e);
//         throw e;
//       });

//     console.log("🌐 Creating browser context...");
//     const context = await browser
//       .newContext({
//         viewport: { width: 1920, height: 1080 },
//         acceptDownloads: true,
//         downloadsPath: DOWNLOAD_DIR,
//       })
//       .catch((e) => {
//         console.error("❌ Failed to create browser context:", e);
//         throw e;
//       });

//     console.log("📝 Creating new page...");
//     const page = await context.newPage().catch((e) => {
//       console.error("❌ Failed to create new page:", e);
//       throw e;
//     });
//     await page.goto("https://supremecourt.govmu.org/judgment-search", {
//       waitUntil: "networkidle",
//     });

//     const visited = new Set();
//     const queue = [];
//     let currentPage = 1;
//     let totalFiles = 0;

//     while (true) {
//       try {
//         console.log(`\n📄 Processing page ${currentPage}`);

//         // discover new pages
//         try {
//           const pager = page.locator(
//             "ul.pager__items.js-pager__items li.pager__item a"
//           );
//           const count = await pager.count();
//           for (let i = 0; i < count; i++) {
//             try {
//               const anchor = pager.nth(i);
//               const raw = await anchor.textContent();
//               const pageNum = parseInt(raw.trim().split(/\s+/).pop(), 10);
//               if (pageNum > currentPage && !visited.has(pageNum)) {
//                 visited.add(pageNum);
//                 queue.push(pageNum);
//               }
//             } catch (e) {
//               console.error(`⚠️ Error processing pagination anchor ${i}:`, e);
//             }
//           }
//         } catch (e) {
//           console.error("❌ Error discovering pagination:", e);
//           throw e;
//         }

//         // wait for table rows
//         try {
//           await page.waitForSelector("tbody tr", {
//             state: "visible",
//             timeout: 30000,
//           });
//         } catch (e) {
//           console.error("❌ Table rows not found:", e);
//           throw e;
//         }

//         try {
//           const downloads = page.locator("div.nothingCell a.faDownload");
//           const dcount = await downloads.count();
//           console.log(`  Found ${dcount} files`);

//           for (let i = 0; i < dcount; i++) {
//             try {
//               const link = downloads.nth(i);
//               const row = link.locator("xpath=ancestor::tr");

//               let caseNumber, caseTitle, judgmentDate;
//               try {
//                 caseNumber = (
//                   await row.locator("td").nth(0).textContent()
//                 ).trim();
//                 caseTitle = (
//                   await row.locator("td").nth(1).textContent()
//                 ).trim();
//                 judgmentDate = await row
//                   .locator("td.views-field-field-delivered-on a")
//                   .textContent();
//                 judgmentDate = judgmentDate?.trim();
//               } catch (e) {
//                 console.error(
//                   `⚠️ Error extracting case details for row ${i}:`,
//                   e.message
//                 );
//                 continue;
//               }

//               let formattedDate = null;
//               try {
//                 if (judgmentDate?.includes("/")) {
//                   const [day, month, year] = judgmentDate.split("/");
//                   formattedDate = `${year}-${month.padStart(
//                     2,
//                     "0"
//                   )}-${day.padStart(2, "0")}`;
//                 }
//               } catch (e) {
//                 console.error(
//                   `⚠️ Error formatting date "${judgmentDate}":`,
//                   e.message
//                 );
//               }

//               if (!formattedDate) {
//                 console.warn(
//                   `⚠️ Skipping ${caseNumber} - bad date: "${judgmentDate}"`
//                 );
//                 continue;
//               }

//               console.log(`  🔍 ${caseNumber} - ${caseTitle}`);
//               let success = false,
//                 retries = 0,
//                 filePath;

//               while (!success && retries < MAX_RETRIES) {
//                 try {
//                   console.log("  ⏳ Setting up download handler...");
//                   const dlPromise = page.waitForEvent("download", {
//                     timeout: 30000,
//                   });

//                   console.log("  🖱️ Clicking download link...");
//                   await link.click();

//                   console.log("  ⌛ Waiting for download...");
//                   const download = await dlPromise;

//                   console.log("  📥 Getting download path...");
//                   filePath = await download.path();

//                   console.log(`  ⬇️ saved ${download.suggestedFilename()}`);
//                   success = true;

//                   console.log("  📄 Extracting PDF content...");
//                   const pdf = await extractPdfContent(
//                     filePath,
//                     TEXT_EXTRACT_LIMIT
//                   );

//                   console.log("  💾 Inserting into Supabase...");
//                   const { data, error } = await supabase
//                     .from("judgments")
//                     .insert([
//                       {
//                         case_number: caseNumber,
//                         case_title: caseTitle,
//                         judgment_date: formattedDate,
//                         file_name: download.suggestedFilename(),
//                         content: pdf.text,
//                         page_count: pdf.pageCount,
//                         metadata: pdf.metadata,
//                         page_number: currentPage,
//                         extracted_at: new Date().toISOString(),
//                         download_url: await link.getAttribute("href"),
//                       },
//                     ]);

//                   if (error) {
//                     console.error("Supabase error:", error);
//                   } else {
//                     console.log(`  ✅ inserted id ${data[0].id}`);
//                   }

//                   await fs.unlink(filePath).catch((e) => {
//                     console.error("⚠️ Failed to delete temporary file:", e);
//                   });
//                 } catch (e) {
//                   retries++;
//                   console.error(`  ⚠️ retry ${retries}:`, e);
//                   if (e) console.error("Stack trace:", e);
//                   await page.waitForTimeout(2000 * retries);
//                 }
//               }
//             } catch (e) {
//               console.error(`❌ Fatal error processing download ${i}:`, e);
//               if (e) console.error("Stack trace:", e);
//             }
//           }
//         } catch (e) {
//           console.error("❌ Error processing downloads on page:", e);
//           if (e) console.error("Stack trace:", e);
//           throw e;
//         }

//         if (!queue.length) break;
//         currentPage = queue.shift();

//         console.log(`🔄 Navigating to page ${currentPage}...`);
//         try {
//           await Promise.all([
//             page.waitForNavigation({
//               waitUntil: "domcontentloaded",
//               timeout: 60000,
//             }),
//             page.click(
//               `ul.pager__items.js-pager__items li.pager__item a[href*="page=${currentPage}"]`
//             ),
//           ]).catch(async () => {
//             console.log("⚠️ Navigation failed, trying direct URL...");
//             await page.goto(
//               `https://supremecourt.govmu.org/judgment-search?page=${currentPage}`,
//               { waitUntil: "domcontentloaded", timeout: 60000 }
//             );
//           });
//         } catch (e) {
//           console.error(`❌ Failed to navigate to page ${currentPage}:`, e);
//           if (e) console.error("Stack trace:", e);
//           throw e;
//         }
//       } catch (e) {
//         console.error("❌ Fatal error in main loop:", e);
//         if (e) console.error("Stack trace:", e);
//         throw e;
//       }
//     }

//     console.log(`\n✅ Done. Processed ${totalFiles}`);
//   } catch (e) {
//     console.error("❌ Fatal error in scrapeCourt:", e);
//     if (e) console.error("Stack trace:", e);
//     throw e;
//   } finally {
//     if (browser) {
//       try {
//         await browser.close();
//       } catch (e) {
//         console.error("⚠️ Error closing browser:", e);
//       }
//     }
//   }
// }

// async function extractPdfContent(filePath, limit) {
//   const buf = await fs.readFile(filePath);
//   const data = await pdfParse(buf);
//   return {
//     text: data.text.slice(0, limit),
//     pageCount: data.numpages,
//     metadata: {
//       info: data.info,
//       version: data.version,
//       encrypted: data.encrypted,
//     },
//   };
// }

// scrapeCourt().catch((e) => {
//   console.error(e);
//   process.exit(1);
// });

//--------------------------------------------------------------------------
// import { chromium } from "playwright";

// (async () => {
//   // 1. Launch browser (set headless: false if you want to see the UI)
//   const browser = await chromium.launch({
//     headless: true,
//     args: ["--no-sandbox", "--disable-setuid-sandbox"],
//   });
//   // 2. Create a new browser context (incognito-like session)
//   const context = await browser.newContext({
//     // you can set viewport, userAgent, locale, etc. here
//   });

//   // 3. Open a new page
//   const page = await context.newPage();

//   try {
//     // 4. Navigate to the target URL
//     await page.goto("https://supremecourt.govmu.org/judgment-search", {
//       waitUntil: "domcontentloaded", // wait until DOMContentLoaded event
//       timeout: 60000, // 60 seconds timeout
//     });
//     console.log("✅ Navigation succeeded");
//   } catch (err) {
//     console.error("❌ Navigation failed:", err);
//   } finally {

//   // 5. Close browser
//   await browser.close();
// }
// })();
//--------------------------------------------------------------------------
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
    headless: false,
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
